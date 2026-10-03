import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load, readSource, resetState, state } from './harness'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { agentResultsFile, evalAgentConnection } from '../src/main/agent/evalHarness'
import {
  DEFAULT_AGENT_CONNECTION,
  agentConnectionOn,
  checkAgentServer,
  describeRoute,
  normalizeAgentConnection,
  onAgentConnection,
  pickServedModel,
  routeAgent,
  taskDetail
} from '../src/main/agent/connection'
import { runAgentTask } from '../src/main/agent/engine'
import type { AgentHost, ChunkTransport, ShellSpec } from '../src/main/agent/types'
import { agentThinkingProfile } from '../src/renderer/src/lib/modelProfiles'
import { THINK_TAG_MODELS } from '../src/shared/thinking'

/**
 * 4.6 (J1): the agent connection — a second server for the agent alone.
 *
 * Off is the 4.5 agent byte for byte: the route an absent, off or malformed
 * connection gives is the main address and the task's model as given, and the
 * engine's requests through it are the requests it sent before
 * (test/agentRequests.test.ts holds the hashes, unchanged). On, every request
 * goes to the second server with its model — and only there: a server that
 * does not answer, or does not serve the model, is a plain error naming the
 * connection, with nothing sent to LM Studio instead. Embeddings, the pin and
 * the chat stay on LM Studio either way.
 */

const MAIN = 'http://127.0.0.1:1234/v1'
const AGENT = 'http://127.0.0.1:8081/v1'
const NOW = new Date('2026-10-03T12:00:00Z')
const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures', 'catalog')
const fixture = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), 'utf-8'))
const QWEN_MODELS = fixture('llamacpp-qwen3.8-35b-a3b.v1-models.json')
const QWEN_PROPS = fixture('llamacpp-qwen3.8-35b-a3b.props.json')
const GEMMA_MODELS = fixture('llamacpp-gemma-4-26b-a4b.v1-models.json')
const GEMMA_PROPS = fixture('llamacpp-gemma-4-26b-a4b.props.json')
const ON = { enabled: true, baseUrl: AGENT, model: 'qwen3.8-35b-a3b' }

