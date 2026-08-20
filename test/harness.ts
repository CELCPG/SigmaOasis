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
import { tmpdir } from 'os'
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
  /**
   * Per-query search results, checked before `searchHtml`: the first route whose
   * `match` appears in the request URL wins. Real search providers answer
   * different queries with different results, and a fixture that cannot express
   * that forces every sub-question onto the same candidates.
   */
  searchRoutes: { match: string; html: string }[]
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
    /** Report the body as cut short at maxBytes, as the real transport does. */
    truncated?: boolean
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
  /** Full parsed bodies of /chat/completions requests, for asserting request shaping. */
  completionBodies: Record<string, unknown>[]
  /** Make every /chat/completions call throw. */
  failCompletions: boolean
  /** Make the FIRST /chat/completions call return HTTP 400, then recover. */
  completionOnce400: boolean
  /**
   * Model LM Studio's actual behaviour: reject BOTH constrained response
   * formats and serve only unconstrained requests. A grammar collides with a
   * prefilled assistant turn ("Failed to initialize samplers"), and json_object
   * is refused outright — so a caller that steps down only one rung never gets
   * an answer. Measured against a live server, 2026-08-18.
   */
  rejectConstrainedFormats: boolean
  /** `response_format.type` of every /chat/completions call, in order. */
  completionFormats: (string | undefined)[]
  /** Bodies received by /api/v0/models/load, in order. */
  pinCalls: { model?: string; ttl?: number }[]
  /** Bodies received by the legacy /api/v1/models/load, in order. */
  legacyPinCalls: { model?: string }[]
  /** Bodies received by /api/v1/models/unload, in order. */
  unloadCalls: { instance_id?: string }[]
  /** Make /api/v0/models/load return "Unexpected endpoint" (older LM Studio). */
  pinUnavailable: boolean
  /**
   * Status the unknown-route response carries. Real LM Studio builds differ:
   * some 404, and the one measured on 2026-08-12 logs "Unexpected endpoint or
   * method. (POST /api/v0/models/load). Returning 200 anyway" and does exactly
   * that. Simulating only the 404 is how the v1.3–v1.4.1 pin bug went unseen.
   */
  pinUnavailableStatus: number
  /** Make the legacy /api/v1/models/load also return "Unexpected endpoint". */
  pinLegacyUnavailable: boolean
  /** Make both load endpoints refuse with a guardrail-style model_load_failed. */
  pinRefused: boolean
  /** Reported `state` per model id from GET /api/v0/models (default: not-loaded). */
  modelStates: Record<string, string>
  /** Make GET /api/v0/models 404, as older LM Studio builds without the REST API do. */
  catalogUnavailable: boolean
  /** Full override for the GET /api/v0/models `data` array, for capability fields. */
  catalogModels: Record<string, unknown>[] | null
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
  /** Whether the safeStorage stub reports an OS keychain (audit log gating). */
  encryptionAvailable: boolean
  /** Widths passed to nativeImage.resize(), in order — image thumbnailing. */
  resizeWidths: number[]
}

export const state: HarnessState = {
  settings: {},
  searchHtml: '',
  searchRoutes: [],
  searxngJson: { results: [] },
  responses: [],
  failEmbeddings: false,
  fetchLog: [],
  embedCalls: 0,
  externalRequests: [],
  completions: [],
  completionPrompts: [],
  completionBodies: [],
  failCompletions: false,
  completionOnce400: false,
  rejectConstrainedFormats: false,
  completionFormats: [],
  pinCalls: [],
  legacyPinCalls: [],
  unloadCalls: [],
  pinUnavailable: false,
  pinUnavailableStatus: 404,
  pinLegacyUnavailable: false,
  pinRefused: false,
  modelStates: {},
  catalogUnavailable: false,
  catalogModels: null,
  dnsOverrides: {},
  dnsFailures: [],
  encryptionAvailable: true,
  resizeWidths: []
}

