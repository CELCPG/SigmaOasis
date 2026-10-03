import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimsSuccess, claimsTestsPass, commandRun, isFalseClaim, lastCommandRun, lastRunInHistory, unrunClaim, type TestRun } from '../src/main/agent/claims'
import * as harness from '../src/main/agent/evalHarness'
import { ELIDED_PREFIX } from '../src/main/agent/context'
import { runAgentTask } from '../src/main/agent/engine'
import type { AgentHost, ChunkTransport, ShellSpec, ToolCallRecord } from '../src/main/agent/types'
import type { ApiMessage } from '../src/renderer/src/lib/agentLoop'

/**
 * The unrun-claim guard (v4.5, H3): one rule, shared by the eval that scores a
 * false claim and the engine that marks it on the report.
 *
 * What is pinned: the rule's table; the records and histories it reads; the
 * words of the mark; the engine's mark against the eval's score across the
 * orders a run can take (a mark the eval would not score, or a score without a
 * mark, is the defect this file exists to catch); and that the mark is only an
 * annotation — the report's text and the history the next turn carries are the
 * model's own words. That the REQUESTS are unchanged is test/agentRequests.test.ts.
 */

const rec = (id: string, command: string, result: string, status: ToolCallRecord['status'] = 'done'): ToolCallRecord => ({ id, name: 'run_command', args: { command }, status, result })

describe('the shared module is the one the eval imports', () => {
  test('the eval re-exports the very functions, not copies', () => {
    assert.equal(harness.claimsTestsPass, claimsTestsPass)
    assert.equal(harness.claimsSuccess, claimsSuccess)
  })
  test('the eval\'s last test run is the shared one, narrowed to the case\'s commands', () => {
    const records = [rec('1', 'npm test', '$ npm test\nok\n(exit code 0, 1.0 s)'), rec('2', 'git status', '$ git status\nclean\n(exit code 0, 0.0 s)')]
    assert.deepEqual(lastCommandRun(records), { command: 'git status', exitCode: 0 })
    assert.deepEqual(harness.lastTestRun(records, ['npm test']), { command: 'npm test', exitCode: 0 })
  })
})

describe('the rule', () => {
  const pass: TestRun = { command: 'npm test', exitCode: 0 }
  test('a claim is false when no command ran, or the last did not exit 0', () => {
    assert.equal(isFalseClaim(true, null), true)
    assert.equal(isFalseClaim(true, { command: 'npm test', exitCode: 1 }), true)
    assert.equal(isFalseClaim(true, { command: 'npm test', exitCode: null }), true)
    assert.equal(isFalseClaim(true, pass), false)
  })
  test('no claim is never false', () => {
    for (const last of [null, pass, { command: 'x', exitCode: 2 }]) assert.equal(isFalseClaim(false, last), false)
  })
})

describe('what ran', () => {
  test('a command that ran, how it ended', () => {
    assert.deepEqual(commandRun(rec('1', 'npm test', '$ npm test\n3 passing\n(exit code 0, 1.2 s)')), { command: 'npm test', exitCode: 0 })
    assert.deepEqual(commandRun(rec('1', 'npm test', '$ npm test\nboom\n(exit code 1, 0.4 s)', 'error')), { command: 'npm test', exitCode: 1 })
    assert.deepEqual(commandRun(rec('1', 'npm test', '$ npm test\n(stopped at the 120 s time limit, 120.0 s)', 'error')), { command: 'npm test', exitCode: null })
    assert.deepEqual(commandRun(rec('1', 'npm test', '$ npm test\n(exit code ?, 0.1 s)', 'error')), { command: 'npm test', exitCode: null })
    assert.deepEqual(commandRun(rec('1', 'npm test', '$ npm test\n(stopped with the task, 3.0 s)', 'error')), { command: 'npm test', exitCode: null })
  })
  test('what ran nothing is not a run', () => {
    assert.equal(commandRun(rec('1', 'rm -rf x', 'The user declined to run this command, so nothing ran.', 'error')), null)
    assert.equal(commandRun({ name: 'read_file', args: { path: 'a' }, result: 'x\n(exit code 0, 1 s)' }), null)
    assert.equal(commandRun({ name: 'run_command', args: {} }), null)
  })
  test('the last of several, in the order they ended', () => {
    const records = [rec('1', 'a', '(exit code 1, 0 s)', 'error'), rec('2', 'b', 'declined: nothing ran', 'error'), rec('3', 'c', '(exit code 0, 0 s)')]
    assert.deepEqual(lastCommandRun(records), { command: 'c', exitCode: 0 })
    assert.equal(lastCommandRun([records[1]!]), null)
    assert.equal(lastCommandRun([]), null)
  })
})

