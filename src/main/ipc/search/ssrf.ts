import { lookup } from 'dns/promises'
import { isLoopbackHostname } from '../net'
import { proxyActive } from '../proxy'

/** IPv4/IPv6 ranges that a fetched page must never resolve to (SSRF guard). */
function isPrivateAddress(address: string, family: number): boolean {
  if (family === 4) {
    const parts = address.split('.').map(Number)
    const [a, b] = parts
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) || // link-local (cloud metadata!)
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      a >= 224 // multicast / reserved
    )
  }
  const lower = address.toLowerCase()
  if (
    lower === '::1' ||
    lower === '::' ||
    lower.startsWith('fe80:') || // link-local
    lower.startsWith('fc') || // unique local fc00::/7
    lower.startsWith('fd')
  ) {
    return true
  }
  // v4-mapped (::ffff:a.b.c.d or ::ffff:aabb:ccdd) — recheck the embedded v4.
  if (lower.startsWith('::ffff:')) return isV4MappedPrivate(lower)
  return false
}

function isV4MappedPrivate(lower: string): boolean {
  const hex = lower.replace('::ffff:', '')
  if (hex.includes('.')) return isPrivateAddress(hex, 4)
  // ::ffff:aabb:ccdd form
  const m = hex.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (!m) return true // can't parse — refuse
  const hi = parseInt(m[1], 16)
  const lo = parseInt(m[2], 16)
  return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 4)
}

/** A hostname written as a bare IP literal, so no resolution is needed to judge it. */
function literalAddress(hostname: string): { address: string; family: number } | null {
  const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(bare)) return { address: bare, family: 4 }
  if (bare.includes(':')) return { address: bare, family: 6 }
  return null
}

/**
 * Refuse anything pointing at a private, loopback, link-local or reserved
 * address — including the LM Studio server itself.
 *
 * ## The tension with proxying
 *
 * Normally this resolves the hostname first and inspects every answer, which is
 * the strongest form of the check. But resolving locally *tells the local
 * resolver which host is about to be visited* — and when the user has configured
 * a proxy precisely so their ISP and resolver learn nothing, doing that lookup
 * would leak the very thing the proxy exists to hide. A SOCKS5 proxy resolves at
 * the far end for exactly this reason.
 *
 * So when a proxy is active the local lookup is skipped, and the check narrows to
 * what can be judged without resolving: literal IP addresses and loopback names.
 * The rest is delegated to the proxy, which is where resolution now happens — Tor
 * refuses private address ranges itself, and the request never touches the local
 * network stack.
 *
 * That is a real, deliberate reduction in SSRF strength, taken because the
 * alternative silently defeats the user's stated intent. It is documented in
 * SECURITY.md rather than left as a surprise.
 */
export async function assertPublicHost(url: URL): Promise<void> {
  const hostname = url.hostname
  if (isResearchFixtureOrigin(url)) return
  if (isLoopbackHostname(hostname)) {
    // Shared by fetch_webpage, shopping and image thumbnails, so the message
    // names the rule rather than one of the three callers.
    throw new Error('Refused: loopback addresses cannot be fetched.')
  }

  // A literal address needs no resolution, so this part of the check always runs.
  const literal = literalAddress(hostname)
  if (literal && isPrivateAddress(literal.address, literal.family)) {
    throw new Error(
      `Refused: "${hostname}" is a private or reserved address (${literal.address}).`
    )
  }

  if (proxyActive()) {
    // Resolution happens at the proxy. Doing it here too would leak the hostname
    // to the local resolver, defeating the point of proxying at all.
    return
  }
  if (literal) return // Already checked, and there is nothing to resolve.

  let addresses: { address: string; family: number }[]
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw new Error(`Could not resolve host "${hostname}".`)
  }
  if (addresses.length === 0) throw new Error(`Could not resolve host "${hostname}".`)
  for (const { address, family } of addresses) {
    if (isPrivateAddress(address, family)) {
      throw new Error(
        `Refused: "${hostname}" resolves to a private or reserved address (${address}).`
      )
    }
  }
}

/**
 * The one hole in the fetch guards, and it is a test seam: SIGMA_RESEARCH_FIXTURE_ORIGIN
 * names an exact loopback origin (e.g. http://127.0.0.1:41234) that the deep
 * research eval serves a fixed corpus from, so the whole pipeline — search,
 * fetch, read, synthesize, ground — runs for real against known pages instead
 * of the live web. Unset in the shipped app; an unset seam recognizes nothing.
 * Compared as a whole origin, never a prefix, so it cannot widen.
 */
export function isResearchFixtureOrigin(url: URL): boolean {
  const seam = process.env.SIGMA_RESEARCH_FIXTURE_ORIGIN
  return Boolean(seam) && url.origin === seam
}
