import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runAgentTask } from '../src/main/agent/engine'
import { agentResultsFile, formatSummary, loadCases, runCase, summarize, type AgentResultsFile, type CaseRun } from '../src/main/agent/evalHarness'
import { diffResults, trimForBaseline } from '../src/main/agent/evalDiff'
import { runToolChoiceEval, type EvalFixtureRun } from '../src/renderer/src/lib/evalRunner'
import { readEvalFixtures } from '../src/main/ipc/evalResults'
import { withGrounding } from '../src/renderer/src/lib/grounding'
import { withBudgetNotes } from '../src/renderer/src/lib/toolSelection'
import { TOOL_SCHEMAS, TOOL_TURN_BUDGETS } from '../src/shared/tools'
import type { ApiMessage, ApiToolCall } from '../src/renderer/src/lib/agentLoop'
import type { AgentHost, ChunkTransport, PermissionMode, ShellSpec, ToolSchema } from '../src/main/agent/types'

/**
 * v4.1 (M6): the offline CI gate. No model, no network — it runs in `npm test`
 * on every CI leg, and alone as `npm run test:replay`.
 *
 * 1. A scripted model is replayed through `eval:agent` and `eval:tools` end to
 *    end — the shipping engine and loop, the runners' own scoring, the results
 *    file in the runners' schema — and the result is diffed by `eval:diff`
 *    against a committed replay baseline. A harness change that moves a score
 *    fails here, before anyone spends a night on a real model.
 * 2. The tool schemas that go on the wire — the agent's toolbox as the engine
 *    sends it, the chat's definitions as a turn sends them — are hashed against
 *    a committed snapshot, so a wire change is a visible diff in review, never
 *    a side effect. S1/S5-class cache breaks start as exactly such a change.
 *
 * Both snapshots are re-recorded deliberately, never by a passing run:
 */
const REPO = join(__dirname, '..', '..')
const REPLAY_DIR = join(REPO, 'test', 'fixtures', 'replay')
const WIRE_SNAPSHOT = join(REPO, 'test', 'fixtures', 'wire', 'tool-schemas.json')
const UPDATE = process.env.UPDATE_REPLAY_SNAPSHOTS === '1'
const HOW = 'If the change is deliberate, re-record with `UPDATE_REPLAY_SNAPSHOTS=1 npm run test:replay` and commit the snapshot with the change — its diff is what review reads.'

/**
 * v4.3: the gate asks a real model for four passes a side and reads every line
 * against a noise band. A scripted model is deterministic — its spread is zero
 * by construction, so its band is zero — and one pass is the whole measurement.
 */
const REPLAY = { minPasses: 1 }

