/**
 * An MCP client over one stdio transport (v2.5): JSON-RPC correlation, the
 * era probe and both handshakes, `tools/list` with pagination, `tools/call`
 * with a per-call timeout and cancellation.
 *
 * Two eras of server exist and the client has to serve both:
 *
 *   - Modern (revision 2026-07-28 and later): no handshake. Every request
 *     carries the protocol version and the client's capabilities in
 *     `_meta.io.modelcontextprotocol/*`; results carry `resultType`.
 *   - Legacy (2025-11-25 and earlier): an `initialize` handshake followed by
 *     `notifications/initialized`, then plain requests.
 *
 * The era is found by the spec's stdio probe: send `server/discover` with the
 * preferred modern version. A `DiscoverResult` or a recognized modern error
 * (`UnsupportedProtocolVersion`, -32022) means a modern server; any other
 * error, or silence past the timeout, means legacy — the fallback is never
 * keyed to one error code, because legacy servers answer unknown methods
 * with whatever they like, or not at all.
 *
 * What the client will not do, by design (docs/mcp-client-scope.md §6): it
 * declares no client capabilities — no sampling, no elicitation, no roots —
 * so a server cannot make the app's model do work the user did not ask for,
 * and a result whose `resultType` is `input_required` is an error, not a
 * question to answer.
 *
 * Node only. No Electron import; the node suite drives it against
 * test/fixtures/mcp/stub-server.mjs in both eras.
 */
import { spawnTransport, type Transport, type TransportOptions } from './transport'

export const PROTOCOL_VERSION_MODERN = '2026-07-28'
export const PROTOCOL_VERSION_LEGACY = '2025-06-18'
export const CLIENT_INFO = { name: 'sigma-oasis', version: '2.5.0' } as const
export const UNSUPPORTED_PROTOCOL_VERSION = -32022

const META_VERSION = 'io.modelcontextprotocol/protocolVersion'
const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
const META_CLIENT_CAPS = 'io.modelcontextprotocol/clientCapabilities'

export type Era = 'modern' | 'legacy'

export interface McpToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpCallResult {
  ok: boolean
  /** Every text part, joined; non-text parts are named, never dropped silently. */
  text: string
  isError: boolean
}

export interface ClientOptions {
  transport: Omit<TransportOptions, 'onMessage' | 'onExit' | 'onGarbage'>
  /** The probe's silence limit; past it the server is taken to be legacy. */
  probeTimeoutMs?: number
  /** Default per-request timeout. */
  requestTimeoutMs?: number
  onExit?: TransportOptions['onExit']
  /** Server notifications the client does not handle, for the log. */
  onNotification?: (method: string, params: unknown) => void
  onGarbage?: (line: string) => void
}

export interface McpClient {
  /** Probe the era and, for a legacy server, run the handshake. */
  connect: () => Promise<{ era: Era; protocolVersion: string; serverInfo: { name?: string; version?: string } | null }>
  listTools: () => Promise<McpToolDescriptor[]>
  callTool: (name: string, args: Record<string, unknown>, timeoutMs?: number) => Promise<McpCallResult>
  stderr: () => string[]
  readonly era: Era | null
  readonly alive: boolean
  close: () => Promise<void>
}

class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

export class McpTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`${method} did not answer within ${Math.round(ms / 1000)}s`)
    this.name = 'McpTimeoutError'
  }
}

const DEFAULT_PROBE_MS = 5_000
const DEFAULT_REQUEST_MS = 60_000
const HANDSHAKE_MS = 15_000

