/**
 * URL hygiene for shopping research.
 *
 * Two jobs, both privacy work:
 *
 * 1. **Unwrap click-redirect hosts.** Search results rarely link to the
 *    destination; they link to a redirector that logs the click first. Following
 *    it costs an extra request to a party that has no business in the
 *    transaction, so the destination is extracted and the redirector is never
 *    contacted.
 * 2. **Strip tracking and affiliate parameters.** A product URL that arrives
 *    tagged carries that tag everywhere it goes next — into the watchlist, into
 *    a markdown export, into whatever the user pastes it into. Removing it once,
 *    at the boundary, is the only place it stays removed.
 *
 * The invariant that matters most is negative and is asserted in the tests:
 * **this module never adds a parameter.** Sigma Oasis takes no referral revenue,
 * so no link it shows may carry an affiliate tag — including one it inherited.
 *
 * Everything here is pure. No settings, no network, no I/O.
 */

/** Whole parameter names removed wherever they appear. */
const TRACKING_PARAMS = new Set(
  [
    // Ad-network click ids
    'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'fbclid', 'twclid',
    'ttclid', 'yclid', 'igshid', 'li_fat_id', 'epik', 's_kwcid', 'srsltid',
    // Affiliate networks
    'irclickid', 'irgwc', 'cjevent', 'sscid', 'clickid', 'affid', 'partner',
    'partnerid', 'ranmid', 'raneaid', 'ransiteid', 'awc', 'zanpid', 'impactid',
    // Retailer affiliate tags
    'tag', 'ascsubtag', 'linkcode', 'linkid', 'creative', 'creativeasin', 'camp',
    // Campaign / email
    'mc_cid', 'mc_eid', 'cm_mmc', 'cm_ven', 'vero_id', 'oly_enc_id', 'oly_anon_id',
    // Referrer breadcrumbs
    'ref', 'ref_src', 'ref_url', 'referrer', 'referer', 'source', 'src',
    // Search-session breadcrumbs that identify the visit, not the product
    'qid', 'sr', 'sprefix', 'crid', '_encoding', 'ie', 'spm', 'scm'
  ].map((p) => p.toLowerCase())
)

/**
 * Parameter name prefixes removed wherever they appear. Prefix rules exist
 * because these families are open-ended: `utm_content`, `utm_term`, and
 * whatever the next campaign tool invents all mean the same thing.
 */
const TRACKING_PREFIXES = ['utm_', 'pd_rd_', 'pf_rd_', 'aff_', 'ran_', '_hs', 'hsa_', 'gad_']

/**
 * Parameters that look disposable but change *which product* is shown. Removing
 * these would silently price the wrong variant, which is worse than carrying a
 * breadcrumb — so the keep-list wins over every rule above.
 */
const VARIANT_PARAMS = new Set(
  ['th', 'psc', 'variant', 'variantid', 'sku', 'color', 'colour', 'size', 'model', 'dwvar'].map(
    (p) => p.toLowerCase()
  )
)

/** Hosts whose only purpose is to log a click and forward. Value = params that may hold the destination. */
const REDIRECT_HOSTS: { host: RegExp; params: string[] }[] = [
  { host: /^(?:html\.)?duckduckgo\.com$/i, params: ['uddg', 'u'] },
  { host: /^(?:www\.)?google\.[a-z.]+$/i, params: ['url', 'q', 'imgurl'] },
  { host: /^(?:www\.)?bing\.com$/i, params: ['u', 'url'] },
  { host: /^(?:www\.)?facebook\.com$/i, params: ['u'] },
  { host: /^(?:out|click|go|link|track|redirect)\.[\w.-]+$/i, params: ['url', 'u', 'to', 'dest', 'target'] },
  { host: /^(?:www\.)?amazon\.[a-z.]+$/i, params: ['location'] }
]

/** How many nested redirectors to unwrap before giving up. */
const MAX_UNWRAP_DEPTH = 4

/**
 * Path segments that are pure tracking, e.g. Amazon's `/ref=nav_search_1`.
 * Matched as whole segments so a legitimate path like `/reference/` survives.
 */
const TRACKING_PATH_SEGMENT = /^(?:ref|ref_)=[^/]*$/i

function isTrackingParam(name: string): boolean {
  const key = name.toLowerCase()
  if (VARIANT_PARAMS.has(key)) return false
  if (TRACKING_PARAMS.has(key)) return true
  return TRACKING_PREFIXES.some((prefix) => key.startsWith(prefix))
}

/**
 * If `url` is a known click-redirector wrapping a destination, return the
 * destination. Recurses, because redirect chains nest (a search result pointing
 * at an affiliate network pointing at the retailer).
 */
export function unwrapRedirect(rawUrl: string, depth = 0): string {
  if (depth >= MAX_UNWRAP_DEPTH) return rawUrl
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return rawUrl
  }

  const entry = REDIRECT_HOSTS.find((r) => r.host.test(url.hostname))
  if (!entry) return rawUrl

  for (const param of entry.params) {
    const value = url.searchParams.get(param)
    if (!value) continue
    // The destination is usually percent-encoded; URL already decoded it once.
    const candidate = value.trim()
    if (!/^https?:\/\//i.test(candidate)) continue
    try {
      // Validate before recursing so a malformed value falls through rather
      // than throwing out of a hygiene function.
      new URL(candidate)
    } catch {
      continue
    }
    return unwrapRedirect(candidate, depth + 1)
  }
  return rawUrl
}

/**
 * Remove tracking and affiliate parameters, and tracking path segments.
 * Parameter order among survivors is preserved — some sites are sensitive to
 * it, and reordering would buy nothing.
 */
export function stripTracking(rawUrl: string): string {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return rawUrl
  }

  const kept: [string, string][] = []
  for (const [name, value] of url.searchParams.entries()) {
    if (!isTrackingParam(name)) kept.push([name, value])
  }
  // Rebuild rather than delete-in-place: deleting while iterating skips entries.
  const params = new URLSearchParams()
  for (const [name, value] of kept) params.append(name, value)
  url.search = params.toString()

  const segments = url.pathname.split('/').filter((s) => !TRACKING_PATH_SEGMENT.test(s))
  // split('/') on a leading-slash path yields a leading '', which rebuilds the
  // slash. A path that was entirely tracking collapses to '/'.
  url.pathname = segments.join('/') || '/'

  return url.toString()
}

/**
 * The boundary function: unwrap the redirector, then strip the tags. Every URL
 * that reaches a fetch, the watchlist, the UI, or an export goes through this.
 *
 * Idempotent by construction — running it twice produces the same string, which
 * the tests assert, because a normalizer that drifts on re-application will
 * eventually corrupt a stored watchlist entry.
 */
export function normalizeProductUrl(rawUrl: string): string {
  return stripTracking(unwrapRedirect(String(rawUrl ?? '').trim()))
}

/**
 * Parameters removed from a URL, for disclosure. The UI can say what it took
 * off rather than quietly rewriting the user's link.
 */
export function removedParams(rawUrl: string): string[] {
  try {
    const before = new URL(unwrapRedirect(rawUrl))
    const after = new URL(normalizeProductUrl(rawUrl))
    const kept = new Set([...after.searchParams.keys()].map((k) => k.toLowerCase()))
    return [...before.searchParams.keys()].filter((k) => !kept.has(k.toLowerCase()))
  } catch {
    return []
  }
}