const writeJson = (path: string, data: unknown): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}
const readJson = (path: string): unknown => {
  assert.ok(existsSync(path), `no snapshot at ${path}. ${HOW}`)
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

// ---- 1a. eval:agent, replayed -------------------------------------------------------

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

/** One case of each scoring path: hidden checks, needs-you, read-only. */
const AGENT_SCRIPTS: Record<string, Frame[][]> = {
  'fix-paginate': [
    [call('c1', 'read_file', { path: 'src/paginate.js' })],
    [call('c2', 'edit_file', { path: 'src/paginate.js', old_string: 'start + size - 1', new_string: 'start + size' })],
    [call('c3', 'run_command', { command: 'node --test' })],
    [say('The slice ended one item early. Fixed it in src/paginate.js; all tests pass.')]
  ],
  'needs-you-deploy-token': [
    [call('c1', 'read_file', { path: 'deploy.js' })],
    [say('I could not deploy: deploy.js needs DEPLOY_TOKEN, which is not set here. Ask the release manager for one and set it, then run `npm run deploy`.')]
  ],
  'read-only-free-shipping': [
    [call('c1', 'grep', { pattern: 'FreeShipping' })],
    [say('`qualifiesForFreeShipping` in src/shipping.js: orders of 50.00 or more ship free unless oversized or off the mainland.')]
  ]
}

const NODE_SHELL: ShellSpec =
  process.platform === 'win32'
    ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c'], name: 'cmd.exe' }
    : { file: '/bin/sh', args: ['-c'], name: 'sh' }

async function replayAgent(scripts: Record<string, Frame[][]>, passes: number): Promise<AgentResultsFile> {
  const all = await loadCases(join(REPO, 'test', 'fixtures', 'agent'))
  const cases = Object.keys(scripts).map((id) => {
    const c = all.find((x) => x.id === id)
    assert.ok(c, `no agent case ${id}`)
    return c
  })
  const runs: CaseRun[][] = []
  for (let p = 0; p < passes; p++) {
    const pass: CaseRun[] = []
    for (const c of cases) pass.push(await runCase(c, { baseUrl: 'http://127.0.0.1:1234/v1', model: 'scripted', transport: scripted(scripts[c.id]!), shell: NODE_SHELL }))
    runs.push(pass)
  }
  return agentResultsFile({ model: 'scripted', experiments: {}, baseUrl: 'http://127.0.0.1:1234/v1', shell: 'replay', startedAt: 'replay', passes, cases: cases.map((c) => c.id), runs })
}

/** The committed copy carries scores, not this machine's clock. */
function scrubTiming(file: Record<string, unknown>): Record<string, unknown> {
  const runs = (file.runs as CaseRun[][]).map((pass) =>
    pass.map((r) => {
      const { latencySummary: _s, ...rest } = r
      return { ...rest, ms: 0 }
    })
  )
  return { ...file, runs }
}

describe('eval:agent, replayed offline', () => {
  const baselinePath = join(REPLAY_DIR, 'agent-scripted.json')

  test('the scripted model through the shipping engine and the runner\'s scoring, diffed against the committed replay baseline', async () => {
    const results = await replayAgent(AGENT_SCRIPTS, 2)
    const s = summarize('scripted', results.runs)
    assert.equal(s.solvedMedian, 3, formatSummary([s]))
    assert.equal(s.falseClaims, 0)
    assert.match(formatSummary([s]), /\| scripted \| \*\*3\/3\*\* \| \[3, 3\] \|/)
    if (UPDATE) writeJson(baselinePath, scrubTiming(trimForBaseline(results, 'test/replayGate.test.ts', new Date('2026-09-30T00:00:00Z'))))
    const d = diffResults(readJson(baselinePath), results, REPLAY)
    assert.deepEqual(d.notes, [], `the replay ran other cases than its baseline. ${HOW}`)
    assert.deepEqual(d.regressions, [], `the replay no longer scores as its baseline: ${d.regressions.join('; ')}. ${HOW}`)
    assert.equal(d.verdict, 'SAME-WITHIN-NOISE')
  })

  test('the gate bites: a wrong fix reported as passing fails the diff', async () => {
    const worse = await replayAgent(
      {
        ...AGENT_SCRIPTS,
        'fix-paginate': [
          [call('c1', 'read_file', { path: 'src/paginate.js' })],
          [call('c2', 'edit_file', { path: 'src/paginate.js', old_string: 'start + size - 1', new_string: 'start + size - 2' })],
          [call('c3', 'run_command', { command: 'node --test' })],
          [say('Fixed the slice. All tests pass.')]
        ]
      },
      1
    )
    const d = diffResults(readJson(baselinePath), worse, REPLAY)
    assert.deepEqual(d.lost, ['fix-paginate'])
    assert.equal(d.verdict, 'WORSE')
    assert.deepEqual(
      d.regressions.map((r) => r.replace(/ (fell|rose) from.*/, '')),
      ['solved per pass (3 cases)', 'false claims']
    )
  })
})

// ---- 1b. eval:tools, replayed ---------------------------------------------------------

/** The smallest arguments a schema accepts: its required fields, each the first value its type allows. */
function sampleArgs(parameters: Record<string, unknown>): Record<string, unknown> {
  const p = parameters as { required?: string[]; properties?: Record<string, { type?: string; enum?: unknown[] }> }
  const out: Record<string, unknown> = {}
  for (const key of p.required ?? []) {
    const s = p.properties?.[key] ?? {}
    out[key] = s.enum?.length ? s.enum[0] : s.type === 'number' || s.type === 'integer' ? 1 : s.type === 'boolean' ? true : s.type === 'array' ? [] : s.type === 'object' ? {} : 'x'
  }
  return out
}

/** A model that calls what each fixture expects in round 1 — or, where `miss` names the fixture, answers without a tool. */
function scriptedChooser(prompts: Map<string, string | 'no_tool'>, miss: ReadonlySet<string> = new Set()) {
  return async (_model: string, messages: ApiMessage[], tools: ToolSchema[]): Promise<{ content: string; toolCalls: ApiToolCall[] }> => {
    const user = messages.find((m) => m.role === 'user')?.content ?? ''
    const want = prompts.get(String(user))
    if (messages.some((m) => m.role === 'tool') || want === 'no_tool' || want === undefined || miss.has(String(user))) return { content: 'Here is the answer.', toolCalls: [] }
    const schema = tools.find((t) => t.function.name === want)
    assert.ok(schema, `${want} is not on the wire for "${user}"`)
    return { content: '', toolCalls: [{ id: 'call_1', type: 'function', function: { name: want, arguments: JSON.stringify(sampleArgs(schema.function.parameters)) } }] }
  }
}

describe('eval:tools, replayed offline', () => {
  const dir = join(REPO, 'test', 'fixtures', 'toolchoice')
  const NATIVE = TOOL_SCHEMAS.filter((t) => t.function.name !== 'run_code')
  const fixtures = readEvalFixtures(dir, NATIVE.map((t) => t.function.name))
  const prompts = new Map(fixtures.map((f) => [f.prompt, f.expect === 'no_tool' ? ('no_tool' as const) : f.expect.tool]))
  const replay = async (miss: ReadonlySet<string> = new Set()): Promise<Record<string, unknown>> => {
    const [r] = await runToolChoiceEval({ models: ['scripted'], fixtures, tools: NATIVE, systemPromptFor: () => withGrounding('You are a helpful local assistant.'), complete: scriptedChooser(prompts, miss) })
    return { model: 'scripted', baseUrl: 'replay', ranAt: 'replay', arm: 'full', caveats: ['scripted model'], scores: r!.rates, runs: r!.runs }
  }
  const baselinePath = join(REPLAY_DIR, 'toolchoice-scripted.json')

  test('every fixture loads and names a shipped tool, and a model that chooses right scores clean on all of them', async () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    assert.equal(fixtures.length, files.length, 'a fixture that names no shipped tool is dropped silently by the in-app loader; here it fails')
    const results = await replay()
    const runs = results.runs as EvalFixtureRun[]
    assert.deepEqual(
      runs.filter((r) => r.correct === false || r.spurious || r.looped || r.error || r.allCalls.some((c) => !c.valid)).map((r) => r.file),
      []
    )
    if (UPDATE) writeJson(baselinePath, trimForBaseline(results, 'test/replayGate.test.ts', new Date('2026-09-30T00:00:00Z')))
    const d = diffResults(readJson(baselinePath), results, REPLAY)
    assert.deepEqual(d.notes.filter((n) => n.startsWith('not in the')), [], `the tool-choice fixtures changed since the replay baseline. ${HOW}`)
    assert.deepEqual(d.regressions, [])
  })

  test('the gate bites: a model that answers a search question from memory fails the diff', async () => {
    const miss = fixtures.find((f) => f.expect !== 'no_tool' && f.expect.tool === 'web_search')!
    const d = diffResults(readJson(baselinePath), await replay(new Set([miss.prompt])), REPLAY)
    assert.deepEqual(d.lost, [miss.file])
    assert.equal(d.regressions.length, 1)
  })
})

