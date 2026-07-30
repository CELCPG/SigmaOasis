/**
 * Test harness for main-process modules.
 *
 * The modules under test are Electron main-process code: they import `electron`
 * and reach the network through net.ts and settings through store.ts. Rather
 * than restructure production code for testability, this intercepts module
 * resolution — the same trick proxyquire and jest use — so the code under test
 * is byte-for-byte the code that ships, with only its three outermost seams
 * replaced.
 *
 * `installStubs()` must run before any module under test is required, so every
 * test file calls it at the top.
 */
import Module from 'module'
import { join } from 'path'

/**
 * Compiled modules under test. scripts/test.sh compiles the project into
 * .test-build/ preserving layout, so from .test-build/test/ the main-process
 * modules sit at ../src/main/ipc/.
 */
const COMPILED_DIR = join(__dirname, '..', 'src', 'main', 'ipc')

// ---- controllable test state -------------------------------------------------

export interface HarnessState {
  settings: Record<string, unknown>
  /** Body returned for a search-provider request. */
  searchHtml: string
  /** Body returned for a SearXNG JSON request. */
  searxngJson: unknown
  /** Bytes returned for a webpage/PDF fetch, keyed by URL substring. */
  responses: {
    match: string
    contentType: string
    body: string | Buffer
    status?: number
    /** Extra response headers, e.g. `location` for a redirect. */
    headers?: Record<string, string>
  }[]
  /** Make every /embeddings call throw. */
  failEmbeddings: boolean
  /** Every auditedFetch call, in order. */
  fetchLog: { url: string; purpose: string }[]
  /** How many /embeddings round-trips have been made. */
  embedCalls: number
  /** Requests reported by the renderer's webRequest filter. */
  externalRequests: Record<string, unknown>[]
  /**
   * Queued /chat/completions replies, consumed in order. The orchestrator makes
   * two model calls per run (plan, then synthesize), so a test scripts both.
   */
  completions: string[]
  /** Every prompt sent to /chat/completions, for asserting what the model saw. */
  completionPrompts: string[]
  /** Make every /chat/completions call throw. */
  failCompletions: boolean
  /** Bodies received by /api/v0/models/load, in order. */
  pinCalls: { model?: string; ttl?: number }[]
  /** Bodies received by the legacy /api/v1/models/load, in order. */
  legacyPinCalls: { model?: string }[]
  /** Bodies received by /api/v1/models/unload, in order. */
  unloadCalls: { instance_id?: string }[]
  /** Make /api/v0/models/load return "Unexpected endpoint" (older LM Studio). */
  pinUnavailable: boolean
  /** Make the legacy /api/v1/models/load also return "Unexpected endpoint". */
  pinLegacyUnavailable: boolean
  /** Make both load endpoints refuse with a guardrail-style model_load_failed. */
  pinRefused: boolean
  /** Reported `state` per model id from GET /api/v0/models (default: not-loaded). */
  modelStates: Record<string, string>
  /**
   * DNS answers per hostname, for search.ts's SSRF guard. Anything not listed
   * resolves to a public address.
   *
   * Stubbed so no test depends on the real resolver: without this, whether a
   * fetch test passes depends on whether the machine is online and whether the
   * hostname in the fixture happens to be registered.
   */
  dnsOverrides: Record<string, { address: string; family: number }[]>
  /** Hostnames that fail to resolve at all. */
  dnsFailures: string[]
}

export const state: HarnessState = {
  settings: {},
  searchHtml: '',
  searxngJson: { results: [] },
  responses: [],
  failEmbeddings: false,
  fetchLog: [],
  embedCalls: 0,
  externalRequests: [],
  completions: [],
  completionPrompts: [],
  failCompletions: false,
  pinCalls: [],
  legacyPinCalls: [],
  unloadCalls: [],
  pinUnavailable: false,
  pinLegacyUnavailable: false,
  pinRefused: false,
  modelStates: {},
  dnsOverrides: {},
  dnsFailures: []
}

export function resetState(): void {
  state.settings = defaultSettings()
  state.searchHtml = ''
  state.searxngJson = { results: [] }
  state.responses = []
  state.failEmbeddings = false
  state.fetchLog = []
  state.embedCalls = 0
  state.externalRequests = []
  state.completions = []
  state.completionPrompts = []
  state.failCompletions = false
  state.pinCalls = []
  state.legacyPinCalls = []
  state.unloadCalls = []
  state.pinUnavailable = false
  state.pinLegacyUnavailable = false
  state.pinRefused = false
  state.modelStates = {}
  state.dnsOverrides = {}
  state.dnsFailures = []
}

