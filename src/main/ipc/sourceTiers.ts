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

// ---- general web provenance (v1.5) -------------------------------------------

/**
 * The tiers above answer a product question — manufacturer, tested, retailer —
 * and they do not transfer. Run `tierOf` over a cosmology search and NASA comes
 * back "unrecognized source", which is worse than saying nothing.
 *
 * So general search gets its own, much smaller claim. It is deliberately not a
 * credibility ranking: this app has no business deciding which news outlet to
 * believe, and a list like that would be a political artifact maintained by
 * nobody. It marks only the two ends that can be argued from a URL alone —
 * a source that is the record itself, and a source built to rank rather than
 * to inform — and says nothing at all about the vast middle.
 *
 * The failure it exists for: a v1.4 session researched a stock, and every
 * corroborating source was an SEO domain (spacexstockreview.com,
 * coingabbar.com/price-prediction/…, thechronex.com/how-to-buy-…). No filing,
 * no exchange listing, no wire service appeared, and nothing in the output
 * suggested that the sources had anything in common. The model wrote an
 * investment plan on top of them.
 */
export type Provenance = 'primary' | 'reference' | 'farm' | 'unknown'

export interface ProvenanceAssignment {
  kind: Provenance
  /** Short clause shown next to the result. Empty for `unknown` — no claim. */
  why: string
}

/** Suffixes that are the public record: government, military, accredited academia. */
const PRIMARY_SUFFIXES = ['.gov', '.mil', '.edu', '.gov.uk', '.ac.uk', '.europa.eu', '.int']

/**
 * Registries, standards bodies and scholarly publishers — the record itself
 * rather than reporting about it. Deliberately short: every entry has to be
 * somewhere a claim originates, not somewhere claims are repeated well.
 */
const PRIMARY_DOMAINS = [
  'sec.gov', 'federalregister.gov', 'nasdaq.com', 'nyse.com', 'ecb.europa.eu',
  'bis.org', 'imf.org', 'worldbank.org', 'oecd.org', 'un.org', 'who.int',
  'iso.org', 'ietf.org', 'rfc-editor.org', 'w3.org', 'unicode.org', 'ieee.org',
  'doi.org', 'arxiv.org', 'nature.com', 'science.org', 'jstor.org',
  'sciencedirect.com', 'springer.com', 'esa.int', 'noaa.gov',
  // A rating body is the record for its own ratings, the same way a registry
  // is. Measured: a session spent five searches failing to establish Michelin
  // star counts while guide.michelin.com sat unmarked in every result set, and
  // the answer it finally wrote gave Carbone three stars (it has one) and
  // placed Atelier Crenn — a San Francisco restaurant — on West 75th Street.
  'guide.michelin.com'
]

/** Tertiary summaries. Useful, and explicitly not a source. */
const REFERENCE_DOMAINS = ['wikipedia.org', 'britannica.com', 'wikidata.org', 'wiktionary.org']

/**
 * Publications that employ editors, and are therefore not search-bait however
 * their URLs are shaped.
 *
 * v1.4.6, fixing a false positive this module caused in production. The path
 * heuristics below flag a listicle shape — "/best-restaurants-near-x" — which
 * is a good signal on a domain nothing is known about and a terrible one on a
 * magazine, because that is simply how magazines title service journalism. A
 * measured session searching for restaurants marked **Time Out** and **Eater**
 * as content farms in three consecutive result sets, while the actual farms in
 * the same lists — menu-price aggregators and AI-spun city guides — went
 * unmarked. The check was not merely noisy, it was inverted.
 *
 * This is a narrower claim than "trustworthy", and deliberately so: it says
 * only that a domain is a real publication rather than a page built to rank.
 * Whether any given article is right is a separate question this app does not
 * answer, and the results stay unmarked rather than endorsed.
 */
const EDITORIAL_DOMAINS = [
  'timeout.com', 'eater.com', 'theinfatuation.com', 'nytimes.com', 'washingtonpost.com',
  'theguardian.com', 'bbc.com', 'bbc.co.uk', 'reuters.com', 'apnews.com', 'npr.org',
  'bloomberg.com', 'ft.com', 'wsj.com', 'economist.com', 'newyorker.com', 'theatlantic.com',
  'wired.com', 'arstechnica.com', 'theverge.com', 'bonappetit.com', 'seriouseats.com',
  'epicurious.com', 'food52.com', 'condenast.com', 'cntraveler.com', 'travelandleisure.com',
  'afar.com', 'lonelyplanet.com', 'michelin.com', 'resy.com', 'opentable.com', 'yelp.com',
  'tripadvisor.com', 'zagat.com', 'grubstreet.com', 'nymag.com', 'sfgate.com', 'latimes.com'
]

