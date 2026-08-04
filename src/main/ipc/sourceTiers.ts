/**
 * Source tiering for shopping research.
 *
 * The dominant failure mode of product search is not a weak model — it is that
 * the results are affiliate listicles written to rank rather than to inform.
 * No amount of careful reasoning saves an answer whose inputs are "top 10 best
 * laptops 2026" pages that never touched a laptop.
 *
 * So sources are tiered by *what they are authoritative for*, which is a
 * narrower and more defensible claim than "trusted":
 *
 * - **A — manufacturer.** Authoritative for specifications and part numbers.
 *   Not authoritative for performance claims, battery life, or superlatives.
 * - **B — independent testing.** Authoritative for measured performance.
 *   Not authoritative for price or stock.
 * - **C — retailer listing.** Authoritative for price and availability *at a
 *   timestamp*, and nothing else. Retailer spec tables are frequently stale or
 *   copied wrong, which is why a spec sourced here is still marked tier C.
 * - **D — forums and user reports.** Useful for failure modes and long-term
 *   reliability signals. Not authoritative for anything quantitative.
 * - **X — affiliate listicles and content farms.** Excluded by default.
 *
 * The lists are deliberately readable. A ranking the user cannot inspect is a
 * ranking they cannot disagree with, and this file is the whole ranking.
 */

export type SourceTier = 'A' | 'B' | 'C' | 'D' | 'X'

export interface TierAssignment {
  tier: SourceTier
  /** One line, shown in the UI next to the source. */
  why: string
  /**
   * True when the source earns referral revenue on purchases it recommends.
   * Not disqualifying — some of the best testing outlets are monetized — but
   * the user is told, because it is a real conflict of interest.
   */
  monetized?: boolean
}

/** Suffix match: 'rtings.com' matches 'www.rtings.com' but not 'notrtings.com'. */
function hostMatches(hostname: string, domain: string): boolean {
  const h = hostname.toLowerCase().replace(/^www\./, '')
  return h === domain || h.endsWith(`.${domain}`)
}

/**
 * Outlets that publish testing methodology and measured results. Monetization
 * is recorded rather than used to exclude — Wirecutter and RTINGS both take
 * affiliate revenue and both do real lab work, and pretending otherwise in
 * either direction would be dishonest.
 */
const TIER_B: { domain: string; monetized?: boolean }[] = [
  { domain: 'rtings.com', monetized: true },
  { domain: 'notebookcheck.net' },
  { domain: 'anandtech.com' },
  { domain: 'techpowerup.com' },
  { domain: 'tomshardware.com', monetized: true },
  { domain: 'dpreview.com', monetized: true },
  { domain: 'arstechnica.com', monetized: true },
  { domain: 'consumerreports.org' },
  { domain: 'which.co.uk' },
  { domain: 'nytimes.com', monetized: true }, // Wirecutter
  { domain: 'gamersnexus.net' },
  { domain: 'igorslab.de' },
  { domain: 'displayninja.com' },
  { domain: 'soundguys.com', monetized: true }
]

/** Retailers and marketplaces: price and stock only. */
const TIER_C = [
  'amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.ca', 'amazon.co.jp',
  'bestbuy.com', 'walmart.com', 'target.com', 'newegg.com', 'bhphotovideo.com',
  'adorama.com', 'microcenter.com', 'costco.com', 'ebay.com', 'aliexpress.com',
  'etsy.com', 'backmarket.com', 'currys.co.uk', 'argos.co.uk', 'johnlewis.com',
  'mediamarkt.de', 'otto.de', 'fnac.com', 'bol.com', 'jbhifi.com.au'
]

/** Marketplaces where third-party sellers dominate — counterfeit risk lives here. */
const MARKETPLACES = ['ebay.com', 'aliexpress.com', 'etsy.com', 'amazon.com', 'walmart.com']

const TIER_D = [
  'reddit.com', 'stackexchange.com', 'stackoverflow.com', 'xda-developers.com',
  'news.ycombinator.com', 'quora.com', 'discourse.org'
]

