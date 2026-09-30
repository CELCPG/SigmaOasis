import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgentTask } from '../src/main/agent/engine'
import { applyEdit } from '../src/main/agent/editMatch'
import { fitContext, DROPPED_NOTE, estimateTokens, historyBudget, LOW_WATER } from '../src/main/agent/context'
import { capResult, readSpill, resultCapChars, SpillStore } from '../src/main/agent/spill'
import { agentSystemPrompt, loadProjectNotes } from '../src/main/agent/prompts'
import { Toolbox, newTaskState, workspaceToolSchemas } from '../src/main/agent/tools'
import { globToRegExp, resolveInside, WorkspaceError } from '../src/main/agent/workspace'
import { dangerousCommandWarning } from '../src/shared/commandDanger'
import { restoreCheckpoints } from '../src/main/agent/checkpoints'
import { sheetsToXlsx, xlsxToSheets } from '../src/main/agent/documents'
import type { AgentEvent, AgentHost, ChunkTransport, EditReview, ShellSpec } from '../src/main/agent/types'
import type { ApiMessage } from '../src/renderer/src/lib/agentLoop'

/**
 * The agent engine (v3.0), end to end against a scripted model.
 *
 * The transport below plays LM Studio: each request gets the next scripted
 * reply, streamed as the SSE frames the real server sends. Everything else is
 * the shipping code — the chat's loop, the stream parser, the toolbox on a
 * real temporary folder, the helpers, context fitting — so what passes here
 * is the engine the app and the CLI both run.
 */

type Frame = Record<string, unknown>
type Reply = (body: { messages: ApiMessage[]; tools?: { function: { name: string } }[] }) => Frame[]

const text = (content: string): Frame => ({ choices: [{ delta: { content } }] })
const call = (id: string, name: string, args: Record<string, unknown>): Frame => ({
  choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }]
})
const usage = (completion: number): Frame => ({ choices: [], usage: { prompt_tokens: 100, completion_tokens: completion } })

function scripted(replies: Reply[]): { transport: ChunkTransport; requests: { messages: ApiMessage[]; tools: string[] }[] } {
  const requests: { messages: ApiMessage[]; tools: string[] }[] = []
  let i = 0
  const transport: ChunkTransport = async (_url, init) => {
    const body = JSON.parse(init.body) as { messages: ApiMessage[]; tools?: { function: { name: string } }[] }
    requests.push({ messages: JSON.parse(JSON.stringify(body.messages)), tools: (body.tools ?? []).map((t) => t.function.name) })
    const reply = replies[i++]
    if (!reply) throw new Error(`the script ran out at request ${i}`)
    const enc = new TextEncoder()
    for (const f of [...reply(body), usage(10)]) init.onChunk(enc.encode(`data: ${JSON.stringify(f)}\n\n`))
    init.onChunk(enc.encode('data: [DONE]\n\n'))
    return { ok: true, status: 200 }
  }
  return { transport, requests }
}

const NODE_SHELL: ShellSpec =
  process.platform === 'win32'
    ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c'], name: 'cmd.exe' }
    : { file: '/bin/sh', args: ['-c'], name: 'sh' }

function host(transport: ChunkTransport, over: Partial<AgentHost> = {}): { host: AgentHost; events: AgentEvent[]; reviews: EditReview[]; commands: string[] } {
  const events: AgentEvent[] = []
  const reviews: EditReview[] = []
  const commands: string[] = []
  return {
    events,
    reviews,
    commands,
    host: {
      transport,
      shell: NODE_SHELL,
      emit: (e) => events.push(e),
      reviewEdit: async (r) => {
        reviews.push(r)
        return true
      },
      approveCommand: async ({ command }) => {
        commands.push(command)
        return 'once'
      },
      ...over
    }
  }
}

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sigma-agent-'))
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(dir, 'src', 'math.ts'), 'export function add(a: number, b: number) {\n  return a - b\n}\n')
  writeFileSync(join(dir, 'src', 'math.test.ts'), "import { add } from './math'\n")
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.ts'), 'export const add = 1\n')
  writeFileSync(join(dir, 'README.md'), '# demo\n')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const spec = (transport: ChunkTransport, over: Record<string, unknown> = {}) => ({
  baseUrl: 'http://127.0.0.1:1234/v1',
  model: 'test-model',
  workspace: dir,
  permission: 'ask' as const,
  prompt: 'Fix add() so the tests pass.',
  signal: new AbortController().signal,
  ...over
})

describe('a task, start to finish', () => {
  test('reads, edits after review, and reports; the reply is the round with no call', async () => {
    const { transport, requests } = scripted([
      () => [text('Let me look.'), call('c1', 'read_file', { path: 'src/math.ts' })],
      () => [call('c2', 'edit_file', { path: 'src/math.ts', old_string: 'return a - b', new_string: 'return a + b' })],
      () => [text('Fixed add(): it subtracted. Changed src/math.ts.')]
    ])
    const h = host(transport)
    const r = await runAgentTask(spec(transport), h.host)
    assert.equal(r.status, 'done')
    assert.equal(r.finalText, 'Fixed add(): it subtracted. Changed src/math.ts.')
    assert.match(readFileSync(join(dir, 'src', 'math.ts'), 'utf8'), /return a \+ b/)
    assert.equal(h.reviews.length, 1, 'the edit was shown for review')
    assert.equal(h.reviews[0]!.callId, 'c2', 'under the call that made it')
    assert.match(h.reviews[0]!.diff, /-  return a - b\n\+  return a \+ b/)
    assert.deepEqual(r.changedFiles, ['src/math.ts'])
    assert.equal(r.checkpoints[0]!.before, 'export function add(a: number, b: number) {\n  return a - b\n}\n')
    // The model got one line for the edit; the record shows the diff.
    const toolMsg = requests[2]!.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'c2')
    assert.match(String(toolMsg?.content), /^Edited src\/math\.ts: /)
    assert.doesNotMatch(String(toolMsg?.content), /@@/)
    const end = h.events.find((e) => e.type === 'tool_end' && e.record.id === 'c2')
    assert.ok(end && end.type === 'tool_end' && /@@/.test(end.record.result ?? ''), 'the record carries the diff')
    assert.deepEqual(
      h.events.filter((e) => e.type === 'status').map((e) => (e as { status: string }).status),
      ['running', 'done']
    )
  })

  test('the history carries on to the next turn with a fresh system prompt', async () => {
    const { transport, requests } = scripted([() => [text('Hello.')], () => [text('Still here.')]])
    const h = host(transport)
    const first = await runAgentTask(spec(transport, { prompt: 'hi' }), h.host)
    await runAgentTask(spec(transport, { prompt: 'again', history: first.history }), h.host)
    const second = requests[1]!.messages
    assert.equal(second.filter((m) => m.role === 'system').length, 1)
    assert.deepEqual(
      second.filter((m) => m.role !== 'system').map((m) => [m.role, m.content]),
      [
        ['user', 'hi'],
        ['assistant', 'Hello.'],
        ['user', 'again']
      ]
    )
  })

  test('a declined edit leaves the file alone and tells the model not to retry', async () => {
    const { transport, requests } = scripted([
      () => [call('c1', 'read_file', { path: 'src/math.ts' })],
      () => [call('c2', 'edit_file', { path: 'src/math.ts', old_string: 'return a - b', new_string: 'return 0' })],
      () => [text('Understood.')]
    ])
    const h = host(transport, { reviewEdit: async () => false })
    const r = await runAgentTask(spec(transport), h.host)
    assert.equal(r.status, 'done')
    assert.match(readFileSync(join(dir, 'src', 'math.ts'), 'utf8'), /return a - b/)
    assert.deepEqual(r.changedFiles, [])
    const toolMsg = requests[2]!.messages.find((m) => m.tool_call_id === 'c2')
    assert.match(String(toolMsg?.content), /discarded/)
    assert.match(String(toolMsg?.content), /Do not propose the same change again/)
  })

  test('Accept edits applies without asking, and still checkpoints', async () => {
    const { transport } = scripted([
      () => [call('c1', 'read_file', { path: 'src/math.ts' })],
      () => [call('c2', 'edit_file', { path: 'src/math.ts', old_string: 'a - b', new_string: 'a + b' })],
      () => [text('Done.')]
    ])
    const h = host(transport)
    const r = await runAgentTask(spec(transport, { permission: 'acceptEdits' }), h.host)
    assert.equal(h.reviews.length, 0)
    assert.match(readFileSync(join(dir, 'src', 'math.ts'), 'utf8'), /a \+ b/)
    assert.equal(r.checkpoints.length, 1)
  })

  test('re-reading a file after editing it reads the file, not the earlier result', async () => {
    const { transport, requests } = scripted([
      () => [call('c1', 'read_file', { path: 'src/math.ts' })],
      () => [call('c2', 'edit_file', { path: 'src/math.ts', old_string: 'a - b', new_string: 'a * b' })],
      () => [call('c3', 'read_file', { path: 'src/math.ts' })],
      () => [text('ok')]
    ])
    await runAgentTask(spec(transport, { permission: 'acceptEdits' }), host(transport).host)
    const reread = requests[3]!.messages.find((m) => m.tool_call_id === 'c3')
    assert.match(String(reread?.content), /a \* b/)
    assert.doesNotMatch(String(reread?.content), /result reused/)
  })

  test('read-only offers no tool that writes or runs, and says so', async () => {
    const { transport, requests } = scripted([() => [text('Plan: change line 2.')]])
    await runAgentTask(spec(transport, { permission: 'readOnly' }), host(transport).host)
    const tools = requests[0]!.tools
    for (const t of ['edit_file', 'write_file', 'run_command']) assert.ok(!tools.includes(t), `${t} offered read-only`)
    for (const t of ['read_file', 'grep', 'glob', 'todo_write', 'task']) assert.ok(tools.includes(t), `${t} missing`)
    assert.match(String(requests[0]!.messages[0]!.content), /READ-ONLY/)
    assert.doesNotMatch(String(requests[0]!.messages[0]!.content), /edit_file/)
  })

  test('the round cap pauses the task and says how to carry on', async () => {
    const replies: Reply[] = Array.from({ length: 3 }, (_, i) => () => [call(`c${i}`, 'glob', { pattern: `*.x${i}` })])
    const { transport } = scripted(replies)
    const r = await runAgentTask(spec(transport, { maxRounds: 3 }), host(transport).host)
    assert.equal(r.status, 'paused')
    assert.match(r.detail ?? '', /continue/)
  })

  test('Stop ends the task as stopped', async () => {
    const controller = new AbortController()
    const { transport } = scripted([
      () => {
        controller.abort()
        return [call('c1', 'glob', { pattern: '*.ts' })]
      }
    ])
    const r = await runAgentTask(spec(transport, { signal: controller.signal }), host(transport).host)
    assert.equal(r.status, 'stopped')
  })

  test('a server failure is a status with its reason, not a throw', async () => {
    const transport: ChunkTransport = async () => ({ ok: false, status: 400, errorText: 'No models loaded' })
    const r = await runAgentTask(spec(transport), host(transport).host)
    assert.equal(r.status, 'error')
    assert.match(r.detail ?? '', /HTTP 400: No models loaded/)
  })

  test('a checklist is reported live and returned', async () => {
    const todos = [
      { content: 'Read math.ts', status: 'completed' },
      { content: 'Fix add', status: 'in_progress' },
      { content: 'Run tests', status: 'pending' }
    ]
    const { transport, requests } = scripted([() => [call('c1', 'todo_write', { todos })], () => [text('ok')]])
    const h = host(transport)
    const r = await runAgentTask(spec(transport), h.host)
    assert.deepEqual(r.todos.map((t) => t.status), ['completed', 'in_progress', 'pending'])
    assert.ok(h.events.some((e) => e.type === 'todos'))
    assert.match(String(requests[1]!.messages.find((m) => m.tool_call_id === 'c1')?.content), /1 of 3 done; now: Fix add/)
  })
})