function defaultSettings(): Record<string, unknown> {
  return {
    baseUrl: 'http://127.0.0.1:1234/v1',
    workingDirectory: '',
    memory: { autoContext: true, topK: 3, embeddingModel: 'fake-embed' },
    search: {
      provider: 'duckduckgo',
      searxngUrl: 'http://127.0.0.1:8888',
      maxResults: 8,
      confirmBeforeSearch: false,
      useHeadlessRenderer: false
    },
    research: { depth: 'standard', confirmPlan: false },
    proxy: { mode: 'none', host: '127.0.0.1', port: 9050 }
  }
}

// ---- deterministic fake embedder --------------------------------------------

/**
 * Synonyms folded onto a shared dimension. This is what makes it possible to
 * assert that semantic retrieval finds a passage keyword retrieval provably
 * cannot: the query and the passage share meaning but no vocabulary.
 */
const SYNONYMS: Record<string, string> = {
  automobile: 'car', vehicle: 'car', auto: 'car',
  physician: 'doctor', clinician: 'doctor',
  remuneration: 'salary', compensation: 'salary', pay: 'salary'
}

const VOCAB = [
  'car', 'doctor', 'salary', 'rust', 'python', 'memory', 'timeout', 'retry',
  'quantum', 'encryption', 'latency', 'cache', 'invalidation', 'default', 'config'
]

/** Bag-of-words over a fixed vocabulary, with a floor so no vector is all-zero. */
export function fakeEmbed(text: string): number[] {
  const vec = new Array(VOCAB.length).fill(0)
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const i = VOCAB.indexOf(SYNONYMS[word] ?? word)
    if (i >= 0) vec[i] += 1
  }
  return vec.map((v) => v + 0.01)
}

// ---- stubs ------------------------------------------------------------------

function makeResponse(
  body: string | Buffer,
  contentType: string,
  status = 200,
  extraHeaders: Record<string, string> = {}
): unknown {
  const isBuffer = Buffer.isBuffer(body)
  const headers: Record<string, string> = { 'content-type': contentType }
  for (const [k, v] of Object.entries(extraHeaders)) headers[k.toLowerCase()] = v
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => (isBuffer ? body.toString('utf-8') : body),
    json: async () => JSON.parse(isBuffer ? body.toString('utf-8') : body),
    arrayBuffer: async () => (isBuffer ? body : Buffer.from(body)),
    body: null
  }
}

