import { auditedFetch } from '../net'
import type { AuditedFetchInit } from '../net'
import type { HttpResponseLike } from '../httpClient'
import { getSettings } from '../store'
import { GENERIC_USER_AGENT } from '../userAgent'

// ---- HTTP helpers ------------------------------------------------------------

/** Shared with the headless renderer so the two paths are indistinguishable. */
export const USER_AGENT = GENERIC_USER_AGENT

/** The transport applies the timeout now, so no AbortController is needed here. */
export async function fetchWithTimeout(
  url: string,
  init: AuditedFetchInit | undefined,
  purpose: 'search' | 'webpage' | 'shop' | 'image',
  timeoutMs: number
): Promise<HttpResponseLike> {
  return auditedFetch(url, { ...init, timeoutMs }, purpose)
}

// ---- Refusal hints -----------------------------------------------------------

/**
 * Statuses a bot filter returns to a request it does not like. All three are
 * about *who asked*, not about whether the page exists.
 */
const REFUSAL_STATUSES = new Set([403, 429, 451])

/**
 * Why a page refused us, when the proxy is the likely reason.
 *
 * v1.4.6. A measured session tried two supermarket store-locator pages and got
 * bare `HTTP 403` from both. The model read that as "these sites are
 * unreachable" and wrote the addresses from memory instead — three of seven
 * stops in the resulting route appeared in no source at all.
 *
 * The 403 was correct and the app caused it: outbound web traffic was routed
 * through a SOCKS5 proxy on the loopback Tor port, and both hosts refuse Tor
 * exit nodes. Verified directly — the same two URLs answer 200 without the
 * proxy and 403 through it, while Wikipedia answers 200 either way.
 *
 * So this explains rather than evades. Retrying without the proxy is not on
 * offer at any level: the user turned it on, and quietly stepping around it
 * for a page that would not load is exactly the kind of silent exception that
 * makes a privacy setting worthless. Naming the cause lets the model tell the
 * user what to change, which is the honest version of the same help.
 */
export function proxyRefusalHint(status: number, proxyMode?: string): string {
  const mode = proxyMode ?? getSettings().proxy.mode
  if (mode === 'none' || !REFUSAL_STATUSES.has(status)) return ''
  return (
    ` — refused by the site, not a missing page. Outbound requests are going through your ` +
    `${mode.toUpperCase()} proxy (Settings → Privacy), and many sites, retailers especially, ` +
    `block proxy and Tor exit addresses. Tell the user the page was blocked and that turning ` +
    `the proxy off would likely reach it. Do not fill the gap from memory.`
  )
}

/**
 * Response body as bytes, capped. The cap is applied by the transport (which
 * stops reading and drops the connection), so this only has to slice defensively
 * in case a stub or future transport hands back more than asked for.
 */
export async function readCappedBytes(res: HttpResponseLike, cap: number): Promise<Uint8Array> {
  const buffer = await res.arrayBuffer()
  return new Uint8Array(buffer.byteLength > cap ? buffer.slice(0, cap) : buffer)
}