describe('helpers', () => {
  test('an explore helper works in a fresh context, read-only, and hands back one report', async () => {
    const { transport, requests } = scripted([
      () => [call('t1', 'task', { subagent_type: 'explore', description: 'find add', prompt: 'Where is add() defined? Report the file and line.' })],
      // The helper's own rounds:
      () => [call('h1', 'grep', { pattern: 'function add' })],
      () => [text('add() is defined in src/math.ts:1.')],
      // Back in the parent:
      () => [text('Found it.')]
    ])
    const h = host(transport)
    const r = await runAgentTask(spec(transport), h.host)
    assert.equal(r.status, 'done')
    const helperFirst = requests[1]!
    assert.equal(helperFirst.messages.length, 2, 'system + the prompt, nothing of the parent')
    assert.match(String(helperFirst.messages[0]!.content), /read-only research helper/)
    assert.ok(!helperFirst.tools.includes('edit_file') && !helperFirst.tools.includes('task'))
    const report = requests[3]!.messages.find((m) => m.tool_call_id === 't1')
    assert.match(String(report?.content), /Report from the explore helper \(find add\):\n\nadd\(\) is defined in src\/math\.ts:1\./)
    // The helper's call is filed under the task call; its words do not stream as the parent's.
    const nested = h.events.find((e) => e.type === 'tool_start' && e.record.id === 'h1')
    assert.ok(nested && nested.type === 'tool_start' && nested.record.parentCallId === 't1')
    const streamed = h.events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')
    assert.doesNotMatch(streamed, /defined in src\/math/)
  })

  test('a helper cannot start helpers, and a read-only task offers no general helper', async () => {
    const { transport, requests } = scripted([() => [text('ok')]])
    await runAgentTask(spec(transport, { permission: 'readOnly' }), host(transport).host)
    const taskTool = JSON.stringify(requests[0]!.messages[0]) + JSON.stringify(requests[0]!.tools)
    assert.ok(requests[0]!.tools.includes('task'))
    assert.doesNotMatch(taskTool, /"general"/)
  })
})