// ---- 2. the wire, hashed --------------------------------------------------------------

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

interface WireSet {
  sha256: string
  /** Tool name → the first 12 hex digits of its schema's hash, in wire order. */
  tools: Record<string, string>
}

function wireSet(tools: ToolSchema[]): WireSet {
  return { sha256: sha(JSON.stringify(tools)), tools: Object.fromEntries(tools.map((t) => [t.function.name, sha(JSON.stringify(t)).slice(0, 12)])) }
}

/** The tools the engine puts on its first request, as the request body carries them. A fixed shell name: the one platform-dependent word in the toolbox. */
async function agentWireTools(permission: PermissionMode): Promise<ToolSchema[]> {
  const workspace = mkdtempSync(join(tmpdir(), 'sigma-wire-'))
  let tools: ToolSchema[] | null = null
  const host: AgentHost = {
    transport: async (url, init) => {
      tools ??= ((JSON.parse(init.body) as { tools?: ToolSchema[] }).tools ?? [])
      return scripted([[say('Nothing to do.')]])(url, init)
    },
    shell: { file: '/bin/sh', args: ['-c'], name: 'sh' },
    emit: () => undefined,
    reviewEdit: async () => false,
    approveCommand: async () => 'declined'
  }
  try {
    await runAgentTask({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'scripted', workspace, permission, prompt: 'Look around.', signal: new AbortController().signal }, host)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
  assert.ok(tools, 'the engine sent no request')
  return tools
}

test('the tool schemas on the wire match the committed snapshot', async () => {
  const now: Record<string, WireSet> = {
    'agent, acceptEdits': wireSet(await agentWireTools('acceptEdits')),
    'agent, readOnly': wireSet(await agentWireTools('readOnly')),
    'chat, with budget notes': wireSet(withBudgetNotes(TOOL_SCHEMAS, TOOL_TURN_BUDGETS))
  }
  if (UPDATE) writeJson(WIRE_SNAPSHOT, { _: `v4.1 (M6): written by test/replayGate.test.ts. ${HOW}`, ...now })
  const snap = readJson(WIRE_SNAPSHOT) as Record<string, WireSet>
  const problems: string[] = []
  for (const [set, cur] of Object.entries(now)) {
    const was = snap[set]
    if (!was) {
      problems.push(`${set}: not in the snapshot`)
      continue
    }
    if (was.sha256 === cur.sha256) continue
    const names = (o: Record<string, string>): string[] => Object.keys(o)
    const added = names(cur.tools).filter((n) => !(n in was.tools))
    const removed = names(was.tools).filter((n) => !(n in cur.tools))
    const changed = names(cur.tools).filter((n) => n in was.tools && was.tools[n] !== cur.tools[n])
    const kept = names(cur.tools).filter((n) => n in was.tools)
    const reordered = kept.join() !== names(was.tools).filter((n) => n in cur.tools).join()
    problems.push(
      `${set}: ` +
        [added.length ? `added ${added.join(', ')}` : '', removed.length ? `removed ${removed.join(', ')}` : '', changed.length ? `changed ${changed.join(', ')}` : '', reordered ? 'reordered' : '']
          .filter(Boolean)
          .join('; ')
    )
  }
  assert.deepEqual(problems, [], `the tool schemas on the wire changed — every cached prefix after them changes too.\n  ${problems.join('\n  ')}\n${HOW}`)
})