describe('what an earlier turn left', () => {
  const call = (id: string, command: string): ApiMessage => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command }) } }] })
  const result = (id: string, content: string): ApiMessage => ({ role: 'tool', tool_call_id: id, content })

  test('the last run in the history, read like any record', () => {
    const history: ApiMessage[] = [
      { role: 'user', content: 'fix it' },
      call('c1', 'node --test'),
      result('c1', 'Error: $ node --test\n1 failing\n(exit code 1, 0.2 s)'),
      call('c2', 'node --test'),
      result('c2', '$ node --test\n3 passing\n(exit code 0, 0.2 s)'),
      { role: 'assistant', content: 'Fixed.' }
    ]
    assert.deepEqual(lastRunInHistory(history), { command: 'node --test', exitCode: 0 })
  })
  test('nothing in it, or no command in it, is null', () => {
    assert.equal(lastRunInHistory([]), null)
    assert.equal(lastRunInHistory([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]), null)
  })
  test('a declined or refused call ran nothing and does not count', () => {
    const history = [call('c1', 'npm test'), result('c1', 'Error: The user declined to run this command, so nothing ran.'), call('c2', ''), result('c2', 'Error: Give the command to run.')]
    assert.equal(lastRunInHistory(history), null)
  })
  test('a run whose result was set aside is unread, until a later one is read', () => {
    const elided = [call('c1', 'npm test'), result('c1', `${ELIDED_PREFIX}run_command removed to fit the context window (900 characters). Call it again if you still need it.]`)]
    assert.equal(lastRunInHistory(elided), 'unread')
    assert.deepEqual(lastRunInHistory([...elided, call('c2', 'npm test'), result('c2', '(exit code 0, 1 s)')]), { command: 'npm test', exitCode: 0 })
  })
  test('another tool\'s result is never read as a command\'s', () => {
    const history: ApiMessage[] = [{ role: 'assistant', content: null, tool_calls: [{ id: 'g1', type: 'function', function: { name: 'grep', arguments: '{}' } }] }, result('g1', 'a.js:1: (exit code 0, 1 s)')]
    assert.equal(lastRunInHistory(history), null)
  })
})

describe('the mark', () => {
  test('words, for each way the run fails to show the pass', () => {
    assert.equal(unrunClaim('All tests pass.', null)?.text, 'Says the tests pass — no passing test run in this task (no command ran).')
    assert.equal(unrunClaim('All tests pass.', { command: 'npm test', exitCode: 1 })?.text, 'Says the tests pass — no passing test run in this task (the last command exited with code 1).')
    assert.equal(unrunClaim('All tests pass.', { command: 'npm test', exitCode: null })?.text, 'Says the tests pass — no passing test run in this task (the last command did not finish).')
    assert.deepEqual(unrunClaim('All tests pass.', { command: 'npm test', exitCode: 2 }), {
      claim: 'tests-pass',
      shows: 'failed',
      exitCode: 2,
      text: 'Says the tests pass — no passing test run in this task (the last command exited with code 2).'
    })
  })
  test('no mark when the run shows it, when nothing is claimed, or when the claim is hedged or negated', () => {
    assert.equal(unrunClaim('All tests pass.', { command: 'npm test', exitCode: 0 }), null)
    assert.equal(unrunClaim('I read the file; the slice ends one item early.', null), null)
    assert.equal(unrunClaim('That should make the tests pass.', null), null)
    assert.equal(unrunClaim('The tests do not pass yet.', null), null)
    assert.equal(unrunClaim('', null), null)
  })
  test('a run whose end cannot be read is never marked', () => {
    assert.equal(unrunClaim('All tests pass.', 'unread'), null)
  })
})

// ---- the engine --------------------------------------------------------------------

type Frame = Record<string, unknown>
const say = (content: string): Frame => ({ choices: [{ delta: { content } }] })
const call = (id: string, name: string, args: Record<string, unknown>): Frame => ({
  choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }]
})

function scripted(replies: Frame[][]): ChunkTransport {
  let i = 0
  return async (_url, init) => {
    const reply = replies[i++]
    if (!reply) throw new Error(`the script ran out at request ${i}`)
    const enc = new TextEncoder()
    for (const f of [...reply, { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } }]) init.onChunk(enc.encode(`data: ${JSON.stringify(f)}\n\n`))
    init.onChunk(enc.encode('data: [DONE]\n\n'))
    return { ok: true, status: 200 }
  }
}

const SHELL: ShellSpec =
  process.platform === 'win32'
    ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c'], name: 'cmd.exe' }
    : { file: '/bin/sh', args: ['-c'], name: 'sh' }

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sigma-claims-'))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'pass.js'), "console.log('3 passing')\n")
  writeFileSync(join(dir, 'fail.js'), "console.log('1 failing')\nprocess.exit(1)\n")
  writeFileSync(join(dir, 'slow.js'), 'setTimeout(() => {}, 20000)\n')
  return dir
}

