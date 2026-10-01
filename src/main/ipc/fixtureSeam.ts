/**
 * The research fixture seam — the one hole in the fetch guards, and it is a
 * test seam. In one module with no imports, because the SSRF guard
 * (search/ssrf.ts), the egress chokepoint (net.ts) and the headless renderer
 * (render.ts) all consult it, and the first already imports the second.
 *
 * SIGMA_RESEARCH_FIXTURE_ORIGIN names an exact loopback origin (e.g.
 * http://127.0.0.1:41234) that an eval serves a fixed corpus from, so the whole
 * pipeline — search, fetch, read, synthesize, ground — runs for real against
 * known pages instead of the live web. Unset in the shipped app; an unset seam
 * recognizes nothing. Compared as a whole origin, never a prefix, so it cannot
 * widen.
 *
 * v4.3: SIGMA_RESEARCH_FIXTURE_ALIAS names an exact HTTPS origin that stands for
 * it. The live-world suite handed the model http://127.0.0.1:<port>/… and the
 * model — having read fetch_webpage's own "HTTPS only, private addresses
 * refused" — declined to fetch: 7 of its 8 misses on 2026-10-01 said the
 * results were local pages. With the alias the model is shown an ordinary
 * https URL, and nothing addressed to it leaves the machine: the SSRF guard
 * does not resolve it (isResearchFixtureOrigin), every HTTP request to it is
 * sent to the fixture origin instead (auditedFetch, through
 * throughResearchFixture), and the headless renderer refuses it. Honoured only
 * beside the origin, only when it is https, and as a whole origin.
 */

/** The fixture origin, and its alias when one is set; null when the seam is closed. */
function seam(): { origin: string; alias: string | null } | null {
  const origin = process.env.SIGMA_RESEARCH_FIXTURE_ORIGIN
  if (!origin) return null
  const raw = process.env.SIGMA_RESEARCH_FIXTURE_ALIAS
  let alias: string | null = null
  if (raw) {
    try {
      const u = new URL(raw)
      if (u.protocol === 'https:') alias = u.origin
    } catch {
      alias = null
    }
  }
  return { origin, alias }
}

/** True for the fixture origin and for its alias: the guard admits both without resolving them. */
export function isResearchFixtureOrigin(url: URL): boolean {
  const s = seam()
  return s !== null && (url.origin === s.origin || (s.alias !== null && url.origin === s.alias))
}

/** True for the alias only — what the headless renderer refuses. */
export function isResearchFixtureAlias(url: URL): boolean {
  const s = seam()
  return s !== null && s.alias !== null && url.origin === s.alias
}

/** The URL a request is actually sent to: the fixture origin for the alias, anything else unchanged. */
export function throughResearchFixture(rawUrl: string): string {
  const s = seam()
  if (!s || !s.alias) return rawUrl
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return rawUrl
  }
  if (u.origin !== s.alias) return rawUrl
  return `${s.origin}${u.pathname}${u.search}`
}