describe('the toolbox on a real folder', () => {
  const box = (permission: 'ask' | 'acceptEdits' | 'readOnly' = 'acceptEdits', over: Partial<AgentHost> = {}, experiments: { multiRead?: boolean } = {}) =>
    new Toolbox({
      root: dir,
      permission,
      host: host(scripted([]).transport, over).host,
      shell: NODE_SHELL,
      commandTimeoutSec: 30,
      state: newTaskState(),
      signal: new AbortController().signal,
      experiments
    })

  test('paths stay inside the workspace', async () => {
    assert.throws(() => resolveInside(dir, '../outside.txt'), WorkspaceError)
    assert.throws(() => resolveInside(dir, tmpdir()), WorkspaceError)
    assert.equal(resolveInside(dir, 'src/math.ts'), join(dir, 'src', 'math.ts'))
    const r = await box().execute('read_file', { path: '../../etc/passwd' }, 'x')
    assert.equal(r.ok, false)
    assert.match(r.error ?? '', /outside the workspace/)
  })

  test('glob: a bare pattern matches names at any depth, and node_modules is skipped', async () => {
    const r = await box().execute('glob', { pattern: '*.ts' }, 'x')
    const found = (r.output ?? '').split('\n').sort()
    assert.deepEqual(found, ['src/math.test.ts', 'src/math.ts'])
    assert.ok(globToRegExp('src/**/*.test.ts').test('src/math.test.ts'))
    assert.ok(globToRegExp('src/**/*.test.ts').test('src/deep/a/b.test.ts'))
    assert.ok(globToRegExp('*.{md,txt}').test('docs/notes.txt'))
    assert.ok(!globToRegExp('src/*.ts').test('src/deep/x.ts'))
  })

  test('grep: path:line: text, a literal fallback for a broken regex, a glob filter', async () => {
    const hit = await box().execute('grep', { pattern: 'return a' }, 'x')
    assert.match(hit.output ?? '', /^src\/math\.ts:2: {3}return a - b/m)
    const literal = await box().execute('grep', { pattern: 'add(' }, 'x')
    assert.match(literal.output ?? '', /searched for literally/)
    assert.match(literal.output ?? '', /src\/math\.ts:1:/)
    const filtered = await box().execute('grep', { pattern: 'add', glob: '*.test.ts', output_mode: 'files_with_matches' }, 'x')
    assert.equal(filtered.output?.split('\n')[0], 'src/math.test.ts')
  })

  test('read_file: numbered lines, a window with a way to read on, binary refused', async () => {
    writeFileSync(join(dir, 'long.txt'), Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n'))
    const r = await box().execute('read_file', { path: 'long.txt', offset: 10, limit: 3 }, 'x')
    assert.equal(r.output, '   10\tline 10\n   11\tline 11\n   12\tline 12\n(lines 10–12 of 500; read on with offset 13)')
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([1, 0, 2, 3]))
    const bin = await box().execute('read_file', { path: 'blob.bin' }, 'x')
    assert.match(bin.error ?? '', /binary file/)
  })

  /** v4.0 (A1, off by default): with the experiment off, read_file offers no more_paths and reads only its path. */
  test('read_file: more_paths is neither offered nor honoured while the multi-read experiment is off', async () => {
    const b = box()
    const schema = b.schemas().find((s) => s.function.name === 'read_file')!
    assert.equal('more_paths' in (schema.function.parameters as { properties: Record<string, unknown> }).properties, false)
    const r = await b.execute('read_file', { path: 'src/math.ts', more_paths: ['src/math.test.ts'] }, 'x')
    assert.equal(r.ok, true)
    assert.equal((r.output ?? '').includes('=== src/math.test.ts ==='), false)
  })

  /** v3.1 (M2): a first look at several files in one round, not one round each. */
  test('read_file: more_paths reads several files in one call; one unreadable file does not sink the rest', async () => {
    const b = box('acceptEdits', {}, { multiRead: true })
    const r = await b.execute('read_file', { path: 'src/math.ts', more_paths: ['src/math.test.ts', 'nope.ts'] }, 'x')
    assert.equal(r.ok, true)
    const out = r.output ?? ''
    assert.match(out, /^=== src\/math\.ts ===\n {4}1\t/)
    assert.match(out, /\n=== src\/math\.test\.ts ===\n {4}1\t/)
    assert.match(out, /\n=== nope\.ts ===\n\(not read: /)
    // Every file read is a file that may now be edited.
    const edit = await b.execute('edit_file', { path: 'src/math.test.ts', old_string: 'add', new_string: 'add', replace_all: true }, 'x')
    assert.doesNotMatch(edit.error ?? '', /before editing/)
    // One path is exactly the single read it always was.
    assert.equal((await box().execute('read_file', { path: 'src/math.ts' }, 'x')).output?.startsWith('    1\t'), true)
    const none = await box('acceptEdits', {}, { multiRead: true }).execute('read_file', { path: 'nope.ts', more_paths: ['also-nope.ts'] }, 'x')
    assert.equal(none.ok, false)
  })

  test('an edit needs the file read first; write_file will not clobber an unread file', async () => {
    const b = box()
    const blind = await b.execute('edit_file', { path: 'src/math.ts', old_string: 'a - b', new_string: 'a + b' }, 'x')
    assert.match(blind.error ?? '', /Read src\/math\.ts with read_file before editing/)
    const clobber = await b.execute('write_file', { path: 'README.md', content: 'gone' }, 'x')
    assert.match(clobber.error ?? '', /already exists\. Read it/)
    const fresh = await b.execute('write_file', { path: 'docs/new.md', content: '# new\n' }, 'x')
    assert.ok(fresh.ok, fresh.error)
    assert.equal(readFileSync(join(dir, 'docs', 'new.md'), 'utf8'), '# new\n')
    assert.match(fresh.display ?? '', /^Applied to docs\/new\.md: new file/)
  })

  test('a command asks first; declined runs nothing, approved returns its output and exit code', async () => {
    let ran = 0
    const declined = await box('ask', { approveCommand: async () => 'declined' }).execute('run_command', { command: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\',\'x\')"' }, 'x')
    assert.equal(declined.ok, false)
    assert.match(declined.error ?? '', /declined/)
    assert.ok(!existsSync(join(dir, 'ran.txt')), 'nothing ran')
    const ok = await box('ask', {
      approveCommand: async () => {
        ran++
        return 'once'
      }
    }).execute('run_command', { command: 'node -e "console.log(6*7)"' }, 'x')
    assert.equal(ran, 1)
    assert.ok(ok.ok, ok.error)
    assert.match(ok.output ?? '', /\$ node -e "console\.log\(6\*7\)"\n42\n\(exit code 0/)
    const failed = await box().execute('run_command', { command: 'node -e "process.exit(3)"' }, 'x')
    assert.equal(failed.ok, false)
    assert.match(failed.error ?? '', /exit code 3/)
  })

  test('a command past its time limit is stopped and says so', async () => {
    const r = await box().execute('run_command', { command: 'node -e "setTimeout(()=>{}, 20000)"', timeout_seconds: 1 }, 'x')
    assert.equal(r.ok, false)
    assert.match(r.error ?? '', /stopped at the 1 s time limit/)
  })

  test('read-only lists no writing tool; no workspace lists none at all', () => {
    const names = (p: 'ask' | 'readOnly') => box(p).schemas().map((s) => s.function.name)
    assert.deepEqual(names('readOnly'), ['list_directory', 'glob', 'grep', 'read_file'])
    assert.ok(names('ask').includes('run_command'))
    const none = new Toolbox({ root: null, permission: 'ask', host: host(scripted([]).transport).host, shell: NODE_SHELL, commandTimeoutSec: 30, state: newTaskState(), signal: new AbortController().signal })
    assert.deepEqual(none.schemas(), [])
  })

  test('multi_edit: several changes to one file land as one diff and one checkpoint, in order', async () => {
    const reviews: EditReview[] = []
    const state = newTaskState()
    const b = new Toolbox({
      root: dir,
      permission: 'ask',
      host: host(scripted([]).transport, { reviewEdit: async (r) => (reviews.push(r), true) }).host,
      shell: NODE_SHELL,
      commandTimeoutSec: 30,
      state,
      signal: new AbortController().signal
    })
    await b.execute('read_file', { path: 'src/math.ts' }, 'r')
    const r = await b.execute(
      'multi_edit',
      {
        path: 'src/math.ts',
        edits: [
          { old_string: 'export function add', new_string: 'export function sum' },
          { old_string: 'return a - b', new_string: 'return a + b' },
          // Applied to the text the first left: the new name is what it finds.
          { old_string: 'function sum(a: number', new_string: 'function sum(a: number = 0' }
        ]
      },
      'm1'
    )
    assert.ok(r.ok, r.error)
    assert.equal(readFileSync(join(dir, 'src', 'math.ts'), 'utf8'), 'export function sum(a: number = 0, b: number) {\n  return a + b\n}\n')
    assert.equal(reviews.length, 1, 'one review for the lot')
    assert.equal(state.checkpoints.size, 1)
    assert.match(r.output ?? '', /3 edits\./)
  })

  test('multi_edit: one edit that fails fails them all, the file untouched and nothing to review', async () => {
    const reviews: EditReview[] = []
    const b = box('ask', { reviewEdit: async (r) => (reviews.push(r), true) })
    const blind = await b.execute('multi_edit', { path: 'src/math.ts', edits: [{ old_string: 'a - b', new_string: 'a + b' }] }, 'x')
    assert.match(blind.error ?? '', /Read src\/math\.ts with read_file before editing/)
    await b.execute('read_file', { path: 'src/math.ts' }, 'r')
    const r = await b.execute(
      'multi_edit',
      { path: 'src/math.ts', edits: [{ old_string: 'a - b', new_string: 'a + b' }, { old_string: 'not in the file', new_string: 'x' }] },
      'm1'
    )
    assert.equal(r.ok, false)
    assert.match(r.error ?? '', /^Edit 2 of 2 failed, so none was applied and the file is unchanged\. old_string was not found/)
    assert.match(readFileSync(join(dir, 'src', 'math.ts'), 'utf8'), /a - b/)
    assert.equal(reviews.length, 0)
    const empty = await b.execute('multi_edit', { path: 'src/math.ts', edits: [] }, 'm2')
    assert.match(empty.error ?? '', /Give edits/)
  })

  test('every tool schema is well-formed for the wire', () => {
    for (const s of workspaceToolSchemas(NODE_SHELL, 120)) {
      assert.equal(s.type, 'function')
      assert.match(s.function.name, /^[a-z_]+$/)
      assert.ok(s.function.description.length > 30)
      assert.equal((s.function.parameters as { type: string }).type, 'object')
    }
  })
})

describe('edit matching', () => {
  test('exact text is replaced once', () => {
    const r = applyEdit('a\nb\nc\n', 'b', 'B')
    assert.deepEqual(r, { ok: true, text: 'a\nB\nc\n', count: 1, how: 'exact' })
  })

  test('an ambiguous match is refused with the count, never guessed', () => {
    const r = applyEdit('x = 1\nx = 1\n', 'x = 1', 'x = 2')
    assert.equal(r.ok, false)
    assert.match((r as { error: string }).error, /occurs 2 times/)
    assert.deepEqual(applyEdit('x = 1\nx = 1\n', 'x = 1', 'x = 2', true), { ok: true, text: 'x = 2\nx = 2\n', count: 2, how: 'exact' })
  })

  test('LF text finds its CRLF lines, and the file stays CRLF', () => {
    const r = applyEdit('one\r\ntwo\r\nthree\r\n', 'two\nthree', 'TWO\nTHREE')
    assert.deepEqual(r, { ok: true, text: 'one\r\nTWO\r\nTHREE\r\n', count: 1, how: 'line-endings' })
  })

  test('read_file line numbers pasted into the search are recognised and removed', () => {
    const r = applyEdit('alpha\nbeta\ngamma\n', '    2\tbeta\n    3\tgamma', '    2\tBETA\n    3\tgamma')
    assert.deepEqual(r, { ok: true, text: 'alpha\nBETA\ngamma\n', count: 1, how: 'line-numbers' })
  })

  test('trailing spaces are forgiven only when that finds exactly one place', () => {
    const r = applyEdit('if (x) {   \n  go()\n}\n', 'if (x) {\n  go()', 'if (y) {\n  go()')
    assert.deepEqual(r, { ok: true, text: 'if (y) {\n  go()\n}\n', count: 1, how: 'trailing-space' })
  })

  test('a miss points at the closest line', () => {
    const r = applyEdit('function add(a, b) {\n  return a - b\n}\n', '  return a-b', 'x')
    assert.equal(r.ok, false)
    assert.match((r as { error: string }).error, /closest line is 2: `return a - b`/)
    const first = applyEdit('function add(a, b) {\n  return a - b\n}\n', 'function add(a, b) {\n  return a + b', 'x')
    assert.match((first as { error: string }).error, /first line appears at line 1/)
  })

  // v4.1 (A6): the margin a small model re-types from memory.
  const PY = 'class A:\n    def f(self):\n        if x:\n            return 1\n        return 2\n'

  test('a block quoted at the wrong depth is found once, and the new text lands at the depth it replaces', () => {
    const shallow = applyEdit(PY, 'if x:\n    return 1', 'if x and y:\n    return 1\nelse:\n    pass')
    assert.deepEqual(shallow, {
      ok: true,
      text: 'class A:\n    def f(self):\n        if x and y:\n            return 1\n        else:\n            pass\n        return 2\n',
      count: 1,
      how: 'indentation'
    })
    const deep = applyEdit(PY, '            if x:\n                return 1', '            if y:\n                return 1')
    assert.equal(deep.ok && deep.text, PY.replace('if x:', 'if y:'))
  })

  test('indentation is not forgiven when it finds two places, or when one shift does not explain every line', () => {
    const twice = applyEdit('def a():\n    pass\ndef b():\n  pass\n', 'pass', 'return')
    assert.equal(twice.ok, false)
    const both = applyEdit('if a:\n    go()\nif b:\n  go()\n', '        go()', 'stop()')
    assert.match((both as { error: string }).error, /occurs 2 times once indentation is ignored \(at lines 2, 4\)/)
    const skewed = applyEdit(PY, 'if x:\nreturn 1', 'if y:\nreturn 1')
    assert.equal(skewed.ok, false)
    assert.match((skewed as { error: string }).error, /indentation changed line by line/)
    const tabs = applyEdit('\tif x:\n\t\tgo()\n', '    if x:\n        go()', '    if y:\n        go()')
    assert.equal(tabs.ok, false, 'tabs against spaces is not a shift')
  })
})

describe('context fitting', () => {
  const big = 'x'.repeat(4_000)
  const history = (): ApiMessage[] => {
    const m: ApiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'the task' }
    ]
    for (let i = 0; i < 8; i++) {
      m.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] })
      m.push({ role: 'tool', tool_call_id: `c${i}`, content: big })
    }
    return m
  }

  test('the oldest tool outputs are replaced by a note, the recent ones kept whole', () => {
    const m = history()
    const r = fitContext(m, 6_000)
    assert.ok(r.elided > 0)
    const tools = m.filter((x) => x.role === 'tool')
    assert.match(String(tools[0]!.content), /^\[Earlier output of read_file removed to fit the context window \(4,000 characters\)/)
    assert.equal(tools.slice(-4).every((t) => t.content === big), true, 'the last four are untouched')
    assert.equal(r.stillOver, false)
  })

  test('when eliding is not enough, whole rounds go — never a call without its result', () => {
    const m = history()
    const r = fitContext(m, 3_000)
    assert.ok(r.droppedRounds > 0)
    assert.equal(m[1]!.role, 'user')
    assert.match(String(m[1]!.content), new RegExp(DROPPED_NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    for (let i = 0; i < m.length; i++) {
      if (m[i]!.role === 'tool') assert.ok(m.slice(0, i).some((x) => x.tool_calls?.some((c) => c.id === m[i]!.tool_call_id)), 'a result without its call')
    }
    assert.equal(m.filter((x) => x.role === 'user').length, 1, 'no second user message — templates that need alternation still accept it')
  })

  test('a history that fits is left exactly as it was', () => {
    const m = history().slice(0, 4)
    const before = JSON.stringify(m)
    fitContext(m, 100_000)
    assert.equal(JSON.stringify(m), before)
  })

  /**
   * v3.1 (M2): a server reuses its prompt cache only up to the first changed
   * token, and an elision rewrites the start of the history. Trimmed to just
   * under the line, the next round crossed it again and the start moved every
   * round; trimmed to the low-water mark, the next rounds fit untouched.
   */
  test('once over, it trims to the low-water mark, so the next rounds leave the start alone', () => {
    const m = history()
    const budget = 9_000
    const first = fitContext(m, budget)
    assert.ok(first.elided > 0)
    assert.ok(estimateTokens(m) <= budget * LOW_WATER, 'trimmed to the low-water mark, not just under the budget')
    const start = JSON.stringify(m.slice(0, 6))
    // Three more rounds of ordinary size.
    for (let i = 8; i < 11; i++) {
      m.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] })
      m.push({ role: 'tool', tool_call_id: `c${i}`, content: 'y'.repeat(1_500) })
      assert.equal(fitContext(m, budget).elided, 0, `round ${i} rewrote the history's start`)
    }
    assert.equal(JSON.stringify(m.slice(0, 6)), start)
  })

  test('rounds are still dropped only to get under the budget, not to the low-water mark', () => {
    const m = history()
    const r = fitContext(m, 3_000)
    assert.ok(r.droppedRounds > 0)
    assert.equal(r.stillOver, false)
    // One round fewer would have been over: nothing beyond the budget was dropped.
    assert.ok(estimateTokens(m) > 3_000 * LOW_WATER || r.droppedRounds === 1)
  })
})