describe('the route', () => {
  test('absent, off or malformed: the main address and the task\'s model, exactly as given', () => {
    const offs: unknown[] = [
      undefined,
      null,
      {},
      { ...ON, enabled: false },
      { ...ON, enabled: 'true' },
      { ...ON, enabled: 1 },
      { enabled: true, baseUrl: '   ', model: 'x' },
      { enabled: true }
    ]
    for (const c of offs) {
      assert.deepEqual(routeAgent(MAIN, c as never, 'qwen3.8-9b-distill'), { via: 'main', baseUrl: MAIN, model: 'qwen3.8-9b-distill' }, JSON.stringify(c))
      assert.equal(agentConnectionOn(c as never), false)
    }
  })

  test('on: the connection\'s address and model, whatever the task\'s slot names', () => {
    assert.deepEqual(routeAgent(MAIN, ON, 'qwen3.8-9b-distill'), { via: 'agent', baseUrl: AGENT, model: 'qwen3.8-35b-a3b' })
    assert.deepEqual(routeAgent(MAIN, { ...ON, model: '  ' }, 'qwen3.8-9b-distill'), { via: 'agent', baseUrl: AGENT, model: '' }, 'no model named: the server\'s, found by the check')
  })

  test('the stored value: on only when written as true; the address on this machine or the default; the default is off', () => {
    assert.deepEqual(normalizeAgentConnection(undefined), DEFAULT_AGENT_CONNECTION)
    assert.deepEqual(DEFAULT_AGENT_CONNECTION, { enabled: false, baseUrl: 'http://127.0.0.1:8080/v1', model: '' })
    assert.deepEqual(normalizeAgentConnection({ enabled: true, baseUrl: ' http://localhost:8081/v1 ', model: ' qwen3.8-35b-a3b ' }), { enabled: true, baseUrl: 'http://localhost:8081/v1', model: 'qwen3.8-35b-a3b' })
    // The main address's loopback rule: a LAN or remote server is not kept, and the switch is not moved.
    for (const away of ['http://10.0.0.10:8081/v1', 'https://example.com/v1', 'ftp://127.0.0.1/v1', 'not a url', 42]) {
      assert.deepEqual(normalizeAgentConnection({ enabled: true, baseUrl: away, model: 'm' }), { enabled: true, baseUrl: DEFAULT_AGENT_CONNECTION.baseUrl, model: 'm' }, String(away))
    }
    assert.equal(normalizeAgentConnection({ enabled: 'yes' }).enabled, false)
    assert.equal(normalizeAgentConnection({ model: 'x'.repeat(500) }).model.length, 200)
  })

  test('the model the server is asked for: the one named when listed, else the first chat model; never another', () => {
    const route = routeAgent(MAIN, ON, 'qwen3.8-9b-distill')
    assert.deepEqual(pickServedModel(route, ['qwen3.8-35b-a3b']), { ok: true, model: 'qwen3.8-35b-a3b' })
    const missing = pickServedModel(route, ['gemma-4-26b-a4b'])
    assert.equal(missing.ok, false)
    assert.match((missing as { error: string }).error, /^The agent connection \(http:\/\/127\.0\.0\.1:8081\/v1, Settings → LM Studio\) does not serve qwen3\.8-35b-a3b \(it lists gemma-4-26b-a4b\)\. The agent does not fall back to LM Studio/)
    const unnamed = { ...route, model: '' }
    assert.deepEqual(pickServedModel(unnamed, ['text-embedding-nomic-embed-text-v1.5', 'qwen3.8-35b-a3b']), { ok: true, model: 'qwen3.8-35b-a3b' }, 'an embedding model is never the agent\'s')
    assert.match((pickServedModel(unnamed, ['text-embedding-nomic-embed-text-v1.5']) as { error: string }).error, /lists no chat model/)
  })

  test('an engine error names the server it came from; on the main connection it is left alone', () => {
    const on = routeAgent(MAIN, ON, 'x')
    assert.equal(onAgentConnection('LM Studio returned HTTP 500: boom', on), `The agent connection's server (${AGENT}) returned HTTP 500: boom`)
    assert.equal(onAgentConnection('fetch failed', on), `On the agent connection (${AGENT}): fetch failed`)
    assert.equal(onAgentConnection('LM Studio returned HTTP 500', routeAgent(MAIN, undefined, 'x')), 'LM Studio returned HTTP 500')
    assert.equal(describeRoute(on), `qwen3.8-35b-a3b on the agent connection (${AGENT})`)
  })

  test('only a failure is said of the server: a pause, a question or a stuck note is the task\'s own (the app, sigma and agent jobs all show this)', () => {
    const on = routeAgent(MAIN, ON, 'x')
    assert.equal(taskDetail({ status: 'error', detail: 'LM Studio went silent for 300 s and the request was cut.' }, on), `The agent connection's server (${AGENT}) went silent for 300 s and the request was cut.`)
    for (const [status, detail] of [
      ['paused', 'Paused after 40 rounds. Say “continue” to let it keep going.'],
      ['paused', 'The agent asks: which file?'],
      ['paused', 'Stopped: 3 failures in a row of run_command. Say how to go on, or “continue” to let it try again.'],
      ['stopped', 'Stopped.']
    ]) {
      assert.equal(taskDetail({ status: status!, detail }, on), detail)
    }
    assert.equal(taskDetail({ status: 'done' }, on), undefined)
    assert.equal(taskDetail({ status: 'error', detail: 'LM Studio returned HTTP 500' }, routeAgent(MAIN, undefined, 'x')), 'LM Studio returned HTTP 500', 'off: as the engine wrote it')
    for (const f of ['ipc/agent.ts', 'ipc/jobs.ts']) assert.match(readSource(join(__dirname, '..', '..', 'src', 'main', f)), /taskDetail\(result, /, f)
    assert.match(readSource(join(__dirname, '..', '..', 'src', 'cli', 'sigma.ts')), /result\.detail = taskDetail\(result, route\)/)
  })
})

describe('the model behaviour the engine picks by name', () => {
  test('the 35B\'s llama-server id is Qwen3, a <think> family — the closed block, as on the 9B', () => {
    const id = QWEN_MODELS.data[0].id as string
    assert.equal(id, 'qwen3.8-35b-a3b', 'the id :8081 serves (recorded)')
    assert.ok(THINK_TAG_MODELS.test(id))
    const p = agentThinkingProfile(id)
    assert.deepEqual([p.family, p.control], ['Qwen3', 'closed-think'])
    assert.deepEqual([agentThinkingProfile('qwen3.8-9b-distill').family, agentThinkingProfile('qwen3.8-9b-distill').control], ['Qwen3', 'closed-think'])
  })

  test('Gemma\'s id keeps its own lever: a capped round, never another family\'s <think> block', () => {
    const id = GEMMA_MODELS.data[0].id as string
    assert.equal(id, 'gemma-4-26b-a4b')
    assert.equal(THINK_TAG_MODELS.test(id), false)
    const p = agentThinkingProfile(id)
    assert.deepEqual([p.family, p.control], ['Gemma 4', 'cap'])
  })
})

// ---- the engine through the route -------------------------------------------

type Frame = Record<string, unknown>
const say = (content: string): Frame => ({ choices: [{ delta: { content } }] })
const call = (id: string, name: string, args: Record<string, unknown>): Frame => ({
  choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }]
})
const SHELL: ShellSpec = process.platform === 'win32' ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c'], name: 'sh' } : { file: '/bin/sh', args: ['-c'], name: 'sh' }