/**
 * Shapes that mark a page as an aggregator rather than a publication: a
 * hostname built out of the query it wants to rank for.
 *
 * From the same session: menuxp.com, menupedia.us, restaurantmenuprices.org,
 * menuexplor.com, menuwithprices.com, carbonenewyork.gotoeat.net. All exist to
 * republish a restaurant's prices; none marked, while Eater was.
 */
const AGGREGATOR_HOST = /(?:^|\.)(?:menu[a-z]*|[a-z]*menu|restaurantmenu[a-z]*)\.(?:com|us|org|net)$/i

/**
 * Page shapes that exist to capture a search query rather than to report:
 * "/how-to-buy-x", "/price-prediction/", "/complete-guide-to-y".
 *
 * Applied only to domains not otherwise recognized, exactly as LISTICLE_PATH
 * is — a regulator publishing a "how to file" guide is still the regulator.
 */
const SEO_PATH =
  /\/(?:how[-_]to[-_](?:buy|invest|purchase|get)|price[-_]predictions?|(?:complete|ultimate|beginners?|definitive)[-_]guide|[a-z0-9-]*[-_](?:complete|ultimate)[-_]guide)/i

function hasSuffix(hostname: string, suffix: string): boolean {
  return hostname.toLowerCase().endsWith(suffix)
}

/**
 * Classify a general web result. Unknown is the honest and by far the most
 * common answer, and it is reported as nothing at all rather than as a
 * demerit — most of the useful web is unremarkable by URL.
 */
export function provenanceOf(rawUrl: string): ProvenanceAssignment {
  let hostname: string
  let pathname: string
  try {
    const u = new URL(rawUrl)
    hostname = u.hostname.toLowerCase()
    pathname = u.pathname
  } catch {
    return { kind: 'unknown', why: '' }
  }

  // A known farm outranks everything: these domains are the whole point.
  if (TIER_X.some((d) => hostMatches(hostname, d))) {
    return { kind: 'farm', why: 'known affiliate content farm' }
  }

  if (PRIMARY_SUFFIXES.some((s) => hasSuffix(hostname, s))) {
    return { kind: 'primary', why: 'official/academic domain' }
  }
  if (PRIMARY_DOMAINS.some((d) => hostMatches(hostname, d))) {
    return { kind: 'primary', why: 'registry, standards body or scholarly publisher' }
  }
  if (REFERENCE_DOMAINS.some((d) => hostMatches(hostname, d))) {
    return { kind: 'reference', why: 'encyclopedia — a summary of sources, not a source' }
  }
  // Checked before the path heuristics, which is the whole point: a magazine
  // titling a guide "best-restaurants-near-x" is doing its job, not gaming a
  // query, and marking it as bait made the badge actively misleading.
  if (EDITORIAL_DOMAINS.some((d) => hostMatches(hostname, d))) {
    return { kind: 'unknown', why: '' }
  }
  if (AGGREGATOR_HOST.test(hostname)) {
    return { kind: 'farm', why: 'aggregator domain named after the query it ranks for' }
  }
  if (LISTICLE_PATH.test(pathname) || SEO_PATH.test(pathname)) {
    return { kind: 'farm', why: 'search-bait page shape on an unrecognized domain' }
  }
  return { kind: 'unknown', why: '' }
}

/** True when a result should be read last, if at all. */
export function isLowProvenance(rawUrl: string): boolean {
  return provenanceOf(rawUrl).kind === 'farm'
}

/**
 * One line about the shape of a result set, or null when there is nothing worth
 * saying — which is the common case and has to stay quiet. A note on every
 * search is a note the model learns to skip.
 *
 * It speaks only when at least one result is search-bait, and mentions the
 * absence of a primary source only in that company: plenty of good questions
 * have no official source, and saying so every time would be noise.
 */
export function provenanceNote(urls: string[]): string | null {
  const kinds = urls.map((u) => provenanceOf(u).kind)
  const farms = kinds.filter((k) => k === 'farm').length
  if (farms === 0) return null

  const grounded = kinds.some((k) => k === 'primary')
  const all = farms === kinds.length
  const lead = all
    ? `Every result here is search-bait — pages built to rank for this query rather than to report on it.`
    : `${farms} of these ${kinds.length} results ${farms === 1 ? 'is' : 'are'} search-bait, marked below.`
  const missing = grounded
    ? ''
    : ' No primary or official source (regulator, filing, standards body, academic publisher) appeared at all.'
  return (
    `${lead}${missing} Do not treat them as corroborating each other — repetition across ` +
    `SEO pages is not evidence. If a claim rests only on these, say so.`
  )
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