describe('the prompt', () => {
  test('SIGMA.md is the project’s instructions; AGENTS.md and CLAUDE.md are read when it is absent', async () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'Use pnpm.')
    assert.equal((await loadProjectNotes(dir))?.file, 'CLAUDE.md')
    writeFileSync(join(dir, 'AGENTS.md'), 'Run make test.')
    assert.equal((await loadProjectNotes(dir))?.file, 'AGENTS.md')
    writeFileSync(join(dir, 'SIGMA.md'), 'Tabs, not spaces.')
    const notes = await loadProjectNotes(dir)
    assert.equal(notes?.file, 'SIGMA.md')
    const prompt = agentSystemPrompt({
      workspace: dir,
      permission: 'ask',
      shell: NODE_SHELL,
      platform: process.platform,
      now: new Date(2026, 8, 28, 12),
      notes,
      listing: ['src/', 'README.md'],
      branch: 'main',
      tools: ['read_file', 'edit_file', 'run_command', 'todo_write', 'task']
    })
    assert.match(prompt, /## Project instructions \(SIGMA\.md\)\nTabs, not spaces\./)
    assert.match(prompt, /Today is 2026-09-28 \(Monday\)/)
    assert.match(prompt, /Every edit and every command is shown to the user for approval/)
    assert.match(prompt, /Git branch: main/)
  })
})