export function resetState(): void {
  state.settings = defaultSettings()
  state.searchHtml = ''
  state.searchRoutes = []
  state.searxngJson = { results: [] }
  state.responses = []
  state.failEmbeddings = false
  state.fetchLog = []
  state.embedCalls = 0
  state.externalRequests = []
  state.completions = []
  state.completionPrompts = []
  state.completionBodies = []
  state.failCompletions = false
  state.completionOnce400 = false
  state.rejectConstrainedFormats = false
  state.completionFormats = []
  state.pinCalls = []
  state.legacyPinCalls = []
  state.unloadCalls = []
  state.pinUnavailable = false
  state.pinUnavailableStatus = 404
  state.pinLegacyUnavailable = false
  state.pinRefused = false
  state.modelStates = {}
  state.catalogUnavailable = false
  state.catalogModels = null
  state.dnsOverrides = {}
  state.dnsFailures = []
  state.encryptionAvailable = true
  state.resizeWidths = []
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
    proxy: { mode: 'none', host: '127.0.0.1', port: 9050 },
    audit: { enabled: false, autoPurgeOnQuit: false },
    plan: { maxSteps: 6, confirmPlan: true },
    secondOpinion: { enabled: false, criticSlotId: null },
    // requireProxy defaults false here so the majority of shopping tests
    // exercise the pipeline; the refusal path sets it true explicitly, which is
    // the behavior that must never regress.
    shopping: { requireProxy: false, maxSellers: 4, excludeTierX: true }
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
  extraHeaders: Record<string, string> = {},
  truncated = false
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
    body: null,
    truncated
  }
}