/** Known content farms whose product pages exist to place affiliate links. */
const TIER_X = [
  'top10.com', 'bestreviews.guide', 'consumerchoice.org', 'reviewed-best.com',
  'top10bestproductreviews.com', 'bestproducts.reviews', 'buyersguide.org',
  'top5reviewed.com', 'productreview.guide'
]

/**
 * Listicle shape in the URL itself: "/best-laptops-2026", "/top-10-headphones".
 *
 * Applied only to domains that are otherwise unrecognized. A tier-B outlet also
 * publishes round-ups, and those are still testing-backed; an unknown domain
 * publishing the same shape is overwhelmingly SEO affiliate content.
 */
const LISTICLE_PATH =
  /\/(?:the-)?(?:best|top|cheapest|greatest)[-_/](?:\d+[-_])?[a-z0-9-]*(?:\d{4})?|\/top[-_]?\d+[-_]/i

/**
 * Tier a URL. `brands` lets the caller mark manufacturer sites as tier A: the
 * set of manufacturers is unbounded and cannot be enumerated, but *for a given
 * product* the brand tokens are known — "sony" in the query makes sony.com the
 * manufacturer.
 */
export function tierOf(rawUrl: string, brands: string[] = []): TierAssignment {
  let hostname: string
  let pathname: string
  try {
    const u = new URL(rawUrl)
    hostname = u.hostname
    pathname = u.pathname
  } catch {
    return { tier: 'X', why: 'unparseable URL' }
  }

  const farm = TIER_X.find((d) => hostMatches(hostname, d))
  if (farm) return { tier: 'X', why: 'known affiliate content farm', monetized: true }

  const tested = TIER_B.find((e) => hostMatches(hostname, e.domain))
  if (tested) {
    return {
      tier: 'B',
      why: 'independent testing outlet — measured results',
      monetized: tested.monetized
    }
  }

  const retailer = TIER_C.find((d) => hostMatches(hostname, d))
  if (retailer) {
    return {
      tier: 'C',
      why: MARKETPLACES.includes(retailer)
        ? 'retailer/marketplace — price and stock only; third-party sellers'
        : 'retailer listing — price and stock only'
    }
  }

  // Brand check runs after the retailer list on purpose: "sony" appearing in a
  // query must not promote sony's storefront page on a marketplace to tier A.
  const brand = brands
    .map((b) => b.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter((b) => b.length >= 3)
    .find((b) => hostMatches(hostname, `${b}.com`) || hostname.toLowerCase().includes(b))
  if (brand) {
    return { tier: 'A', why: `manufacturer site — authoritative for specs, promotional for claims` }
  }

  const forum = TIER_D.find((d) => hostMatches(hostname, d))
  if (forum) return { tier: 'D', why: 'forum/user reports — qualitative signal only' }

  if (LISTICLE_PATH.test(pathname)) {
    return { tier: 'X', why: 'listicle-shaped URL on an unrecognized domain', monetized: true }
  }

  return { tier: 'D', why: 'unrecognized source' }
}

/** True when the tier is excluded from candidate discovery by default. */
export function isExcluded(tier: SourceTier): boolean {
  return tier === 'X'
}

/** True when a listing carries elevated counterfeit/grey-market risk. */
export function isMarketplace(rawUrl: string): boolean {
  try {
    const { hostname } = new URL(rawUrl)
    return MARKETPLACES.some((d) => hostMatches(hostname, d))
  } catch {
    return false
  }
}

/** What a tier may be cited for — rendered next to every extracted value. */
export function authoritativeFor(tier: SourceTier): string {
  switch (tier) {
    case 'A':
      return 'specifications'
    case 'B':
      return 'measured performance'
    case 'C':
      return 'price and availability'
    case 'D':
      return 'qualitative reports only'
    case 'X':
      return 'nothing — excluded'
  }
}
