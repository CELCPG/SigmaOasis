import { ipcMain } from 'electron'
import { getSettings } from './store'
import { isLoopbackHostname } from './loopback'
import { httpRequest } from './httpClient'
import type { HttpResponseLike } from './httpClient'
import { currentProxyConfig, getEgressSession, getLocalSession } from './proxy'

/**
 * Request options accepted by `auditedFetch`. A deliberately small subset of
 * RequestInit — these are the only fields any call site used — plus the transport
 * caps that used to be applied by the caller reading a stream.
 */
export interface AuditedFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  redirect?: 'follow' | 'manual'
  signal?: AbortSignal
  timeoutMs?: number
  /** Gap between response chunks that counts as a dead connection (streaming only). */
  stallTimeoutMs?: number
  maxBytes?: number
  /** Per-chunk callback, so a streaming caller keeps partial output on failure. */
  onChunk?: (chunk: Uint8Array) => void
}

/**
 * Network egress control and auditing.
 *
 * Sigma Oasis's privacy promise is "loopback + the search provider you chose,
 * nothing else" — this module makes that structural rather than aspirational:
 *
 * 1. Every fetch the main process makes goes through `auditedFetch`, which
 *    enforces an allowlist derived from the user's settings and records the
 *    request in a local activity log.
 * 2. The activity log (Settings → Privacy) lets the user see exactly what
 *    left their machine, when, and why.
 * 3. Anything not on the allowlist is blocked before it hits the wire.
 *
 * `fetch_webpage` is the one exception: it fetches arbitrary URLs at the
 * user's direction via a tool call, so it uses the SSRF-guarded path in
 * search.ts instead of the allowlist — and is still logged here.
 */

export type NetworkPurpose =
  | 'lmstudio' // loopback model server: chat, models, embeddings
  | 'search' // the configured search provider
  | 'webpage' // fetch_webpage tool (SSRF-guarded in search.ts)
  | 'shop' // shopping research: retailer/manufacturer product pages
  | 'image' // thumbnail bytes for image_search results
  | 'render' // headless page rendering (filtered in render.ts)
  | 'geo' // place lookups for the geo_locate tool (OpenStreetMap only)
  | 'proxytest' // user-initiated "Test proxy" check only
  | 'update' // opt-in update checks

export interface NetworkActivityEntry {
  /** epoch ms */
  at: number
  purpose: NetworkPurpose
  /** Origin only (scheme + host + port) — never the full URL, so queries and paths stay private even in the log. */
  origin: string
  method: string
  /** HTTP status, or null when the request never completed. */
  status: number | null
  ok: boolean
  /** Set when the request was blocked by the allowlist before sending. */
  blocked?: boolean
  error?: string
}

const MAX_ACTIVITY_ENTRIES = 300
const activity: NetworkActivityEntry[] = []

function record(entry: NetworkActivityEntry): void {
  activity.push(entry)
  if (activity.length > MAX_ACTIVITY_ENTRIES) {
    activity.splice(0, activity.length - MAX_ACTIVITY_ENTRIES)
  }
}

/**
 * Record a request that Chromium made on our behalf rather than one we issued
 * through `auditedFetch`.
 *
 * This exists because the headless renderer is the one component that can reach
 * the network without passing through this module: Chromium's network stack
 * issues its own subresource requests. Without this, the activity log would
 * quietly stop being a complete account of what left the machine — which is the
 * whole basis of the privacy claim. render.ts routes every request its session
 * sees through here, allowed or blocked.
 */
export function recordExternalRequest(entry: Omit<NetworkActivityEntry, 'at'>): void {
  record({ ...entry, at: Date.now() })
}

/** Origin of a URL, for callers outside this module. */
export function originOfUrl(url: string): string {
  return originOf(url)
}

export function getNetworkActivity(): NetworkActivityEntry[] {
  // Newest first for display.
  return [...activity].reverse()
}

export function clearNetworkActivity(): void {
  activity.length = 0
}


function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return '(unparseable URL)'
  }
}