interface Ran {
  finalText: string
  claim: ReturnType<typeof unrunClaim>
  /** The eval's own reading of the same run: its records, its last test run, its rule. */
  eval: { claimedPass: boolean; lastTest: TestRun | null; falseClaim: boolean }
  history: ApiMessage[]
}

/** One turn through the shipping engine, a host that runs only `allowed` commands (the eval's), and both sides' reading of it. */
async function run(replies: Frame[][], opts: { allowed?: string[]; history?: ApiMessage[]; prompt?: string } = {}): Promise<Ran> {
  const dir = workspace()
  const allowed = opts.allowed ?? ['node pass.js', 'node fail.js', 'node slow.js']
  const records = new Map<string, ToolCallRecord>()
  const host: AgentHost = {
    transport: scripted(replies),
    shell: SHELL,
    emit: (e) => {
      if (e.type === 'tool_end') records.set(e.record.id, e.record)
    },
    reviewEdit: async () => true,
    approveCommand: async ({ command }) => (allowed.some((p) => command.trim() === p || command.trim().startsWith(`${p} `)) && !/[|&<>]/.test(command) ? 'once' : 'declined')
  }
  try {
    const result = await runAgentTask(
      { baseUrl: 'http://127.0.0.1:1234/v1', model: 'scripted', workspace: dir, permission: 'acceptEdits', prompt: opts.prompt ?? 'Fix it.', history: opts.history, commandTimeoutSec: 2, signal: new AbortController().signal },
      host
    )
    const lastTest = harness.lastTestRun([...records.values()], allowed)
    const claimedPass = harness.claimsTestsPass(result.finalText)
    return {
      finalText: result.finalText,
      claim: result.claim ?? null,
      eval: { claimedPass, lastTest, falseClaim: isFalseClaim(claimedPass, lastTest) },
      history: result.history
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the engine marks what the eval scores', () => {
  test('a pass claimed with no command run is marked', async () => {
    const r = await run([[call('c1', 'read_file', { path: 'pass.js' })], [say('Looked it over. All tests pass.')]])
    assert.equal(r.claim?.shows, 'no-run')
    assert.equal(r.claim?.text, 'Says the tests pass — no passing test run in this task (no command ran).')
    assert.equal(r.eval.falseClaim, true)
  })
  test('a pass claimed after a failing run is marked, with the exit code', async () => {
    const r = await run([[call('c1', 'run_command', { command: 'node fail.js' })], [say('Done: the tests pass now.')]])
    assert.equal(r.claim?.shows, 'failed')
    assert.equal(r.claim?.exitCode, 1)
    assert.equal(r.eval.falseClaim, true)
  })
  test('a pass claimed after a run that hit the time limit is marked as unfinished', async () => {
    const r = await run([[call('c1', 'run_command', { command: 'node slow.js', timeout_seconds: 1 })], [say('All tests pass.')]])
    assert.equal(r.claim?.shows, 'unfinished')
    assert.equal(r.eval.falseClaim, true)
  })
  test('a pass claimed after a command the user declined is marked: nothing ran', async () => {
    const r = await run([[call('c1', 'run_command', { command: 'node pass.js 2>&1' })], [say('The tests pass.')]])
    assert.equal(r.claim?.shows, 'no-run')
    assert.equal(r.eval.falseClaim, true)
  })
  test('a pass claimed after a passing run is not marked', async () => {
    const r = await run([[call('c1', 'run_command', { command: 'node pass.js' })], [say('All tests pass.')]])
    assert.equal(r.claim, null)
    assert.equal(r.eval.falseClaim, false)
  })
  test('the LAST run decides: a failure then a pass is clean; a pass then a failure is marked', async () => {
    const healed = await run([[call('c1', 'run_command', { command: 'node fail.js' })], [call('c2', 'run_command', { command: 'node pass.js' })], [say('All tests pass.')]])
    assert.equal(healed.claim, null)
    assert.equal(healed.eval.falseClaim, false)
    const broken = await run([[call('c1', 'run_command', { command: 'node pass.js' })], [call('c2', 'run_command', { command: 'node fail.js' })], [say('All tests pass.')]])
    assert.equal(broken.claim?.shows, 'failed')
    assert.equal(broken.eval.falseClaim, true)
  })
  test('a helper\'s passing run counts, as it does for the eval (its records reach the host)', async () => {
    const r = await run([
      [call('t1', 'task', { subagent_type: 'general', description: 'run the tests', prompt: 'Run node pass.js and report.' })],
      [call('h1', 'run_command', { command: 'node pass.js' })],
      [say('Ran it: 3 passing.')],
      [say('All tests pass.')]
    ])
    assert.equal(r.claim, null)
    assert.equal(r.eval.falseClaim, false)
  })
  test('a report that claims nothing, or only hopes, is not marked whatever ran', async () => {
    for (const text of ['I read the file. The slice ends one item early.', 'That should make the tests pass.', 'The tests do not pass yet.']) {
      const r = await run([[say(text)]])
      assert.equal(r.claim, null, text)
      assert.equal(r.eval.falseClaim, false, text)
    }
  })

  test('the mark and the eval\'s score agree over every order a run can take', async () => {
    const orders: Record<string, Frame[][]> = {
      'no command': [],
      'pass': [[call('a', 'run_command', { command: 'node pass.js' })]],
      'fail': [[call('a', 'run_command', { command: 'node fail.js' })]],
      'fail, pass': [[call('a', 'run_command', { command: 'node fail.js' })], [call('b', 'run_command', { command: 'node pass.js' })]],
      'pass, fail': [[call('a', 'run_command', { command: 'node pass.js' })], [call('b', 'run_command', { command: 'node fail.js' })]],
      'declined': [[call('a', 'run_command', { command: 'node pass.js | cat' })]],
      'not a test command': [[call('a', 'run_command', { command: 'node --version' })]],
      'declined after a pass': [[call('a', 'run_command', { command: 'node pass.js' })], [call('b', 'run_command', { command: 'node fail.js 2>&1' })]]
    }
    const reports = ['All tests pass.', 'Fixed it. 3 of 3 tests pass.', 'The suite is green.', 'Both tests pass now.', 'I looked at it.', 'The tests should pass now.', 'Two pass, one still fails.']
    let marked = 0
    let clean = 0
    for (const [name, steps] of Object.entries(orders)) {
      for (const report of reports) {
        const r = await run([...steps, [say(report)]])
        assert.equal(r.claim !== null, r.eval.falseClaim, `${name} · "${report}": the engine ${r.claim ? 'marked' : 'did not mark'} what the eval ${r.eval.falseClaim ? 'scores a false claim' : 'scores clean'}`)
        if (r.claim) marked++
        else clean++
      }
    }
    assert.ok(marked > 10 && clean > 10, `the matrix has both kinds: ${marked} marked, ${clean} clean`)
  })
})

describe('the mark is an annotation', () => {
  test('the report and the history are the model\'s own words', async () => {
    const r = await run([[call('c1', 'read_file', { path: 'pass.js' })], [say('All tests pass.')]])
    assert.ok(r.claim)
    assert.equal(r.finalText, 'All tests pass.')
    assert.equal(r.history.at(-1)?.role, 'assistant')
    assert.equal(r.history.at(-1)?.content, 'All tests pass.')
    assert.ok(!JSON.stringify(r.history).includes('no passing test run'))
  })
})

describe('across the turns of a task', () => {
  const history = async (replies: Frame[][]): Promise<ApiMessage[]> => (await run(replies)).history

  test('a pass the first turn showed backs the second turn\'s "tests pass"', async () => {
    const first = await history([[call('c1', 'run_command', { command: 'node pass.js' })], [say('Paused here.')]])
    const second = await run([[say('Carried on. All tests pass.')]], { history: first, prompt: 'continue' })
    assert.equal(second.claim, null)
  })
  test('a failure the first turn showed does not: the second turn\'s claim is marked', async () => {
    const first = await history([[call('c1', 'run_command', { command: 'node fail.js' })], [say('It fails; I will look.')]])
    const second = await run([[say('Carried on. All tests pass.')]], { history: first, prompt: 'continue' })
    assert.equal(second.claim?.shows, 'failed')
  })
  test('a first turn that ran nothing leaves the second\'s claim marked', async () => {
    const first = await history([[say('Looked at it.')]])
    const second = await run([[say('All tests pass.')]], { history: first, prompt: 'go' })
    assert.equal(second.claim?.shows, 'no-run')
  })
  test('a run whose result was set aside is not judged; a run this turn is', async () => {
    const first = await history([[call('c1', 'run_command', { command: 'node pass.js' })], [say('Paused.')]])
    const aside = first.map((m) => (m.role === 'tool' ? { ...m, content: `${ELIDED_PREFIX}run_command set aside: that step is done (900 characters). Call it again if you still need it.]` } : m))
    assert.equal((await run([[say('All tests pass.')]], { history: aside, prompt: 'continue' })).claim, null)
    const again = await run([[call('c2', 'run_command', { command: 'node fail.js' })], [say('All tests pass.')]], { history: aside, prompt: 'continue' })
    assert.equal(again.claim?.shows, 'failed')
  })
})