/** Two rounds — a read, then the report — with every request's address and body kept. */
async function wire(spec: { baseUrl: string; model: string }, dir: string): Promise<{ url: string; body: string }[]> {
  const sent: { url: string; body: string }[] = []
  const replies: Frame[][] = [[call('c1', 'read_file', { path: 'src/slice.js' })], [say('It returns a page of items.')]]
  let i = 0
  const transport: ChunkTransport = async (url, init) => {
    sent.push({ url, body: init.body })
    const enc = new TextEncoder()
    for (const f of [...(replies[i++] ?? [say('(out of script)')]), { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } }]) init.onChunk(enc.encode(`data: ${JSON.stringify(f)}\n\n`))
    init.onChunk(enc.encode('data: [DONE]\n\n'))
    return { ok: true, status: 200 }
  }
  const host: AgentHost = { transport, shell: SHELL, emit: () => undefined, reviewEdit: async () => true, approveCommand: async () => 'once' }
  await runAgentTask({ ...spec, workspace: dir, permission: 'acceptEdits', prompt: 'What does slice.js do?', signal: new AbortController().signal, now: NOW }, host)
  return sent
}

describe('the engine\'s requests through the route', () => {
  const folder = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'sigma-agentconn-'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'slice.js'), 'exports.slice = (items, start, size) => items.slice(start, start + size)\n')
    return dir
  }

  test('off: every request is the one the 4.5 spec sends, byte for byte, to LM Studio', async () => {
    const dir = folder()
    try {
      const before = await wire({ baseUrl: MAIN, model: 'qwen3.8-9b-distill' }, dir)
      for (const c of [undefined, { ...ON, enabled: false }]) {
        const route = routeAgent(MAIN, c, 'qwen3.8-9b-distill')
        const after = await wire({ baseUrl: route.baseUrl, model: route.model }, dir)
        assert.deepEqual(after, before)
      }
      assert.equal(before.length, 2)
      assert.ok(before.every((r) => r.url === `${MAIN}/chat/completions`))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('on: every request goes to the agent connection with its model — and differs from the off request in the model\'s name alone', async () => {
    const dir = folder()
    try {
      const off = await wire({ baseUrl: MAIN, model: 'qwen3.8-9b-distill' }, dir)
      const route = routeAgent(MAIN, ON, 'qwen3.8-9b-distill')
      const on = await wire({ baseUrl: route.baseUrl, model: route.model }, dir)
      assert.equal(on.length, 2)
      for (const r of on) {
        assert.equal(r.url, `${AGENT}/chat/completions`)
        assert.equal((JSON.parse(r.body) as { model: string }).model, 'qwen3.8-35b-a3b')
      }
      // Both are Qwen3: the engine's family-picked behaviour is the same, so the bodies are too.
      assert.deepEqual(
        on.map((r) => r.body),
        off.map((r) => r.body.split('"model":"qwen3.8-9b-distill"').join('"model":"qwen3.8-35b-a3b"'))
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---- the app: the check before a task, the egress rule, embeddings ---------

const settingsWith = (agentConnection: Record<string, unknown> | undefined): Record<string, unknown> => ({
  ...state.settings,
  models: [],
  tools: {},
  agent: { maxRounds: 10, roundMaxTokens: 16_384, commandTimeoutSec: 60, defaultPermission: 'ask', appTools: false, notify: false, experiments: {} },
  ...(agentConnection ? { agentConnection } : {})
})

/** :8081 as recorded: a llama-server, so no /api/v0, then /v1/models and /props. */
function serve35B(): void {
  state.catalogUnavailable = true
  state.v1ModelsBody = QWEN_MODELS
  state.propsResponse = { status: 200, body: QWEN_PROPS }
}

describe('the check before an agent task in the app (ipc/agentRoute.ts)', () => {
  const { prepareAgentRoute } = load<typeof import('../src/main/ipc/agentRoute')>('agentRoute')
  beforeEach(() => resetState())

  test('off: the main route, and nothing asked of anyone', async () => {
    state.settings = settingsWith({ ...ON, enabled: false })
    assert.deepEqual(await prepareAgentRoute('qwen3.8-9b-distill'), { ok: true, route: { via: 'main', baseUrl: MAIN, model: 'qwen3.8-9b-distill' } })
    assert.deepEqual(state.fetchLog, [])
  })

  test('on: the 35B\'s catalog read from :8081 by 4.5\'s llama-server reader — its model, and the per-request window (98,304)', async () => {
    state.settings = settingsWith({ ...ON, model: '' })
    serve35B()
    const r = await prepareAgentRoute('qwen3.8-9b-distill')
    assert.deepEqual(r, { ok: true, route: { via: 'agent', baseUrl: AGENT, model: 'qwen3.8-35b-a3b' }, contextTokens: 98_304 })
    assert.ok(state.fetchLog.length > 0)
    for (const f of state.fetchLog) {
      assert.ok(f.url.startsWith('http://127.0.0.1:8081/'), f.url)
      assert.equal(f.purpose, 'lmstudio')
    }
    assert.ok(state.fetchLog.some((f) => f.url === `${AGENT}/models`))
    assert.ok(state.fetchLog.some((f) => f.url === 'http://127.0.0.1:8081/props'))
  })

  test('on, Gemma\'s server: its model and window, read with GETs only', async () => {
    state.settings = settingsWith({ enabled: true, baseUrl: 'http://127.0.0.1:8084/v1', model: 'gemma-4-26b-a4b' })
    state.catalogUnavailable = true
    state.v1ModelsBody = GEMMA_MODELS
    state.propsResponse = { status: 200, body: GEMMA_PROPS }
    const r = await prepareAgentRoute('qwen3.8-9b-distill')
    assert.deepEqual(r, { ok: true, route: { via: 'agent', baseUrl: 'http://127.0.0.1:8084/v1', model: 'gemma-4-26b-a4b' }, contextTokens: 65_536 })
    assert.equal(state.completionBodies.length, 0)
  })

  test('on, the model is not there: a plain error naming the connection', async () => {
    state.settings = settingsWith({ ...ON, model: 'qwen3.8-9b-distill' })
    serve35B()
    const r = await prepareAgentRoute('qwen3.8-9b-distill')
    assert.equal(r.ok, false)
    assert.match((r as { error: string }).error, /^The agent connection \(http:\/\/127\.0\.0\.1:8081\/v1, Settings → LM Studio\) does not serve qwen3\.8-9b-distill \(it lists qwen3\.8-35b-a3b\)\. The agent does not fall back to LM Studio/)
  })

  test('on, the server is down: a plain error naming the connection, and nothing else asked', async () => {
    state.settings = settingsWith(ON)
    state.refusedOrigins = ['http://127.0.0.1:8081']
    const r = await prepareAgentRoute('qwen3.8-9b-distill')
    assert.equal(r.ok, false)
    assert.match((r as { error: string }).error, /^The agent connection \(http:\/\/127\.0\.0\.1:8081\/v1, Settings → LM Studio\) did not answer: connect ECONNREFUSED 127\.0\.0\.1:8081\. The agent does not fall back to LM Studio: start that server, or turn the agent connection off\.$/)
    assert.ok(state.fetchLog.every((f) => f.url.startsWith('http://127.0.0.1:8081/')))
  })
})

describe('an agent task in the app, end to end (ipc/agent.ts)', () => {
  const agent = load<typeof import('../src/main/ipc/agent')>('agent')
  beforeEach(() => resetState())

  type Payload = { event: { type: string; status?: string; detail?: string } }
  const sender = (events: Payload[]): Electron.WebContents =>
    ({ id: 7, isDestroyed: () => false, send: (_channel: string, payload: Payload) => events.push(payload) }) as unknown as Electron.WebContents
  const request = (n: number): import('../src/main/ipc/agent').AgentRunRequest => ({
    taskId: `t${n}`,
    conversationId: `c${n}`,
    messageId: `m${n}`,
    title: 'Say done',
    prompt: 'Say done.',
    workspace: null,
    permission: 'readOnly',
    model: 'qwen3.8-9b-distill'
  })
  const finished = async (events: Payload[]): Promise<Payload['event']> => {
    for (let i = 0; i < 200; i++) {
      const f = events.find((e) => e.event.type === 'final')
      if (f) return f.event
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error('the task never ended')
  }

  test('off: LM Studio, the slot\'s model, the pin — the 4.5 task; the answer is the 4.5 answer', async () => {
    state.settings = settingsWith(undefined)
    state.completions = ['Done.']
    const events: Payload[] = []
    const answer = agent.acceptAgentRun(sender(events), request(1))
    assert.deepEqual(answer, { ok: true }, 'answered at once, not after a check')
    assert.equal((await finished(events)).status, 'done')
    const chats = state.fetchLog.filter((f) => f.url.endsWith('/chat/completions'))
    assert.ok(chats.length > 0 && chats.every((f) => f.url === `${MAIN}/chat/completions`))
    assert.equal(state.completionBodies[0]!.model, 'qwen3.8-9b-distill')
    assert.ok(state.fetchLog.some((f) => f.url.endsWith('/models/load')), 'the slot\'s model is pinned in LM Studio, as before')
  })

  test('on: every request to :8081 with the 35B, no pin, nothing to LM Studio; the answer names the model and the address', async () => {
    state.settings = settingsWith({ ...ON, model: '' })
    serve35B()
    state.completions = ['Done.']
    const events: Payload[] = []
    const answer = await agent.acceptAgentRun(sender(events), request(2))
    assert.deepEqual(answer, { ok: true, model: 'qwen3.8-35b-a3b', connection: AGENT })
    assert.equal((await finished(events)).status, 'done')
    const chats = state.fetchLog.filter((f) => f.url.endsWith('/chat/completions'))
    assert.ok(chats.length > 0 && chats.every((f) => f.url === `${AGENT}/chat/completions`))
    assert.ok(state.completionBodies.every((b) => b.model === 'qwen3.8-35b-a3b'))
    assert.ok(!state.fetchLog.some((f) => f.url.includes(':1234')), state.fetchLog.map((f) => f.url).join(', '))
    assert.ok(!state.fetchLog.some((f) => f.url.includes('/models/load') || f.url.includes('/models/unload')), 'Sigma never loads or unloads on the agent connection')
  })

  test('on, the server is down: refused before it starts, in words naming the connection — no request to LM Studio, no task', async () => {
    state.settings = settingsWith(ON)
    state.refusedOrigins = ['http://127.0.0.1:8081']
    const events: Payload[] = []
    const answer = await agent.acceptAgentRun(sender(events), request(3))
    assert.equal(answer.ok, false)
    assert.match(answer.error ?? '', /^The agent connection \(http:\/\/127\.0\.0\.1:8081\/v1, Settings → LM Studio\) did not answer/)
    assert.equal(events.length, 0)
    assert.ok(!state.fetchLog.some((f) => f.url.endsWith('/chat/completions') || f.url.includes(':1234')))
  })

  test('on, the server fails mid-task: the task\'s error names the agent connection, not LM Studio', async () => {
    state.settings = settingsWith(ON)
    serve35B()
    state.failCompletions = true
    const events: Payload[] = []
    const answer = await agent.acceptAgentRun(sender(events), request(4))
    assert.equal(answer.ok, true)
    const final = await finished(events)
    assert.equal(final.status, 'error')
    assert.match(final.detail ?? '', /agent connection/)
    assert.doesNotMatch(final.detail ?? '', /LM Studio/)
  })
})

describe('a scheduled agent job (C5) runs where the agent runs', () => {
  const jobs = load<typeof import('../src/main/ipc/jobs')>('jobs')
  beforeEach(() => resetState())

  const run = async (agentConnection: Record<string, unknown> | undefined): Promise<{ outcome: string; note: string }> => {
    const dir = mkdtempSync(join(tmpdir(), 'sigma-agentconn-job-'))
    try {
      const base = settingsWith(agentConnection) as { agent: Record<string, unknown> }
      state.settings = { ...base, agent: { ...base.agent, experiments: { agentJobs: true } } }
      state.completions = ['Nothing to report.']
      const r = await jobs.SHIPPED_RUNNERS.agent({
        id: 'j1',
        kind: 'agent',
        title: 'Look over the folder',
        interval: 'daily',
        args: { folder: dir, prompt: 'Summarize.', modelId: 'qwen3.8-9b-distill' },
        enabled: true,
        nextAt: 0,
        failures: 0,
        digestConversationId: 'job-1',
        createdAt: 0
      })
      return { outcome: r.outcome, note: r.note }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // (The pin itself is not asserted here: modelPin remembers a model it pinned
  // earlier in this process, and the end-to-end test above pinned this one.)
  test('off: LM Studio and the job\'s model, as before', async () => {
    assert.equal((await run(undefined)).outcome, 'ok')
    const chats = state.fetchLog.filter((f) => f.url.endsWith('/chat/completions'))
    assert.ok(chats.length > 0 && chats.every((f) => f.url === `${MAIN}/chat/completions`))
    assert.equal(state.completionBodies[0]!.model, 'qwen3.8-9b-distill')
  })

  test('on: the agent connection and its model, no pin; down, the job fails in words naming it', async () => {
    serve35B()
    assert.equal((await run(ON)).outcome, 'ok')
    assert.ok(state.completionBodies.length > 0 && state.completionBodies.every((b) => b.model === 'qwen3.8-35b-a3b'))
    assert.ok(!state.fetchLog.some((f) => f.url.includes(':1234') || f.url.endsWith('/models/load')))

    resetState()
    state.refusedOrigins = ['http://127.0.0.1:8081']
    const down = await run(ON)
    assert.equal(down.outcome, 'failed')
    assert.match(down.note, /^The agent connection \(http:\/\/127\.0\.0\.1:8081\/v1, Settings → LM Studio\) did not answer/)
    assert.equal(state.completionBodies.length, 0)
  })
})

describe('eval:agent through the agent connection', () => {
  test('EVAL_AGENT_BASE_URL builds the connection the app would; off this machine is refused, not replaced', () => {
    assert.deepEqual(evalAgentConnection({}), { ok: true })
    assert.deepEqual(evalAgentConnection({ EVAL_AGENT_BASE_URL: ' http://127.0.0.1:8081/v1 ', EVAL_AGENT_MODEL: 'qwen3.8-35b-a3b' }), {
      ok: true,
      connection: { enabled: true, baseUrl: 'http://127.0.0.1:8081/v1', model: 'qwen3.8-35b-a3b' }
    })
    assert.deepEqual(evalAgentConnection({ EVAL_AGENT_BASE_URL: 'http://127.0.0.1:8081/v1' }), { ok: true, connection: { enabled: true, baseUrl: 'http://127.0.0.1:8081/v1', model: '' } })
    assert.match((evalAgentConnection({ EVAL_AGENT_BASE_URL: 'http://10.0.0.10:8081/v1' }) as { error: string }).error, /^Refusing EVAL_AGENT_BASE_URL=http:\/\/10\.0\.0\.10:8081\/v1/)
    assert.match((evalAgentConnection({ EVAL_AGENT_MODEL: 'qwen3.8-35b-a3b' }) as { error: string }).error, /set EVAL_AGENT_BASE_URL too/)
  })

  test('the results file records the connection only when the run took it — every other file keeps its 4.5 shape', () => {
    const base = { model: 'qwen3.8-35b-a3b', experiments: {}, baseUrl: AGENT, shell: 'sh', startedAt: 's', passes: 1, cases: ['chain-csv-totals'], runs: [] }
    assert.equal('connection' in agentResultsFile(base), false)
    const connection = { via: 'agent' as const, baseUrl: AGENT, model: 'qwen3.8-35b-a3b', mainBaseUrl: MAIN }
    assert.deepEqual(agentResultsFile({ ...base, connection }).connection, connection)
  })

  test('the check over plain HTTP (sigma, eval:agent): the served model, a missing one, a server that is down', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'qwen3.8-35b-a3b' }] }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    try {
      const conn = { enabled: true, baseUrl: url, model: '' }
      assert.deepEqual(await checkAgentServer(routeAgent(MAIN, conn, 'x')), { ok: true, route: { via: 'agent', baseUrl: url, model: 'qwen3.8-35b-a3b' } })
      const missing = await checkAgentServer(routeAgent(MAIN, { ...conn, model: 'gemma-4-26b-a4b' }, 'x'))
      assert.match((missing as { error: string }).error, /does not serve gemma-4-26b-a4b \(it lists qwen3\.8-35b-a3b\)/)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    }
    // Refused, or — a pooled keep-alive socket to the server just closed — reset.
    const down = await checkAgentServer(routeAgent(MAIN, { enabled: true, baseUrl: url, model: '' }, 'x'))
    assert.match((down as { error: string }).error, new RegExp(`^The agent connection \\(${url.replace(/[.]/g, '\\.')}, Settings → LM Studio\\) did not answer: .*(ECONNREFUSED|ECONNRESET).*\\. The agent does not fall back to LM Studio`))
  })
})

describe('what stays on LM Studio, and the egress rule', () => {
  beforeEach(() => resetState())

  test('embeddings go to the main connection with the agent connection on', async () => {
    state.settings = settingsWith(ON)
    const { embedTexts } = load<typeof import('../src/main/ipc/embeddings')>('embeddings')
    await embedTexts(['tool descriptions are ranked against the task'])
    const embeds = state.fetchLog.filter((f) => f.url.endsWith('/embeddings'))
    assert.ok(embeds.length > 0 && embeds.every((f) => f.url === `${MAIN}/embeddings`))
  })

  test('the model-server allowlist gains the agent connection\'s host only while it is on, and only on this machine', () => {
    const net = load<typeof import('../src/main/ipc/net')>('net')
    state.settings = settingsWith({ enabled: false, baseUrl: 'http://localhost:8081/v1', model: '' })
    assert.deepEqual(net.allowedHosts('lmstudio'), ['127.0.0.1'])
    state.settings = settingsWith({ enabled: true, baseUrl: 'http://localhost:8081/v1', model: '' })
    assert.deepEqual(net.allowedHosts('lmstudio'), ['127.0.0.1', 'localhost'])
    state.settings = settingsWith({ enabled: true, baseUrl: 'http://127.0.0.1:8081/v1', model: '' })
    assert.deepEqual(net.allowedHosts('lmstudio'), ['127.0.0.1'])
    // A value the normalizer would never keep is refused here too.
    state.settings = settingsWith({ enabled: true, baseUrl: 'http://10.0.0.10:8081/v1', model: '' })
    assert.deepEqual(net.allowedHosts('lmstudio'), ['127.0.0.1'])
  })
})