/**
 * Hosts the app is allowed to contact for a given purpose, derived from the
 * current settings. Anything else is refused before a connection is opened.
 */
export function allowedHosts(purpose: NetworkPurpose): string[] {
  const settings = getSettings()
  switch (purpose) {
    case 'lmstudio': {
      try {
        return [new URL(settings.baseUrl).hostname]
      } catch {
        return []
      }
    }
    case 'search': {
      switch (settings.search.provider) {
        case 'searxng':
          try {
            return [new URL(settings.search.searxngUrl).hostname]
          } catch {
            return []
          }
        case 'brave':
          return ['api.search.brave.com']
        case 'duckduckgo':
          return ['html.duckduckgo.com', 'duckduckgo.com', 'api.duckduckgo.com']
      }
      return []
    }
    case 'geo':
      // One host, named explicitly rather than wildcarded. Place lookups say
      // where the user is going, which is at least as revealing as a search
      // query, so this purpose exists to keep them distinguishable in the
      // activity log and impossible to widen by accident.
      return ['nominatim.openstreetmap.org']
    case 'proxytest':
      // A single host, contacted only when the user presses "Test proxy". Listed
      // explicitly so this cannot become a general-purpose escape hatch, and so
      // the one third-party contact the app makes on its own behalf is auditable.
      return ['api.ipify.org']
    case 'update':
      // electron-updater talks to GitHub Releases; listed here so the policy
      // is explicit and auditable even though the updater uses its own stack.
      return ['github.com', 'objects.githubusercontent.com']
    case 'webpage':
      // Arbitrary by design — guarded by the SSRF checks in search.ts.
      return ['*']
    case 'shop':
      // Same guard as 'webpage' — this purpose exists so the activity log
      // distinguishes "a page you asked to read" from "a retailer we contacted
      // on your behalf." Those are different disclosures to the same user.
      return ['*']
    case 'image':
      // Same reasoning again: an image CDN contacted to fill a thumbnail
      // gallery is not "a page you asked to read", and the log should not
      // imply it was. Guarded by the same SSRF checks in search.ts, plus a
      // raster-only content-type allowlist and a hard size cap.
      return ['*']
    case 'render':
      // Arbitrary by design, but far more tightly constrained than 'webpage':
      // render.ts permits only the target page's own origin and refuses every
      // third-party request outright. See the filter in that module.
      return ['*']
  }
}

export class EgressBlockedError extends Error {
  constructor(purpose: NetworkPurpose, url: string) {
    super(
      `Blocked by Sigma Oasis's egress policy: ${originOf(url)} is not an allowed ${purpose} endpoint. ` +
        'Check Settings → Search / Connection, or see Settings → Privacy for the network activity log.'
    )
    this.name = 'EgressBlockedError'
  }
}

/**
 * Translate raw Chromium transport errors into something actionable. The
 * common case by far: a proxy is configured (Tor on 127.0.0.1:9050, say) but
 * nothing is listening, and Chromium's `net::ERR_PROXY_CONNECTION_FAILED`
 * tells the user — and the model that receives it as a tool error — nothing
 * about why or what to do. Say which proxy was tried and where the switch is.
 */
function friendlyTransportError(err: unknown): Error {
  const original = err instanceof Error ? err : new Error(String(err))
  if (!original.message.includes('ERR_PROXY_CONNECTION_FAILED')) return original
  const config = currentProxyConfig()
  if (!config.proxyRules) return original
  return new Error(
    `The configured proxy (${config.description}) refused the connection — nothing is ` +
      `listening there. Start the proxy, or turn it off in Settings → Connection. ` +
      `(${original.message})`
  )
}

/**
 * Allowlist-enforcing, activity-logging replacement for global fetch. All
 * main-process HTTP must go through this (fetch_webpage calls it too, after
 * its own SSRF checks).
 *
 * Transport is Electron's `net` module rather than Node's `fetch`: undici does
 * not consult Electron sessions, so proxy settings would not reach it. See
 * httpClient.ts. The purpose selects the session, and therefore whether the
 * request is proxied — `lmstudio` is pinned to a direct connection, everything
 * outbound goes through the (possibly proxied) egress session.
 */