const netStub = {
  auditedFetch: async (url: string, init: { body?: string } | undefined, purpose: string) => {
    state.fetchLog.push({ url, purpose })

    if (url.endsWith('/api/v0/models/load')) {
      if (state.pinUnavailable) {
        return makeResponse('{"error":"Unexpected endpoint or method. (POST /api/v0/models/load)"}', 'application/json', 404)
      }
      if (state.pinRefused) {
        return makeResponse(
          '{"error":{"type":"model_load_failed","message":"Model loading was stopped due to insufficient system resources."}}',
          'application/json',
          400
        )
      }
      state.pinCalls.push(JSON.parse(init!.body!) as { model?: string; ttl?: number })
      return makeResponse(JSON.stringify({ status: 'loaded' }), 'application/json')
    }
    if (url.endsWith('/api/v1/models/load')) {
      if (state.pinLegacyUnavailable) {
        return makeResponse('{"error":"Unexpected endpoint or method. (POST /api/v1/models/load)"}', 'application/json', 404)
      }
      if (state.pinRefused) {
        return makeResponse(
          '{"error":{"type":"model_load_failed","message":"Model loading was stopped due to insufficient system resources."}}',
          'application/json',
          400
        )
      }
      const body = JSON.parse(init!.body!) as { model?: string }
      state.legacyPinCalls.push(body)
      if (body.model) state.modelStates[body.model] = 'loaded'
      return makeResponse(JSON.stringify({ status: 'loaded' }), 'application/json')
    }
    if (url.endsWith('/api/v1/models/unload')) {
      const body = JSON.parse(init!.body!) as { instance_id?: string }
      state.unloadCalls.push(body)
      if (body.instance_id) state.modelStates[body.instance_id] = 'not-loaded'
      return makeResponse(JSON.stringify({ status: 'unloaded' }), 'application/json')
    }
    if (url.endsWith('/api/v0/models')) {
      const ids = new Set(['fake-embed', 'fake-chat', ...Object.keys(state.modelStates)])
      return makeResponse(
        JSON.stringify({
          data: [...ids].map((id) => ({ id, state: state.modelStates[id] ?? 'not-loaded' }))
        }),
        'application/json'
      )
    }
    if (url.endsWith('/embeddings')) {
      if (state.failEmbeddings) throw new Error('simulated embedding failure')
      state.embedCalls += 1
      const inputs = (JSON.parse(init!.body!) as { input: string[] }).input
      return makeResponse(
        JSON.stringify({ data: inputs.map((t, i) => ({ index: i, embedding: fakeEmbed(t) })) }),
        'application/json'
      )
    }
    if (url.endsWith('/chat/completions')) {
      if (state.failCompletions) throw new Error('simulated completion failure')
      const body = JSON.parse(init!.body!) as { messages: { content: string }[] }
      state.completionPrompts.push(body.messages.map((m) => m.content).join('\n'))
      const reply = state.completions.shift() ?? ''
      return makeResponse(
        JSON.stringify({ choices: [{ message: { content: reply } }] }),
        'application/json'
      )
    }
    if (url.endsWith('/models')) {
      return makeResponse(
        JSON.stringify({ data: [{ id: 'fake-embed' }, { id: 'fake-chat' }] }),
        'application/json'
      )
    }
    if (url.includes('duckduckgo')) {
      return makeResponse(state.searchHtml, 'text/html')
    }
    if (url.includes('search?q=') || url.includes('8888')) {
      return makeResponse(JSON.stringify(state.searxngJson), 'application/json')
    }
    for (const r of state.responses) {
      if (url.includes(r.match)) {
        return makeResponse(r.body, r.contentType, r.status, r.headers)
      }
    }
    throw new Error(`harness: unexpected fetch ${url}`)
  },
  isLoopbackHostname: (h: string) => ['localhost', '127.0.0.1', '::1'].includes(h),
  EgressBlockedError: class EgressBlockedError extends Error {},
  recordExternalRequest: (entry: Record<string, unknown>) => {
    state.externalRequests.push(entry)
  },
  originOfUrl: (url: string) => {
    try {
      return new URL(url).origin
    } catch {
      return '(unparseable URL)'
    }
  }
}

/** A routable public address, so the SSRF guard lets fixtures through. */
const PUBLIC_ADDRESS = [{ address: '93.184.216.34', family: 4 }]

const dnsStub = {
  lookup: async (hostname: string) => {
    if (state.dnsFailures.includes(hostname)) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' })
    }
    return state.dnsOverrides[hostname] ?? PUBLIC_ADDRESS
  }
}

const storeStub = {
  getSettings: () => state.settings,
  getBraveApiKey: () => null,
  setBraveApiKey: () => ({ ok: true }),
  braveApiKeyStatus: () => ({ set: false, encrypted: false })
}

const electronStub = { ipcMain: { handle: () => undefined } }

/** `Module._load` is internal, so it is not in @types/node. */
type ModuleLoader = (request: string, parent: { filename?: string } | null, isMain: boolean) => unknown
const moduleInternals = Module as unknown as { _load: ModuleLoader }

let installed = false

/** Patch module resolution. Idempotent, so every test file can call it. */
export function installStubs(): void {
  if (installed) return
  installed = true
  resetState()

  const original = moduleInternals._load
  moduleInternals._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub
    // Only redirect the seams, and only for modules under test — never for the
    // harness's own dependencies or anything in node_modules.
    if (request === 'dns/promises' || request === 'dns') return dnsStub
    if (parent?.filename?.startsWith(COMPILED_DIR)) {
      if (request === './store') return storeStub
      if (request === './net') return netStub
    }
    return original.call(this, request, parent, isMain)
  }
}

/** Require a compiled module under test. */
export function load<T = Record<string, unknown>>(name: string): T {
  installStubs()
  return require(join(COMPILED_DIR, name)) as T
}
