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
  responses: { match: string; contentType: string; body: string | Buffer; status?: number }[]
  /** Make every /embeddings call throw. */
  failEmbeddings: boolean
  /** Every auditedFetch call, in order. */
  fetchLog: { url: string; purpose: string }[]
  /** How many /embeddings round-trips have been made. */
  embedCalls: number
}

export const state: HarnessState = {
  settings: {},
  searchHtml: '',
  searxngJson: { results: [] },
  responses: [],
  failEmbeddings: false,
  fetchLog: [],
  embedCalls: 0
}

export function resetState(): void {
  state.settings = defaultSettings()
  state.searchHtml = ''
  state.searxngJson = { results: [] }
  state.responses = []
  state.failEmbeddings = false
  state.fetchLog = []
  state.embedCalls = 0
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
      confirmBeforeSearch: false
    }
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

function makeResponse(body: string | Buffer, contentType: string, status = 200): unknown {
  const isBuffer = Buffer.isBuffer(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => (isBuffer ? body.toString('utf-8') : body),
    json: async () => JSON.parse(isBuffer ? body.toString('utf-8') : body),
    arrayBuffer: async () => (isBuffer ? body : Buffer.from(body)),
    body: null
  }
}

const netStub = {
  auditedFetch: async (url: string, init: { body?: string } | undefined, purpose: string) => {
    state.fetchLog.push({ url, purpose })

    if (url.endsWith('/embeddings')) {
      if (state.failEmbeddings) throw new Error('simulated embedding failure')
      state.embedCalls += 1
      const inputs = (JSON.parse(init!.body!) as { input: string[] }).input
      return makeResponse(
        JSON.stringify({ data: inputs.map((t, i) => ({ index: i, embedding: fakeEmbed(t) })) }),
        'application/json'
      )
    }
    if (url.endsWith('/models')) {
      return makeResponse(JSON.stringify({ data: [{ id: 'fake-embed' }] }), 'application/json')
    }
    if (url.includes('duckduckgo')) {
      return makeResponse(state.searchHtml, 'text/html')
    }
    if (url.includes('search?q=') || url.includes('8888')) {
      return makeResponse(JSON.stringify(state.searxngJson), 'application/json')
    }
    for (const r of state.responses) {
      if (url.includes(r.match)) return makeResponse(r.body, r.contentType, r.status)
    }
    throw new Error(`harness: unexpected fetch ${url}`)
  },
  isLoopbackHostname: (h: string) => ['localhost', '127.0.0.1', '::1'].includes(h),
  EgressBlockedError: class EgressBlockedError extends Error {}
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