export async function auditedFetch(
  url: string,
  init: AuditedFetchInit | undefined,
  purpose: NetworkPurpose
): Promise<HttpResponseLike> {
  let hostname = ''
  try {
    hostname = new URL(url).hostname
  } catch {
    record({
      at: Date.now(),
      purpose,
      origin: '(unparseable URL)',
      method: init?.method ?? 'GET',
      status: null,
      ok: false,
      error: 'Unparseable URL'
    })
    throw new Error(`Refusing to fetch unparseable URL: ${url.slice(0, 80)}`)
  }

  const allowed = allowedHosts(purpose)
  if (!allowed.includes('*') && !allowed.includes(hostname)) {
    record({
      at: Date.now(),
      purpose,
      origin: originOf(url),
      method: init?.method ?? 'GET',
      status: null,
      ok: false,
      blocked: true,
      error: 'Blocked by egress allowlist'
    })
    throw new EgressBlockedError(purpose, url)
  }

  try {
    // LM Studio is loopback and must never be proxied; everything else goes out
    // through the session that carries the user's proxy configuration.
    const target =
      purpose === 'lmstudio' ? await getLocalSession() : await getEgressSession()

    const res = await httpRequest(url, {
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
      redirect: init?.redirect,
      signal: init?.signal,
      timeoutMs: init?.timeoutMs,
      stallTimeoutMs: init?.stallTimeoutMs,
      maxBytes: init?.maxBytes,
      onChunk: init?.onChunk,
      session: target
    })
    record({
      at: Date.now(),
      purpose,
      origin: originOf(url),
      method: init?.method ?? 'GET',
      status: res.status,
      ok: res.ok
    })
    return res
  } catch (err) {
    const friendly = friendlyTransportError(err)
    record({
      at: Date.now(),
      purpose,
      origin: originOf(url),
      method: init?.method ?? 'GET',
      status: null,
      ok: false,
      error: friendly.message
    })
    throw friendly
  }
}

/**
 * Verify the proxy actually carries traffic, and report the IP the far side sees.
 *
 * A proxy that is misconfigured fails by simply not being used, which is the one
 * failure mode a privacy control must never have silently. This makes it
 * checkable: if the address differs from an unproxied request, the proxy is
 * genuinely in the path.
 */
async function testProxy(): Promise<{ ok: boolean; detail: string }> {
  const config = currentProxyConfig()
  if (config.error) return { ok: false, detail: config.error }
  if (!config.proxyRules) {
    return { ok: true, detail: 'No proxy configured — traffic goes out directly.' }
  }
  try {
    // A plain-text IP echo, deliberately not a service that profiles the caller.
    const res = await auditedFetch('https://api.ipify.org/', { timeoutMs: 20_000 }, 'proxytest')
    if (!res.ok) return { ok: false, detail: `Proxy reachable but the check returned HTTP ${res.status}.` }
    const address = (await res.text()).trim().slice(0, 64)
    return { ok: true, detail: `${config.description}. Sites see ${address}.` }
  } catch (err) {
    return {
      ok: false,
      detail:
        `Could not reach the internet through ${config.description}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        'Check that the proxy is running and that the host and port are right.'
    }
  }
}

export function registerNetworkHandlers(): void {
  ipcMain.handle('net:getActivity', () => getNetworkActivity())
  ipcMain.handle('net:proxyStatus', () => {
    const config = currentProxyConfig()
    return { mode: config.mode, description: config.description, error: config.error }
  })
  ipcMain.handle('net:testProxy', () => testProxy())
  ipcMain.handle('net:clearActivity', () => {
    clearNetworkActivity()
    return true
  })
}

// Re-exported so callers can state intent at the call site.
export { isLoopbackHostname }  // re-exported for search.ts's SSRF guard