describe('boundaries', () => {
  test('nothing under src/main/agent imports Electron — the CLI runs it on plain Node', () => {
    const agentDir = join(__dirname, '..', '..', 'src', 'main', 'agent')
    for (const f of readdirSync(agentDir).filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(join(agentDir, f), 'utf8')
      assert.doesNotMatch(src, /from ['"]electron['"]|require\(['"]electron['"]\)/, `${f} imports electron`)
      assert.doesNotMatch(src, /from ['"]\.\.\/ipc\//, `${f} reaches into the app's IPC layer`)
    }
  })

  test('the destructive-command list covers what an agent reaches for', () => {
    for (const cmd of ['rm -rf build/', 'rd /s /q dist', 'Remove-Item -Recurse -Force out', 'git reset --hard HEAD~1', 'git clean -fdx', 'git push --force origin main', 'git checkout -- .']) {
      assert.ok(dangerousCommandWarning(cmd), `${cmd} not flagged`)
    }
    for (const cmd of ['npm test', 'git status', 'git diff', 'ls -la', 'git push origin feature']) {
      assert.equal(dangerousCommandWarning(cmd), null, `${cmd} flagged`)
    }
  })
})

describe('experiments (v4.0, each off by default)', () => {
  const echo = 'echo ok'
  const fail = process.platform === 'win32' ? 'exit /b 1' : 'exit 1'

  test('thinkByPhase: on a <think> family, a round after a successful read starts closed; the first round and the round after a failure think', async () => {
    const { transport, requests } = scripted([
      () => [call('c1', 'read_file', { path: 'src/math.ts' })],
      () => [call('c2', 'edit_file', { path: 'src/math.ts', old_string: 'nowhere', new_string: 'x' })],
      () => [text('Done.')]
    ])
    await runAgentTask(spec(transport, { model: 'qwen3-9b', experiments: { thinkByPhase: true } }), host(transport).host)
    const last = (i: number) => requests[i]!.messages.at(-1)!
    assert.notEqual(last(0).role, 'assistant', 'the first round thinks')
    assert.equal(last(1).role, 'assistant', 'after a read the round starts with the block closed')
    assert.match(String(last(1).content), /^<think>\n\n<\/think>/)
    assert.notEqual(last(2).role, 'assistant', 'after a failed edit the round thinks')
    assert.ok(!requests[2]!.messages.some((m) => m.role === 'assistant' && /^<think>\n\n<\/think>/.test(String(m.content))), 'the prefill never joins the history')
  })

  test('thinkByPhase does nothing off, and nothing on a model without a think tag', async () => {
    for (const over of [{ model: 'qwen3-9b' }, { model: 'gemma-3-12b', experiments: { thinkByPhase: true } }]) {
      const { transport, requests } = scripted([() => [call('c1', 'read_file', { path: 'src/math.ts' })], () => [text('Done.')]])
      await runAgentTask(spec(transport, over), host(transport).host)
      assert.notEqual(requests[1]!.messages.at(-1)!.role, 'assistant')
    }
  })

  test('verifyRound: an edit with no check after it gets one more round with run_command only; the exit code decides the report', async () => {
    const { transport, requests } = scripted([
      () => [call('c1', 'read_file', { path: 'src/math.ts' })],
      () => [call('c2', 'run_command', { command: fail })],
      () => [call('c3', 'edit_file', { path: 'src/math.ts', old_string: 'return a - b', new_string: 'return a + b' })],
      () => [text('Fixed add(). All tests pass.')],
      // The verify round: only run_command is on the table.
      () => [call('c4', 'run_command', { command: echo })],
      () => [text('Ran it: exit code 0. Fixed add().')]
    ])
    const r = await runAgentTask(spec(transport, { permission: 'acceptEdits', experiments: { verifyRound: true } }), host(transport).host)
    assert.equal(r.status, 'done')
    assert.deepEqual(requests[4]!.tools, ['run_command'])
    assert.match(String(requests[4]!.messages.at(-1)!.content), /Files changed after the last check\. Run `.*` with run_command now/)
    assert.equal(r.finalText, 'Ran it: exit code 0. Fixed add().')
  })

  test('verifyRound: a report that still claims a passing check the timeline lacks is told so, in the text the user sees', async () => {
    const { transport, requests } = scripted([
      () => [call('c1', 'read_file', { path: 'src/math.ts' })],
      () => [call('c2', 'run_command', { command: echo })],
      () => [call('c3', 'edit_file', { path: 'src/math.ts', old_string: 'return a - b', new_string: 'return a + b' })],
      () => [text('All tests pass.')],
      () => [text('All tests pass, trust me.')]
    ])
    const h = host(transport)
    const r = await runAgentTask(spec(transport, { permission: 'acceptEdits', experiments: { verifyRound: true } }), h.host)
    assert.equal(requests.length, 5, 'the verify round ran, and the model refused it')
    assert.match(r.finalText, /All tests pass, trust me\.\n\n\(No check ran after the last edit in this task/)
    const streamed = h.events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')
    assert.match(streamed, /No check ran after the last edit/)
  })

  test('verifyRound: a check that ran after the last edit needs no extra round; off, nothing changes', async () => {
    for (const experiments of [{ verifyRound: true }, {}]) {
      const { transport, requests } = scripted([
        () => [call('c1', 'read_file', { path: 'src/math.ts' })],
        () => [call('c2', 'edit_file', { path: 'src/math.ts', old_string: 'return a - b', new_string: 'return a + b' })],
        () => [call('c3', 'run_command', { command: echo })],
        () => [text('All tests pass.')]
      ])
      const r = await runAgentTask(spec(transport, { permission: 'acceptEdits', experiments }), host(transport).host)
      assert.equal(requests.length, 4)
      assert.equal(r.finalText, 'All tests pass.')
    }
  })

  test('reviewer: a review helper reads the diff before the report, and its findings become one more round', async () => {
    const { transport, requests } = scripted([
      () => [call('c1', 'read_file', { path: 'src/math.ts' })],
      () => [call('c2', 'edit_file', { path: 'src/math.ts', old_string: 'return a - b', new_string: 'return a + b' })],
      () => [text('Fixed add().')],
      // The review helper's one round:
      () => [text('src/math.ts:2 — no test covers add(); add one.')],
      // Back in the parent:
      () => [text('Fixed add(); the missing test is left for you.')]
    ])
    const r = await runAgentTask(spec(transport, { permission: 'acceptEdits', experiments: { reviewer: true } }), host(transport).host)
    assert.equal(r.status, 'done')
    const review = requests[3]!
    assert.match(String(review.messages[0]!.content), /careful reviewer/)
    assert.match(String(review.messages[1]!.content), /Review this diff[\s\S]*-  return a - b\n\+  return a \+ b/)
    assert.match(String(requests[4]!.messages.at(-1)!.content), /A review helper read the diff[\s\S]*no test covers add\(\)/)
    assert.equal(r.finalText, 'Fixed add(); the missing test is left for you.')
  })

  test('reviewer: "No problems." ends it; nothing changed means no review at all', async () => {
    const clean = scripted([
      () => [call('c1', 'read_file', { path: 'src/math.ts' })],
      () => [call('c2', 'edit_file', { path: 'src/math.ts', old_string: 'return a - b', new_string: 'return a + b' })],
      () => [text('Fixed add().')],
      () => [text('No problems.')]
    ])
    const r = await runAgentTask(spec(clean.transport, { permission: 'acceptEdits', experiments: { reviewer: true } }), host(clean.transport).host)
    assert.equal(r.finalText, 'Fixed add().')
    assert.equal(clean.requests.length, 4)
    const untouched = scripted([() => [text('Nothing to do.')]])
    await runAgentTask(spec(untouched.transport, { experiments: { reviewer: true } }), host(untouched.transport).host)
    assert.equal(untouched.requests.length, 1)
  })

  test('notes: .sigma/notes.md rides the prompt after the project file, and the rule to keep it is on only with the switch', async () => {
    mkdirSync(join(dir, '.sigma'))
    writeFileSync(join(dir, 'SIGMA.md'), 'Tabs, not spaces.')
    writeFileSync(join(dir, '.sigma', 'notes.md'), 'Tests: node --test.')
    const off = await loadProjectNotes(dir)
    assert.doesNotMatch(off!.text, /node --test/)
    const on = await loadProjectNotes(dir, true)
    assert.equal(on!.file, 'SIGMA.md')
    assert.match(on!.text, /Tabs, not spaces\.\n\n## Notes the agent kept here \(\.sigma\/notes\.md\)\nTests: node --test\./)
    rmSync(join(dir, 'SIGMA.md'))
    assert.equal((await loadProjectNotes(dir, true))!.file, '.sigma/notes.md')
    for (const experiments of [{ notes: true }, {}]) {
      const { transport, requests } = scripted([() => [text('ok')]])
      await runAgentTask(spec(transport, { experiments }), host(transport).host)
      const system = String(requests[0]!.messages[0]!.content)
      assert.equal(/add it to \.sigma\/notes\.md/.test(system), experiments.notes === true)
      assert.equal(/Tests: node --test/.test(system), experiments.notes === true)
    }
  })
})

describe('experiments, the second four (v4.0, each off by default)', () => {
  const big = 'x'.repeat(600)
  const plan = (statuses: ('pending' | 'in_progress' | 'completed')[]) => ({ todos: ['read', 'fix', 'test'].map((content, i) => ({ content, status: statuses[i] })) })

  test('planFocus: the plan rides each round as a transient message, and a finished step’s output is set aside before the next round', async () => {
    writeFileSync(join(dir, 'src', 'big.ts'), big)
    const { transport, requests } = scripted([
      () => [call('c1', 'todo_write', plan(['in_progress', 'pending', 'pending']))],
      () => [call('c2', 'read_file', { path: 'src/big.ts' })],
      () => [call('c3', 'todo_write', plan(['completed', 'in_progress', 'pending']))],
      () => [text('Done.')]
    ])
    const h = host(transport)
    const r = await runAgentTask(spec(transport, { experiments: { planFocus: true } }), h.host)
    assert.notEqual(requests[0]!.messages.at(-1)!.content, undefined)
    assert.doesNotMatch(String(requests[0]!.messages.at(-1)!.content), /Plan in view/, 'the first round has no plan yet')
    const third = requests[2]!.messages.at(-1)!
    assert.equal(third.role, 'user')
    assert.match(String(third.content), /Plan in view[\s\S]*▶ read\n☐ fix\n☐ test\nYou are on: read\./)
    const fourth = requests[3]!.messages
    assert.match(String(fourth.at(-1)!.content), /☑ read\n▶ fix/)
    const readResult = fourth.find((m) => m.role === 'tool' && m.tool_call_id === 'c2')
    assert.match(String(readResult?.content), /^\[Earlier output of read_file set aside: that step is done/)
    assert.ok(h.events.some((e) => e.type === 'context_elided' && e.toolResults === 1))
    assert.ok(!r.history.some((m) => /Plan in view/.test(String(m.content))), 'the plan message never joins the history')
  })

  test('planFocus off: no plan message, and a read stays in the context after a step completes', async () => {
    writeFileSync(join(dir, 'src', 'big.ts'), big)
    const { transport, requests } = scripted([
      () => [call('c1', 'todo_write', plan(['in_progress', 'pending', 'pending']))],
      () => [call('c2', 'read_file', { path: 'src/big.ts' })],
      () => [call('c3', 'todo_write', plan(['completed', 'in_progress', 'pending']))],
      () => [text('Done.')]
    ])
    await runAgentTask(spec(transport), host(transport).host)
    assert.notEqual(requests[2]!.messages.at(-1)!.role, 'user')
    assert.match(String(requests[3]!.messages.find((m) => m.tool_call_id === 'c2')?.content), /xxxx/)
  })

  test('askUser: the tool is offered only with the switch; a question pauses the task, is reported with its choices, and the answer is the next turn', async () => {
    const off = scripted([() => [text('ok')]])
    await runAgentTask(spec(off.transport), host(off.transport).host)
    assert.ok(!off.requests[0]!.tools.includes('ask_user'))

    const { transport, requests } = scripted([
      () => [call('q1', 'ask_user', { question: 'Which runner?', choices: ['jest', 'vitest'] })],
      // The next turn, with the answer:
      () => [text('Using vitest.')]
    ])
    const h = host(transport)
    const r = await runAgentTask(spec(transport, { experiments: { askUser: true } }), h.host)
    assert.ok(requests[0]!.tools.includes('ask_user'))
    assert.equal(r.status, 'paused')
    assert.match(r.detail ?? '', /The agent asks: Which runner\? \(jest \/ vitest\)/)
    assert.deepEqual(h.events.find((e) => e.type === 'question'), { type: 'question', question: 'Which runner?', choices: ['jest', 'vitest'] })
    assert.equal(requests.length, 1, 'no round runs after the question')
    const next = await runAgentTask(spec(transport, { experiments: { askUser: true }, history: r.history, prompt: 'vitest' }), h.host)
    assert.equal(next.status, 'done')
    assert.equal(next.finalText, 'Using vitest.')
    const wire = requests[1]!.messages
    assert.equal(wire.at(-1)!.content, 'vitest')
    assert.equal(wire.at(-2)!.role, 'tool', 'the question’s tool result stays on the wire before the answer')
  })

  test('askUser: a helper cannot ask', async () => {
    const { transport } = scripted([
      () => [call('t1', 'task', { subagent_type: 'explore', description: 'look', prompt: 'Which runner?' })],
      () => [call('h1', 'ask_user', { question: 'Which runner?' })],
      () => [text('Could not ask.')],
      () => [text('Done.')]
    ])
    const r = await runAgentTask(spec(transport, { experiments: { askUser: true } }), host(transport).host)
    assert.equal(r.status, 'done')
  })

  test('hooks: .sigma/hooks.json runs after an edit, before a command and at the end — each a line on the timeline under the command grant', async () => {
    mkdirSync(join(dir, '.sigma'))
    writeFileSync(join(dir, '.sigma', 'hooks.json'), JSON.stringify({ afterEdit: ['echo edited {file}'], beforeCommand: ['echo before {command}'], onEnd: ['echo ended'], junk: ['ignored'] }))
    const { transport } = scripted([
      () => [call('c1', 'read_file', { path: 'src/math.ts' })],
      () => [call('c2', 'edit_file', { path: 'src/math.ts', old_string: 'return a - b', new_string: 'return a + b' })],
      () => [call('c3', 'run_command', { command: 'echo tests' })],
      () => [text('Done.')]
    ])
    const h = host(transport)
    const r = await runAgentTask(spec(transport, { permission: 'acceptEdits', experiments: { hooks: true } }), h.host)
    assert.equal(r.status, 'done')
    const hooks = h.events.filter((e): e is Extract<AgentEvent, { type: 'tool_end' }> => e.type === 'tool_end' && e.record.name === 'hook')
    assert.deepEqual(
      hooks.map((e) => [e.record.args.when, e.record.args.command, e.record.status]),
      [
        ['afterEdit', 'echo edited src/math.ts', 'done'],
        ['beforeCommand', 'echo before echo tests', 'done'],
        ['onEnd', 'echo ended', 'done']
      ]
    )
    assert.match(hooks[0]!.record.result ?? '', /edited src\/math\.ts/)
    assert.deepEqual(h.commands, ['echo edited src/math.ts', 'echo before echo tests', 'echo tests', 'echo ended'], 'every hook went through the approval, in order')
  })

  test('hooks: a failed after-edit hook is told to the model; off, the file is never read', async () => {
    mkdirSync(join(dir, '.sigma'))
    writeFileSync(join(dir, '.sigma', 'hooks.json'), JSON.stringify({ afterEdit: [process.platform === 'win32' ? 'exit /b 3' : 'exit 3'] }))
    const script = () =>
      scripted([
        () => [call('c1', 'read_file', { path: 'src/math.ts' })],
        () => [call('c2', 'edit_file', { path: 'src/math.ts', old_string: 'return a - b', new_string: 'return a + b' })],
        () => [text('Done.')]
      ])
    const on = script()
    await runAgentTask(spec(on.transport, { permission: 'acceptEdits', experiments: { hooks: true } }), host(on.transport).host)
    const editResult = on.requests[2]!.messages.find((m) => m.tool_call_id === 'c2')
    assert.match(String(editResult?.content), /Hook afterEdit `exit.*3` failed:/)
    const off = script()
    const h = host(off.transport)
    await runAgentTask(spec(off.transport, { permission: 'acceptEdits' }), h.host)
    assert.ok(!h.events.some((e) => e.type === 'tool_start' && e.record.name === 'hook'))
  })

  test('worktrees: in a git repository the task works on its own branch in .sigma/worktrees, the folder itself untouched; the next turn carries on there', async (t) => {
    const { execFileSync } = await import('node:child_process')
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' })
    } catch {
      t.skip('git is not on this machine')
      return
    }
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim()
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    const { transport } = scripted([
      () => [call('c1', 'read_file', { path: 'src/math.ts' })],
      () => [call('c2', 'edit_file', { path: 'src/math.ts', old_string: 'return a - b', new_string: 'return a + b' })],
      () => [text('Fixed.')],
      // The next turn:
      () => [call('c3', 'read_file', { path: 'src/math.ts' })],
      () => [text('Still fixed.')]
    ])
    const h = host(transport)
    const r = await runAgentTask(spec(transport, { permission: 'acceptEdits', experiments: { worktrees: true }, prompt: 'Fix add() please', now: new Date(2026, 8, 28, 9, 5) }), h.host)
    assert.equal(r.status, 'done')
    assert.ok(r.worktree, 'a worktree was made')
    assert.equal(r.worktree!.branch, 'sigma/fix-add-please-0928-0905')
    assert.equal(r.workspace, r.worktree!.path)
    assert.match(r.worktree!.path, /[\\/]\.sigma[\\/]worktrees[\\/]fix-add-please-0928-0905$/)
    assert.match(readFileSync(join(r.worktree!.path, 'src', 'math.ts'), 'utf8'), /return a \+ b/, 'the edit landed in the worktree')
    assert.match(readFileSync(join(dir, 'src', 'math.ts'), 'utf8'), /return a - b/, 'the folder itself is untouched')
    assert.match(git('branch', '--list', 'sigma/*'), /sigma\/fix-add-please-0928-0905/)
    assert.match(git('status', '--short'), /^$/, 'the outer repository sees nothing untracked (.sigma/.gitignore)')
    assert.match(r.detail ?? '', /Worked on branch sigma\/fix-add-please-0928-0905/)
    const next = await runAgentTask(spec(transport, { permission: 'acceptEdits', experiments: { worktrees: true }, prompt: 'Check it', history: r.history, worktree: r.worktree }), h.host)
    assert.equal(next.worktree!.path, r.worktree!.path, 'the same worktree')
    assert.equal(next.finalText, 'Still fixed.')
  })

  test('worktrees: a general helper edits the worktree, never the folder the user looks at (4.0.2)', async (t) => {
    const { execFileSync } = await import('node:child_process')
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' })
    } catch {
      t.skip('git is not on this machine')
      return
    }
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim()
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    const { transport } = scripted([
      () => [call('t1', 'task', { subagent_type: 'general', description: 'fix add', prompt: 'Fix add() in src/math.ts and report.' })],
      // The helper's own rounds:
      () => [call('h1', 'read_file', { path: 'src/math.ts' })],
      () => [call('h2', 'edit_file', { path: 'src/math.ts', old_string: 'return a - b', new_string: 'return a + b' })],
      () => [text('Fixed add() in src/math.ts.')],
      // Back in the parent:
      () => [text('Done.')]
    ])
    const r = await runAgentTask(spec(transport, { permission: 'acceptEdits', experiments: { worktrees: true }, prompt: 'Fix add() please', now: new Date(2026, 8, 30, 9, 5) }), host(transport).host)
    assert.equal(r.status, 'done')
    assert.ok(r.worktree, 'a worktree was made')
    assert.match(readFileSync(join(r.worktree!.path, 'src', 'math.ts'), 'utf8'), /return a \+ b/, "the helper's edit landed in the worktree")
    assert.match(readFileSync(join(dir, 'src', 'math.ts'), 'utf8'), /return a - b/, 'the folder itself is untouched')
  })

  test('worktrees: not a repository, or off — the task runs in the folder itself and no worktree is reported', async () => {
    for (const experiments of [{ worktrees: true }, {}]) {
      const { transport } = scripted([
        () => [call('c1', 'read_file', { path: 'src/math.ts' })],
        () => [call('c2', 'edit_file', { path: 'src/math.ts', old_string: 'return a - b', new_string: 'return a + b' })],
        () => [text('Fixed.')]
      ])
      const r = await runAgentTask(spec(transport, { permission: 'acceptEdits', experiments }), host(transport).host)
      assert.equal(r.worktree, undefined)
      assert.equal(r.workspace, dir)
      assert.match(readFileSync(join(dir, 'src', 'math.ts'), 'utf8'), /return a \+ b/)
      writeFileSync(join(dir, 'src', 'math.ts'), 'export function add(a: number, b: number) {\n  return a - b\n}\n')
    }
  })
})

describe('documents and chores (v4.0, C1 and C2, each off by default)', () => {
  const box = (permission: 'ask' | 'acceptEdits' | 'readOnly', over: Partial<AgentHost>, experiments: Partial<import('../src/main/agent/types').AgentExperiments>, state = newTaskState()) => ({
    state,
    toolbox: new Toolbox({ root: dir, permission, host: host(scripted([]).transport, over).host, shell: NODE_SHELL, commandTimeoutSec: 30, state, signal: new AbortController().signal, experiments })
  })
  const names = (b: Toolbox): string[] => b.schemas().map((s) => s.function.name)

  test('the tools are offered only with their switch; read-only keeps read_document and loses the rest', () => {
    const off = box('acceptEdits', {}, {}).toolbox
    assert.ok(!names(off).some((n) => /document|move_file|copy_file|make_directory|delete_file/.test(n)))
    const on = names(box('acceptEdits', {}, { documents: true, chores: true }).toolbox)
    for (const n of ['read_document', 'write_document', 'move_file', 'copy_file', 'make_directory', 'delete_file']) assert.ok(on.includes(n), n)
    const ro = names(box('readOnly', {}, { documents: true, chores: true }).toolbox)
    assert.ok(ro.includes('read_document'))
    assert.ok(!ro.some((n) => /write_document|move_file|copy_file|make_directory|delete_file/.test(n)))
  })

  test('write_document makes a .docx Word would open, read_document reads it back, the diff is of what it says, and Undo removes it', async () => {
    const { toolbox, state } = box('acceptEdits', {}, { documents: true })
    const w = await toolbox.execute('write_document', { path: 'letter.docx', content: '# Hello\n\nDear all,\n\n- one\n- two' }, 'd1')
    assert.ok(w.ok, w.error)
    assert.match(w.display ?? '', /\+# Hello[\s\S]*\+- two/)
    const r = await toolbox.execute('read_document', { path: 'letter.docx' }, 'd2')
    assert.ok(r.ok, r.error)
    assert.match(r.output ?? '', /^letter\.docx \(docx, [\d.]+ K?B\):\n# Hello\n\nDear all,\n\n- one\n- two$/)
    const cp = state.checkpoints.get('letter.docx')!
    assert.equal(cp.encoding, 'base64')
    assert.equal(cp.before, null)
    assert.equal(cp.after, readFileSync(join(dir, 'letter.docx')).toString('base64'))
    const undone = await restoreCheckpoints(dir, [...state.checkpoints.values()])
    assert.deepEqual(undone, { restored: ['letter.docx'], skipped: [] })
    assert.ok(!existsSync(join(dir, 'letter.docx')))
  })

  test('an existing document must be read before it is replaced; the replacement is reviewed as a text diff and Undo puts the old bytes back', async () => {
    writeFileSync(join(dir, 'sheet.xlsx'), sheetsToXlsx([{ name: 'Q1', rows: [['item', 'amount'], ['a', 1]] }]))
    const original = readFileSync(join(dir, 'sheet.xlsx'))
    const reviews: EditReview[] = []
    const { toolbox, state } = box('ask', { reviewEdit: async (r) => (reviews.push(r), true) }, { documents: true })
    const blind = await toolbox.execute('write_document', { path: 'sheet.xlsx', sheets: [{ name: 'Q1', rows: [['item', 'amount'], ['a', 1], ['b', 2]] }] }, 'x1')
    assert.equal(blind.ok, false)
    assert.match(blind.error ?? '', /Read it with read_document first/)
    const read = await toolbox.execute('read_document', { path: 'sheet.xlsx' }, 'x2')
    assert.match(read.output ?? '', /## Sheet: Q1\n\| item \| amount \|/)
    const w = await toolbox.execute('write_document', { path: 'sheet.xlsx', sheets: [{ name: 'Q1', rows: [['item', 'amount'], ['a', 1], ['b', 2]] }] }, 'x3')
    assert.ok(w.ok, w.error)
    assert.equal(reviews.length, 1)
    assert.match(reviews[0]!.diff, /\+\| b \| 2 \|/)
    assert.deepEqual(xlsxToSheets(readFileSync(join(dir, 'sheet.xlsx')))[0]!.rows, [['item', 'amount'], ['a', 1], ['b', 2]])
    await restoreCheckpoints(dir, [...state.checkpoints.values()])
    assert.ok(readFileSync(join(dir, 'sheet.xlsx')).equals(original), 'the original bytes are back')
  })

  test('write_document refuses what it cannot make, and read_document what it cannot read', async () => {
    const { toolbox } = box('acceptEdits', {}, { documents: true })
    assert.match((await toolbox.execute('write_document', { path: 'x.pptx', content: 'a' }, 'e1')).error ?? '', /use write_file/)
    assert.match((await toolbox.execute('write_document', { path: 'x.xlsx' }, 'e2')).error ?? '', /Give sheets/)
    assert.match((await toolbox.execute('read_document', { path: 'src/math.ts' }, 'e3')).error ?? '', /use read_file/)
    writeFileSync(join(dir, 'bad.docx'), 'not a zip')
    assert.match((await toolbox.execute('read_document', { path: 'bad.docx' }, 'e4')).error ?? '', /not a ZIP archive/)
  })

  test('move, copy, make_directory and delete — each inside the folder, each checkpointed, and Undo puts the folder back byte for byte', async () => {
    const photo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255, 254])
    writeFileSync(join(dir, 'IMG_1.png'), photo)
    writeFileSync(join(dir, 'notes.txt'), 'keep me')
    const { toolbox, state } = box('acceptEdits', {}, { chores: true })
    assert.match((await toolbox.execute('make_directory', { path: 'Photos/2026' }, 'm1')).output ?? '', /Created Photos\/2026\//)
    assert.match((await toolbox.execute('make_directory', { path: 'Photos/2026' }, 'm1b')).output ?? '', /already exists/)
    const mv = await toolbox.execute('move_file', { from: 'IMG_1.png', to: 'Photos/2026/IMG_1.png' }, 'm2')
    assert.ok(mv.ok, mv.error)
    assert.ok(!existsSync(join(dir, 'IMG_1.png')) && readFileSync(join(dir, 'Photos', '2026', 'IMG_1.png')).equals(photo))
    const cpFrom = state.checkpoints.get('IMG_1.png')!
    const cpTo = state.checkpoints.get('Photos/2026/IMG_1.png')!
    assert.deepEqual([cpFrom.encoding, cpFrom.after, cpTo.before], ['base64', null, null])
    assert.equal(cpFrom.before, photo.toString('base64'))
    assert.equal(cpTo.after, photo.toString('base64'))
    const cp = await toolbox.execute('copy_file', { from: 'notes.txt', to: 'notes-copy.txt' }, 'm3')
    assert.ok(cp.ok, cp.error)
    assert.equal(readFileSync(join(dir, 'notes-copy.txt'), 'utf8'), 'keep me')
    assert.equal(state.checkpoints.get('notes.txt'), undefined, 'a copy leaves the source unchanged and unrecorded')
    assert.match((await toolbox.execute('copy_file', { from: 'notes.txt', to: 'notes-copy.txt' }, 'm4')).error ?? '', /already exists/)
    const del = await toolbox.execute('delete_file', { path: 'notes.txt' }, 'm5')
    assert.ok(del.ok, del.error)
    assert.match(del.output ?? '', /to \.sigma\/trash\/; Undo restores it/)
    assert.ok(!existsSync(join(dir, 'notes.txt')))
    assert.ok(readdirSync(join(dir, '.sigma', 'trash')).some((n) => n.endsWith('-notes.txt')), 'the file is in the folder’s trash, not gone')
    assert.match((await toolbox.execute('delete_file', { path: 'src' }, 'm6')).error ?? '', /is a folder/)
    assert.match((await toolbox.execute('move_file', { from: 'nope.txt', to: 'x.txt' }, 'm7')).error ?? '', /does not exist/)
    await assert.rejects(toolbox.execute('move_file', { from: 'src/math.ts', to: '../out.ts' }, 'm8').then((r) => (r.ok ? Promise.resolve() : Promise.reject(new Error(r.error)))), /outside the workspace/)
    const undone = await restoreCheckpoints(dir, [...state.checkpoints.values()])
    assert.deepEqual(undone.skipped, [])
    assert.ok(readFileSync(join(dir, 'IMG_1.png')).equals(photo), 'the photo is back where it was')
    assert.ok(!existsSync(join(dir, 'Photos', '2026', 'IMG_1.png')))
    assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'keep me', 'the deleted file is restored')
    assert.ok(!existsSync(join(dir, 'notes-copy.txt')))
  })

  test('a folder moves with every file inside checkpointed; the host’s trash is used when it has one; Ask first asks once per chore', async () => {
    mkdirSync(join(dir, 'Downloads', 'sub'), { recursive: true })
    writeFileSync(join(dir, 'Downloads', 'a.pdf'), 'A')
    writeFileSync(join(dir, 'Downloads', 'sub', 'b.pdf'), 'B')
    const reviews: EditReview[] = []
    const trashed: string[] = []
    const trash = async (p: string): Promise<void> => {
      trashed.push(p)
      rmSync(p)
    }
    const { toolbox, state } = box('ask', { reviewEdit: async (r) => (reviews.push(r), r.diff.startsWith('Delete') ? false : true), trash }, { chores: true })
    const mv = await toolbox.execute('move_file', { from: 'Downloads', to: 'Archive/2026' }, 'f1')
    assert.ok(mv.ok, mv.error)
    assert.equal(mv.output, 'Moved Downloads/ → Archive/2026/ (2 files).')
    assert.equal(reviews[0]!.diff, 'Move Downloads/ → Archive/2026/ (2 files)')
    assert.deepEqual([...state.checkpoints.keys()].sort(), ['Archive/2026/a.pdf', 'Archive/2026/sub/b.pdf', 'Downloads/a.pdf', 'Downloads/sub/b.pdf'])
    const del = await toolbox.execute('delete_file', { path: 'Archive/2026/a.pdf' }, 'f2')
    assert.equal(del.ok, false, 'declined in Ask first')
    assert.match(del.error ?? '', /declined to delete/)
    assert.ok(existsSync(join(dir, 'Archive', '2026', 'a.pdf')))
    assert.deepEqual(trashed, [])
    const accept = box('acceptEdits', { trash }, { chores: true }, state)
    const del2 = await accept.toolbox.execute('delete_file', { path: 'Archive/2026/a.pdf' }, 'f3')
    assert.match(del2.output ?? '', /to the system trash/)
    assert.equal(trashed.length, 1)
    assert.match(trashed[0]!, /a\.pdf$/)
    const undone = await restoreCheckpoints(dir, [...state.checkpoints.values()])
    assert.deepEqual(undone.skipped, [])
    assert.equal(readFileSync(join(dir, 'Downloads', 'a.pdf'), 'utf8'), 'A')
    assert.equal(readFileSync(join(dir, 'Downloads', 'sub', 'b.pdf'), 'utf8'), 'B')
    assert.ok(!existsSync(join(dir, 'Archive', '2026', 'sub', 'b.pdf')))
  })
})

describe('a round cut off at the output limit (4.0.2)', () => {
  const cutOff: Frame = { choices: [{ delta: {}, finish_reason: 'length' }] }

  test('a write_file cut off mid-arguments is not a finished task: the model is told, and its smaller retry lands', async () => {
    const partial: Frame = {
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'w1', function: { name: 'write_file', arguments: '{"path":"src/big.ts","content":"export const a = 1\nexport const b' } }] } }]
    }
    const { transport, requests } = scripted([
      () => [partial, cutOff],
      () => [call('w2', 'write_file', { path: 'src/big.ts', content: 'export const a = 1\n' })],
      () => [text('Wrote src/big.ts.')]
    ])
    const r = await runAgentTask(spec(transport, { permission: 'acceptEdits', prompt: 'Write src/big.ts.' }), host(transport).host)
    assert.equal(r.status, 'done')
    assert.equal(r.finalText, 'Wrote src/big.ts.')
    const nudge = requests[1]!.messages.at(-1)!
    assert.equal(nudge.role, 'user')
    assert.match(String(nudge.content), /cut off at the output limit/)
    assert.equal(readFileSync(join(dir, 'src', 'big.ts'), 'utf8'), 'export const a = 1\n')
  })

  test('a reply cut off mid-sentence is asked again, its words kept on the history; the recoveries are bounded', async () => {
    const { transport, requests } = scripted([
      () => [text('The fix is to change'), cutOff],
      () => [text('still going'), cutOff],
      () => [text('and again'), cutOff],
      () => [text('Accepted as it stands.')]
    ])
    const r = await runAgentTask(spec(transport, { prompt: 'Explain the bug.' }), host(transport).host)
    assert.equal(r.status, 'done')
    assert.equal(requests.length, 3, 'two recoveries, then the third cut-off round is accepted as the reply')
    assert.deepEqual(
      requests[1]!.messages.slice(-2).map((m) => m.role),
      ['assistant', 'user']
    )
    assert.equal(requests[1]!.messages.at(-2)!.content, 'The fix is to change')
    assert.equal(r.finalText, 'and again')
  })

  test('a round that finishes normally is untouched', async () => {
    const { transport, requests } = scripted([() => [text('All good.')]])
    const r = await runAgentTask(spec(transport, { prompt: 'Say hi.' }), host(transport).host)
    assert.equal(r.status, 'done')
    assert.equal(requests.length, 1)
  })
})

describe('tool calls written as text (v4.1, A1)', () => {
  test('a Hermes <tool_call> in the content runs as a real call', async () => {
    const { transport, requests } = scripted([
      () => [text('<tool_call>\n{"name": "read_file", "arguments": {"path": "src/math.ts"}}\n</tool_call>')],
      () => [text('It subtracts.')]
    ])
    const r = await runAgentTask(spec(transport, { prompt: 'What does add do?' }), host(transport).host)
    assert.equal(r.status, 'done')
    const result = requests[1]!.messages.find((m) => m.role === 'tool')
    assert.match(String(result?.content), /return a - b/)
  })

  test('a text-form call that cannot be read is named to the model, and its retry runs', async () => {
    const { transport, requests } = scripted([
      () => [text('<tool_call>{"name": "read_file", "arguments": {"path": }}</tool_call>')],
      () => [call('c2', 'read_file', { path: 'src/math.ts' })],
      () => [text('It subtracts.')]
    ])
    const r = await runAgentTask(spec(transport, { prompt: 'What does add do?' }), host(transport).host)
    assert.equal(r.status, 'done')
    assert.equal(r.finalText, 'It subtracts.')
    assert.match(String(requests[1]!.messages.at(-1)!.content), /could not be read, so nothing ran/)
  })
})

describe('results cut to their share of the window (v4.1, A3)', () => {
  test('a result that fits is untouched; a longer one keeps head and tail, and the middle is spilled whole', () => {
    const spill = new SpillStore()
    assert.equal(capResult('short', 2_000, spill), 'short')
    const lines = Array.from({ length: 300 }, (_, i) => `${String(i + 1).padStart(5)}\tline ${i + 1} of the file`)
    const out = capResult(lines.join('\n'), 3_000, spill)
    assert.ok(out.length <= 3_000, `${out.length} characters`)
    assert.match(out, /^ {4}1\tline 1 of the file\n/)
    assert.match(out, /line 300 of the file$/)
    const note = /\[… (\d+) lines, [\d,]+ characters cut here to keep the context small — read_spill with id "(spill-1)" returns them, or read_file with offset (\d+) …\]/.exec(out)
    assert.ok(note, out)
    const back = spill.get(note[2]!)!
    assert.equal(back.length, Number(note[1]))
    assert.equal(back[0], lines[Number(note[3]) - 1], 'the offset named is the first line cut')
    // Nothing lost: head + spilled middle + tail is the whole.
    const [head, tail] = out.split(/\n\[….*…\]\n/)
    assert.equal(`${head}\n${back.join('\n')}\n${tail}`, lines.join('\n'))
  })

  test('one enormous line is cut by characters, and read_spill pages through it with the way on', () => {
    const spill = new SpillStore()
    const blob = 'x'.repeat(20_000)
    const out = capResult(blob, 3_000, spill)
    assert.ok(out.length <= 3_000)
    assert.match(out, /read_spill with id "spill-1"/)
    assert.doesNotMatch(out, /read_file with offset/)
    const first = readSpill(spill, { id: 'spill-1' }, 3_000)
    assert.ok(first.ok)
    assert.match(first.output!, /\(spill-1: lines 1–1 of \d+; read on with offset 2\)$/)
    const last = readSpill(spill, { id: 'spill-1', offset: spill.get('spill-1')!.length }, 3_000)
    assert.match(last.output!, /the end\)$/)
    assert.match(readSpill(spill, { id: 'spill-9' }, 3_000).error!, /No cut output has the id "spill-9"/)
    assert.match(readSpill(new SpillStore(), { id: 'spill-1' }, 3_000).error!, /Nothing has been cut/)
  })

  test('a long read reaches the model cut, the record keeps it whole, and read_spill brings the middle back', async () => {
    writeFileSync(join(dir, 'src', 'long.ts'), Array.from({ length: 600 }, (_, i) => `export const v${i + 1} = ${i + 1}`).join('\n'))
    const { transport, requests } = scripted([
      () => [call('c1', 'read_file', { path: 'src/long.ts', limit: 600 })],
      (body) => {
        const cut = String(body.messages.find((m) => m.tool_call_id === 'c1')?.content)
        const id = /read_spill with id "([^"]+)"/.exec(cut)![1]!
        return [call('c2', 'read_spill', { id })]
      },
      () => [text('Read it all.')]
    ])
    const h = host(transport)
    const r = await runAgentTask(spec(transport, { prompt: 'Read src/long.ts.', contextTokens: 16_000 }), h.host)
    assert.equal(r.status, 'done')
    const cap = resultCapChars(historyBudget(16_000))
    const first = String(requests[1]!.messages.find((m) => m.tool_call_id === 'c1')?.content)
    assert.ok(first.length <= cap, `${first.length} > ${cap}`)
    assert.match(first, /export const v1 = 1\n/)
    assert.match(first, /export const v600 = 600$/)
    assert.ok(requests[0]!.tools.includes('read_spill'))
    const end = h.events.find((e) => e.type === 'tool_end' && e.record.id === 'c1')
    assert.ok(end && end.type === 'tool_end' && /v300 = 300/.test(end.record.result ?? ''), 'the record shows the whole read')
    const middle = String(requests[2]!.messages.find((m) => m.tool_call_id === 'c2')?.content)
    assert.match(middle, /export const v300 = 300/)
  })

  test('where eliding is not enough, the recent results are cut harder before any round is dropped, then all but the last set aside', () => {
    const spill = new SpillStore()
    const big = Array.from({ length: 200 }, (_, i) => `row ${i} ${'y'.repeat(40)}`).join('\n')
    const history = (): ApiMessage[] => [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      ...[1, 2, 3, 4].flatMap((n): ApiMessage[] => [
        { role: 'assistant', content: null, tool_calls: [{ id: `c${n}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: `c${n}`, content: big }
      ])
    ]
    // 4.0: the four most recent are never touched, so rounds go, and it is still over.
    const old = history()
    const before = fitContext(old, 2_500, 0)
    assert.equal(before.droppedRounds, 3)
    assert.equal(before.stillOver, true)
    // v4.1: cut harder first — every round stays, and it fits.
    const messages = history()
    const fit = fitContext(messages, 2_500, 0, 1, (t) => capResult(t, 1_500, spill))
    assert.equal(fit.stillOver, false)
    assert.equal(fit.droppedRounds, 0)
    assert.equal(fit.shrunk, 4)
    assert.equal(messages.filter((m) => m.role === 'tool').length, 4)
    assert.match(String(messages.at(-1)!.content), /read_spill with id/)
    // Tighter still, one round with two results: all but the last is set aside.
    const last: ApiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'x1', type: 'function', function: { name: 'grep', arguments: '{}' } }, { id: 'x2', type: 'function', function: { name: 'glob', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'x1', content: big },
      { role: 'tool', tool_call_id: 'x2', content: big }
    ]
    const squeezed = fitContext(last, 700, 0, 1, (t) => capResult(t, 2_000, spill))
    assert.equal(squeezed.elided, 1)
    assert.match(String(last[3]!.content), /^\[Earlier output of grep removed/)
    assert.doesNotMatch(String(last[4]!.content), /^\[Earlier output/)
  })
})