const netStub = {
  auditedFetch: async (
    url: string,
    init: { body?: string; onChunk?: (chunk: Uint8Array) => void } | undefined,
    purpose: string
  ) => {
    state.fetchLog.push({ url, purpose })

    if (url.endsWith('/api/v0/models/load')) {
      if (state.pinUnavailable) {
        return makeResponse(
          '{"error":"Unexpected endpoint or method. (POST /api/v0/models/load)"}',
          'application/json',
          state.pinUnavailableStatus
        )
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
      if (state.catalogUnavailable) {
        return makeResponse('{"error":"Unexpected endpoint or method."}', 'application/json', 404)
      }
      if (state.catalogModels) {
        return makeResponse(JSON.stringify({ data: state.catalogModels }), 'application/json')
      }
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
      const format = (JSON.parse(init!.body!) as { response_format?: { type?: string } })
        .response_format?.type
      state.completionFormats.push(format)
      if (state.rejectConstrainedFormats && format === 'json_schema') {
        return makeResponse(
          '{"error":"Engine protocol predict request returned 400: ' +
            'Failed to initialize samplers: std::exception"}',
          'application/json',
          400
        )
      }
      if (state.rejectConstrainedFormats && format === 'json_object') {
        return makeResponse(
          `{"error":"'response_format.type' must be 'json_schema' or 'text'"}`,
          'application/json',
          400
        )
      }
      if (state.completionOnce400) {
        state.completionOnce400 = false
        return makeResponse(
          '{"error":"response_format json_schema is not supported by this server"}',
          'application/json',
          400
        )
      }
      const body = JSON.parse(init!.body!) as { messages: { content: string }[]; stream?: boolean }
      state.completionPrompts.push(body.messages.map((m) => m.content).join('\n'))
      state.completionBodies.push(body as unknown as Record<string, unknown>)
      const reply = state.completions.shift() ?? ''
      // Streaming callers (research synthesis) accumulate from onChunk rather
      // than the body, so the stub has to actually emit SSE frames — split in
      // two, so a caller that mishandles chunk boundaries fails here.
      if (body.stream) {
        const encoder = new TextEncoder()
        const half = Math.ceil(reply.length / 2)
        const frames = [reply.slice(0, half), reply.slice(half)]
          .filter((part) => part.length > 0)
          .map((part) => `data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n`)
        for (const frame of [...frames, 'data: [DONE]\n']) {
          init?.onChunk?.(encoder.encode(frame))
        }
        return makeResponse('', 'text/event-stream')
      }
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
      const route = state.searchRoutes.find((r) => url.includes(r.match))
      return makeResponse(route ? route.html : state.searchHtml, 'text/html')
    }
    // The SearXNG catch is shaped like any "/search?q=" endpoint, and other
    // hosts use that path too — Nominatim's geocoder among them. Without the
    // exclusion a place lookup silently receives a search-engine payload and
    // the test fails somewhere far from the cause.
    if ((url.includes('search?q=') && !url.includes('nominatim')) || url.includes('8888')) {
      return makeResponse(JSON.stringify(state.searxngJson), 'application/json')
    }
    for (const r of state.responses) {
      if (url.includes(r.match)) {
        return makeResponse(r.body, r.contentType, r.status, r.headers, r.truncated)
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

/**
 * Per-process userData stand-in for modules that persist JSON under
 * app.getPath('userData') (memory.ts). Tests clean up what they write.
 */
const TEST_USER_DATA_DIR = join(tmpdir(), `sigma-oasis-harness-${process.pid}`)

export function testUserDataDir(): string {
  return TEST_USER_DATA_DIR
}

// ---- fake images -------------------------------------------------------------

/**
 * Marker for a synthetic image the nativeImage stub can "decode".
 *
 * Real nativeImage decodes by sniffing the format and re-encodes at whatever
 * size the pixels demand — neither of which a unit test can reproduce or should
 * depend on. So a fake image simply carries its own answers in a header: the
 * width it reports, and how large it encodes to. Bytes without the marker are
 * undecodable, which is exactly how a WebP or AVIF body looks to nativeImage.
 */
const FAKE_IMAGE_MARKER = 'SIGMAFAKEIMG'

export interface FakeImageSpec {
  /** Reported source width, so tests can drive the resize branch. */
  width?: number
  /** Size of the buffer toJPEG() hands back. */
  jpegBytes?: number
  /** Size of the buffer toPNG() hands back. */
  pngBytes?: number
  /** Omit the marker: nativeImage cannot decode it (WebP/AVIF/GIF/corrupt). */
  undecodable?: boolean
  /** Total on-the-wire size, padded out. Defaults to just the header. */
  totalBytes?: number
}

/** Build the body for a stubbed image response. */
export function fakeImageBytes(spec: FakeImageSpec = {}): Buffer {
  const header = spec.undecodable
    ? 'not-a-decodable-image'
    : `${FAKE_IMAGE_MARKER}${JSON.stringify({
        width: spec.width ?? 800,
        jpegBytes: spec.jpegBytes ?? 8 * 1024,
        pngBytes: spec.pngBytes ?? 32 * 1024
      })}`
  const total = Math.max(spec.totalBytes ?? header.length, header.length)
  return Buffer.concat([Buffer.from(header, 'latin1'), Buffer.alloc(total - header.length, 0x41)])
}

function parseFakeImage(buffer: Buffer): Required<Omit<FakeImageSpec, 'undecodable' | 'totalBytes'>> | null {
  const head = buffer.subarray(0, 256).toString('latin1')
  if (!head.startsWith(FAKE_IMAGE_MARKER)) return null
  const end = head.indexOf('}')
  if (end < 0) return null
  try {
    return JSON.parse(head.slice(FAKE_IMAGE_MARKER.length, end + 1))
  } catch {
    return null
  }
}

function fakeNativeImage(spec: ReturnType<typeof parseFakeImage>, width: number): unknown {
  return {
    isEmpty: () => spec === null,
    getSize: () => ({ width, height: width }),
    resize: ({ width: w }: { width: number }) => {
      state.resizeWidths.push(w)
      return fakeNativeImage(spec, w)
    },
    toJPEG: () => Buffer.alloc(spec?.jpegBytes ?? 0),
    toPNG: () => Buffer.alloc(spec?.pngBytes ?? 0)
  }
}

const electronStub = {
  app: {
    getPath: () => TEST_USER_DATA_DIR,
    // workbench.pyodideDir resolves the runtime from here; a directory with no
    // pyodide in it means "runtime not installed", which is the degraded state
    // handler tests want.
    getAppPath: () => TEST_USER_DATA_DIR,
    getVersion: () => '0.9.0-test'
  },
  nativeImage: {
    createFromBuffer: (buffer: Buffer) => {
      const spec = parseFakeImage(buffer)
      return fakeNativeImage(spec, spec?.width ?? 0)
    }
  },
  ipcMain: { handle: () => undefined },
  // Deterministic stand-in for the OS keychain: a reversible, prefixed encoding,
  // so tests can assert that what lands on disk is not plaintext and that
  // decrypt rejects anything not written by the stub.
  safeStorage: {
    isEncryptionAvailable: () => state.encryptionAvailable,
    encryptString: (s: string) => Buffer.from(`enc:${Buffer.from(s, 'utf-8').toString('base64')}`),
    decryptString: (b: Buffer) => {
      const s = b.toString('utf-8')
      if (!s.startsWith('enc:')) throw new Error('safeStorage stub: cannot decrypt')
      return Buffer.from(s.slice(4), 'base64').toString('utf-8')
    }
  },
  // Only reached by the audit export handler, which tests do not invoke.
  dialog: {},
  BrowserWindow: { fromWebContents: () => null }
}

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
      // `./store` from src/main/ipc/*, `../store` from src/main/ipc/toolHandlers/*.
      if (request === './store' || request === '../store') return storeStub
      if (request === './net' || request === '../net') return netStub
    }
    return original.call(this, request, parent, isMain)
  }
}

/** Require a compiled module under test. */
export function load<T = Record<string, unknown>>(name: string): T {
  installStubs()
  return require(join(COMPILED_DIR, name)) as T
}
