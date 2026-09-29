import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgentTask } from '../src/main/agent/engine'
import { applyEdit } from '../src/main/agent/editMatch'
import { fitContext, DROPPED_NOTE, estimateTokens, LOW_WATER } from '../src/main/agent/context'
import { agentSystemPrompt, loadProjectNotes } from '../src/main/agent/prompts'
import { Toolbox, newTaskState, workspaceToolSchemas } from '../src/main/agent/tools'
import { globToRegExp, resolveInside, WorkspaceError } from '../src/main/agent/workspace'
import { dangerousCommandWarning } from '../src/shared/commandDanger'
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
  const box = (permission: 'ask' | 'acceptEdits' | 'readOnly' = 'acceptEdits', over: Partial<AgentHost> = {}) =>
    new Toolbox({
      root: dir,
      permission,
      host: host(scripted([]).transport, over).host,
      shell: NODE_SHELL,
      commandTimeoutSec: 30,
      state: newTaskState(),
      signal: new AbortController().signal
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

  /** v3.1 (M2): a first look at several files in one round, not one round each. */
  test('read_file: more_paths reads several files in one call; one unreadable file does not sink the rest', async () => {
    const b = box()
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
    const none = await box().execute('read_file', { path: 'nope.ts', more_paths: ['also-nope.ts'] }, 'x')
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