export function createMcpClient(options: ClientOptions): McpClient {
  let nextId = 1
  const pending = new Map<
    number,
    { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >()
  let era: Era | null = null
  let protocolVersion = PROTOCOL_VERSION_MODERN
  let transport: Transport | null = null

  const failAll = (why: string): void => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer)
      p.reject(new Error(`${p.method}: ${why}`))
      pending.delete(id)
    }
  }

  const onMessage = (raw: unknown): void => {
    const m = raw as { id?: number | string; result?: unknown; error?: { code?: number; message?: string; data?: unknown }; method?: string; params?: unknown }
    if (m && typeof m === 'object' && m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      const p = pending.get(Number(m.id))
      if (!p) return // a late answer to a cancelled or timed-out request
      pending.delete(Number(m.id))
      clearTimeout(p.timer)
      if (m.error) p.reject(new RpcError(m.error.code ?? -1, m.error.message ?? 'error', m.error.data))
      else p.resolve(m.result)
      return
    }
    if (m && typeof m === 'object' && typeof m.method === 'string' && m.id === undefined) {
      options.onNotification?.(m.method, m.params)
      return
    }
    // A server request. The client negotiated no capabilities a server could
    // call on, so any request is out of contract — refused, and logged.
    if (m && typeof m === 'object' && typeof m.method === 'string' && m.id !== undefined) {
      transport?.send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'This client accepts no server requests.' } })
      options.onNotification?.(`refused server request ${m.method}`, m.params)
    }
  }

  const ensureTransport = (): Transport => {
    if (transport && transport.alive) return transport
    transport = spawnTransport({
      ...options.transport,
      onMessage,
      onGarbage: options.onGarbage,
      onExit: (info) => {
        failAll(info.expected ? 'the server was stopped' : `the server exited (code ${info.code ?? 'none'}, signal ${info.signal ?? 'none'})`)
        options.onExit?.(info)
      }
    })
    return transport
  }

  const meta = (): Record<string, unknown> => ({
    [META_VERSION]: protocolVersion,
    [META_CLIENT_INFO]: CLIENT_INFO,
    [META_CLIENT_CAPS]: {}
  })

  const request = (method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<unknown> => {
    const t = ensureTransport()
    const id = nextId++
    const withMeta = era === 'legacy' ? params : { ...(params ?? {}), _meta: { ...((params?._meta as object) ?? {}), ...meta() } }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        // The spec's cancellation: the server must stop and send nothing more.
        t.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'timeout' } })
        reject(new McpTimeoutError(method, timeoutMs))
      }, timeoutMs)
      pending.set(id, { method, resolve, reject, timer })
      t.send({ jsonrpc: '2.0', id, method, ...(withMeta !== undefined ? { params: withMeta } : {}) })
    })
  }

  const notify = (method: string, params?: Record<string, unknown>): void => {
    ensureTransport().send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })
  }

  /** `resultType` absent means complete (older servers); anything but complete is refused. */
  const complete = (result: unknown, method: string): Record<string, unknown> => {
    const r = (result ?? {}) as Record<string, unknown>
    const kind = r.resultType
    if (kind !== undefined && kind !== 'complete') {
      throw new Error(
        kind === 'input_required'
          ? `${method}: the server asked the client for input, which this client does not provide.`
          : `${method}: unrecognised resultType "${String(kind)}".`
      )
    }
    return r
  }

  const connect: McpClient['connect'] = async () => {
    const probeMs = options.probeTimeoutMs ?? DEFAULT_PROBE_MS
    era = null
    protocolVersion = PROTOCOL_VERSION_MODERN
    // The probe goes out with modern metadata whatever the era turns out to be.
    const probe = async (): Promise<{ result?: Record<string, unknown>; error?: RpcError; silent?: boolean }> => {
      try {
        return { result: (await request('server/discover', {}, probeMs)) as Record<string, unknown> }
      } catch (err) {
        if (err instanceof RpcError) return { error: err }
        if (err instanceof McpTimeoutError) return { silent: true }
        throw err
      }
    }
    let outcome = await probe()
    if (outcome.error && outcome.error.code === UNSUPPORTED_PROTOCOL_VERSION) {
      // Modern, but not our preferred version: take one it names and retry.
      const supported = ((outcome.error.data as { supported?: unknown })?.supported ?? []) as unknown[]
      const pick = supported.find((v): v is string => typeof v === 'string')
      if (!pick) throw new Error(`the server supports no protocol version this client knows (it named none).`)
      protocolVersion = pick
      outcome = await probe()
    }
    if (outcome.result) {
      era = 'modern'
      const r = complete(outcome.result, 'server/discover')
      const versions = Array.isArray(r.supportedVersions) ? (r.supportedVersions as unknown[]).filter((v): v is string => typeof v === 'string') : []
      if (versions.length && !versions.includes(protocolVersion)) protocolVersion = versions[0]
      const serverInfo = (r.serverInfo as { name?: string; version?: string } | undefined) ?? null
      return { era, protocolVersion, serverInfo }
    }
    // Any other error, or silence: legacy. Handshake.
    era = 'legacy'
    protocolVersion = PROTOCOL_VERSION_LEGACY
    const init = complete(
      await request(
        'initialize',
        { protocolVersion: PROTOCOL_VERSION_LEGACY, capabilities: {}, clientInfo: { ...CLIENT_INFO } },
        HANDSHAKE_MS
      ),
      'initialize'
    )
    if (typeof init.protocolVersion === 'string') protocolVersion = init.protocolVersion
    notify('notifications/initialized')
    const serverInfo = (init.serverInfo as { name?: string; version?: string } | undefined) ?? null
    return { era, protocolVersion, serverInfo }
  }

  const listTools: McpClient['listTools'] = async () => {
    if (!era) throw new Error('connect() first')
    const out: McpToolDescriptor[] = []
    let cursor: string | undefined
    const seen = new Set<string>()
    for (let page = 0; page < 100; page++) {
      const r = complete(await request('tools/list', cursor ? { cursor } : {}, options.requestTimeoutMs ?? DEFAULT_REQUEST_MS), 'tools/list')
      for (const t of (Array.isArray(r.tools) ? r.tools : []) as Record<string, unknown>[]) {
        if (typeof t.name !== 'string' || !t.name) continue
        if (seen.has(t.name)) continue
        seen.add(t.name)
        out.push({
          name: t.name,
          description: typeof t.description === 'string' ? t.description : '',
          inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? (t.inputSchema as Record<string, unknown>) : { type: 'object', properties: {} }
        })
      }
      cursor = typeof r.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined
      if (!cursor) break
    }
    return out
  }

  const callTool: McpClient['callTool'] = async (name, args, timeoutMs) => {
    if (!era) throw new Error('connect() first')
    const r = complete(
      await request('tools/call', { name, arguments: args }, timeoutMs ?? options.requestTimeoutMs ?? DEFAULT_REQUEST_MS),
      'tools/call'
    )
    const parts = (Array.isArray(r.content) ? r.content : []) as Record<string, unknown>[]
    const texts: string[] = []
    for (const p of parts) {
      if (p.type === 'text' && typeof p.text === 'string') texts.push(p.text)
      else texts.push(`[${String(p.type ?? 'unknown')} content omitted]`)
    }
    if (parts.length === 0 && r.structuredContent && typeof r.structuredContent === 'object') {
      texts.push(JSON.stringify(r.structuredContent))
    }
    const isError = r.isError === true
    return { ok: !isError, text: texts.join('\n'), isError }
  }

  return {
    connect,
    listTools,
    callTool,
    stderr: () => transport?.stderr() ?? [],
    get era() {
      return era
    },
    get alive() {
      return transport?.alive ?? false
    },
    close: async () => {
      failAll('the server was stopped')
      await transport?.close()
    }
  }
}
