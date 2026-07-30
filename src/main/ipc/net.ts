import { ipcMain } from 'electron'
import { getSettings } from './store'

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
  | 'render' // headless page rendering (filtered in render.ts)
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

function isLoopbackHostname(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)
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
    case 'update':
      // electron-updater talks to GitHub Releases; listed here so the policy
      // is explicit and auditable even though the updater uses its own stack.
      return ['github.com', 'objects.githubusercontent.com']
    case 'webpage':
      // Arbitrary by design — guarded by the SSRF checks in search.ts.
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
 * Allowlist-enforcing, activity-logging replacement for global fetch. All
 * main-process HTTP must go through this (fetch_webpage calls it too, after
 * its own SSRF checks).
 */
export async function auditedFetch(
  url: string,
  init: RequestInit | undefined,
  purpose: NetworkPurpose
): Promise<Response> {
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
    const res = await fetch(url, init)
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
    record({
      at: Date.now(),
      purpose,
      origin: originOf(url),
      method: init?.method ?? 'GET',
      status: null,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    })
    throw err
  }
}

export function registerNetworkHandlers(): void {
  ipcMain.handle('net:getActivity', () => getNetworkActivity())
  ipcMain.handle('net:clearActivity', () => {
    clearNetworkActivity()
    return true
  })
}

// Re-exported so callers can state intent at the call site.
export { isLoopbackHostname }
