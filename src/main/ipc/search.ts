import { ipcMain, nativeImage } from 'electron'
import { lookup } from 'dns/promises'
import { homedir } from 'os'
import { auditedFetch, isLoopbackHostname } from './net'
import type { AuditedFetchInit } from './net'
import type { HttpResponseLike } from './httpClient'
import { proxyActive } from './proxy'
import { braveApiKeyStatus, getBraveApiKey, getSettings, setBraveApiKey } from './store'
import type { SearchProviderId } from './store'
import {
  clearResearchIndex,
  getIndexedPage,
  indexPage,
  pageCacheKey,
  researchIndexStats,
  retrievePassages
} from './researchIndex'
import type { PassageOutcome } from './researchIndex'
import { decodeEntities, extractFromHtml, stripTags } from './extract'
import type { ExtractedLink } from './extract'
import { extractPdfText } from './pdf'
import { GENERIC_USER_AGENT } from './userAgent'
import { renderPage } from './render'

/**
 * Privacy-preserving web search and webpage fetching.
 *
 * Provider abstraction: `web_search` is served by whichever provider the user
 * picked in Settings → Search (self-hosted SearXNG, Brave Search API, or
 * DuckDuckGo's HTML endpoint). All providers are reached through the egress
 * allowlist in net.ts, and every request appears in the network activity log.
 *
 * `fetch_webpage` retrieves a single page at the user's direction, with SSRF
 * guards: HTTPS only, DNS-resolved private/loopback ranges refused, manual
 * redirect handling, size and time caps, and script/ad stripping.
 */

export interface SearchResult {
  title: string
  url: string
  snippet: string
  /** Provider-reported publish age/date, when available. */
  published?: string
}

export interface WebSearchOutcome {
  ok: boolean
  provider: SearchProviderId
  results: SearchResult[]
  /** Parts of the query that were redacted before it left the machine. */
  redactions: string[]
  /** The exact query that was sent (after redaction). */
  sentQuery: string
  /** True when results came from the local cache — nothing left the machine. */
  cached?: boolean
  error?: string
}

export interface ImageResult {
  title: string
  /** Full-size image URL. */
  imageUrl: string
  /** Provider-supplied thumbnail URL when there is one. */
  thumbnailUrl?: string
  /** Page the image appears on — where a click should lead. */
  pageUrl: string
}

export interface ImageSearchOutcome {
  ok: boolean
  provider: SearchProviderId
  images: ImageResult[]
  /** Parts of the query that were redacted before it left the machine. */
  redactions: string[]
  /** The exact query that was sent (after redaction). */
  sentQuery: string
  error?: string
}

// ---- Query hygiene -----------------------------------------------------------

/**
 * Patterns that should never leave the machine inside a search query. The
 * model composes queries from conversation context, which may contain personal
 * data or secrets; redact the obvious shapes before anything is sent.
 */
const SENSITIVE_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'email address', re: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  { label: 'API-key-like token', re: /\b(?:sk|pk|api|key|token|secret|bearer)[-_][A-Za-z0-9_-]{16,}\b/gi },
  { label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g },
  { label: 'long hex secret', re: /\b[0-9a-f]{32,}\b/gi },
  // Home-rooted paths: `~/…` or a real user-data root, with at least two
  // segments below it. The segment floor is what separates `/home/colin/notes`
  // (a leak) from `/home/dashboard` (a web route someone is asking about).
  {
    label: 'home directory path',
    re: /(?<![\w.:/-])(?:~|\/(?:Users|home|Volumes|mnt|media|srv))(?:\/[\w .+-]+){2,}/g
  },
  // Classic system paths, where even one segment is meaningful (`/etc/passwd`).
  {
    label: 'system file path',
    re: /(?<![\w.:/-])\/(?:etc|var|tmp|usr|opt|root|proc|sys|dev|private)(?:\/[\w .+-]+)+/g
  },
  { label: 'Windows file path', re: /\b[A-Za-z]:\\(?:[\w .+-]+\\)*[\w .+-]+/g },
  { label: 'private IP address', re: /\b(?:10|127|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2,3}\b/g },
  { label: 'credit-card-like number', re: /\b(?:\d[ -]?){13,19}\b/g }
]

/** Escape a literal string for embedding in a RegExp. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The user's own home and working directories, redacted by exact match.
 *
 * This is the precise version of the path rules above: whatever shape those
 * heuristics miss, an actual local path is still caught because we know what it
 * looks like on this machine. Longest first, so the working directory is
 * replaced before the home directory it usually sits under.
 */
function localPathPatterns(): RegExp[] {
  const roots = [getSettings().workingDirectory.trim(), homedir()]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  // Windows and macOS paths are case-insensitive in practice; matching that way
  // avoids a trivially-cased miss.
  return roots.map((root) => new RegExp(escapeRegExp(root), 'gi'))
}

function sanitizeQuery(query: string): {
  query: string
  redactions: string[]
  /** Set when the query was framing rather than terms; see minimizeQuery. */
  refusal?: string
} {
  const redactions = new Set<string>()
  let cleaned = query

  for (const re of localPathPatterns()) {
    cleaned = cleaned.replace(re, () => {
      redactions.add('local path')
      return '[redacted]'
    })
  }
  for (const { label, re } of SENSITIVE_PATTERNS) {
    cleaned = cleaned.replace(re, () => {
      redactions.add(label)
      return '[redacted]'
    })
  }
  // Collapse whitespace and cap length — queries are requests, not documents.
  cleaned = cleaned.replace(/\s+/g, ' ').trim().slice(0, 400)
  const minimized = minimizeQuery(cleaned)
  if (minimized.dropped) redactions.add('conversational framing')
  return { query: minimized.query, redactions: [...redactions], refusal: minimized.refusal }
}

// ---- Query minimization ------------------------------------------------------

/**
 * First-person framing: the part of a query that describes the *asker* rather
 * than the thing being looked up.
 */
const FIRST_PERSON = /\b(?:i|i'm|im|i've|ive|i'd|my|mine|me|myself|we|we're|our|ours|us)\b/i

/**
 * Openers that introduce a request rather than a subject. Applied repeatedly
 * from the front, longest-lived first — one giant alternation is unreadable
 * and, worse, silently stops matching when a clause is phrased slightly
 * differently.
 */
const PREAMBLES: RegExp[] = [
  /^(?:hi|hey|hello|ok(?:ay)?|so|well|actually|please)\b[\s,]*/i,
  /^(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:help\s+me\s+)?/i,
  /^(?:i|we)\s*(?:'m|'ve|'d|m|ve|am|have|was|were)?\s*(?:just|really|currently)?\s*(?:need|want|look|looking|try|trying|hop(?:e|ing)|wonder(?:ing)?|search(?:ing)?|shop(?:ping)?|would\s+like|like)\b/i,
  /^(?:to|for|if|up|out|about)\b\s*/i,
  /^(?:find|search|look\s*up|show\s+me|tell\s+me(?:\s+about)?|get\s+me|help\s+me)\b\s*/i,
  /^(?:a|an|the|some|any)\b\s+/i
]

/** Trailing clauses that attach the asker's situation to a subject. */
const TRAILING_CONTEXT =
  /\s+(?:for\s+(?:my|our|me|us)\b|because\b|since\b|so\s+(?:i|we)\b|as\s+(?:i|we)\b|before\s+(?:i|we)\b|while\s+(?:i|we)\b|when\s+(?:i|we)\b).*$/i

/** Above this, a query has stopped being search terms and become a paragraph. */
const MAX_QUERY_WORDS = 16

export interface MinimizedQuery {
  query: string
  /** True when framing was stripped, for the redaction note. */
  dropped: boolean
  /**
   * Set when the query is not salvageable as search terms. The caller refuses
   * the search and hands this back to the model to try again.
   */
  refusal?: string
}

const wordsOf = (text: string): string[] => text.split(/\s+/).filter(Boolean)

/**
 * Reduce a search query to its subject, or refuse it.
 *
 * `sanitizeQuery` removes what is *secret*. This removes what is merely nobody
 * else's business: that the person asking is planning a business trip, shopping
 * for themselves, or in a hurry. A provider needs the subject terms to answer;
 * the rest is disclosure with nothing bought by it.
 *
 * Two mechanisms, because one is not enough:
 *
 * 1. **Strip** leading request framing and trailing personal context. This
 *    handles the common, recoverable case ("i'm looking for organic cotton
 *    thongs" → "organic cotton thongs") without bouncing anything.
 * 2. **Refuse** what is still a paragraph about the asker. DESIGN-private-
 *    shopping §2b specifies exactly this — *"enforced in code by rejecting
 *    queries over N tokens that contain first-person pronouns, not by asking
 *    the model nicely"* — and asking nicely is measurably insufficient: in a
 *    v1.3 session a model sent *"I have a business meeting coming up in Japan.
 *    I need to buy 2 new business suits and book flights and hotel in Tokyo
 *    for Aug 28 - September 12…"* verbatim as a query, under a schema that
 *    says to send terms only.
 *
 * Refusing beats truncating. Cutting that example at sixteen words yields
 * "I have a business meeting coming up in Japan. I need to buy 2 new business"
 * — which has leaked the trip *and* searches for nothing. A refusal costs one
 * round trip and gets a query that works.
 */
export function minimizeQuery(query: string): MinimizedQuery {
  const original = query.trim()
  if (!original) return { query: original, dropped: false }

  let working = original
  if (FIRST_PERSON.test(working) || /^(?:can|could|would|will|find|search|look|show|tell)\b/i.test(working)) {
    // Peel the front until nothing matches: "so i'm trying to find a …" needs
    // several passes, and each pattern is individually conservative.
    for (let pass = 0; pass < PREAMBLES.length * 2; pass++) {
      const before = working
      for (const re of PREAMBLES) working = working.replace(re, '')
      working = working.replace(/^[\s,.;:—-]+/, '')
      if (working === before) break
    }
    working = working.replace(TRAILING_CONTEXT, '').trim()
  }

  // Stripping must never produce an empty or gutted query; fall back whole.
  if (wordsOf(working).length === 0) working = original

  const words = wordsOf(working)
  const stillPersonal = FIRST_PERSON.test(working)
  const multiSentence = /[.!?]\s+\S/.test(working)

  if (stillPersonal && (words.length > MAX_QUERY_WORDS || multiSentence)) {
    return {
      query: working,
      dropped: working !== original,
      refusal:
        'That query is a sentence about you, not search terms, so it was not sent. ' +
        'Search providers get the subject only — no first-person framing, no plans, no dates ' +
        'or places that are not part of what you are looking up. Call the tool again with ' +
        'just the terms (for example "grand sumo tournament September 2026 schedule" rather ' +
        'than a description of your trip). Split separate subjects into separate searches.'
    }
  }

  if (words.length > MAX_QUERY_WORDS) {
    working = words.slice(0, MAX_QUERY_WORDS).join(' ')
  }

  return { query: working, dropped: working !== original }
}

// ---- HTTP helpers ------------------------------------------------------------

/** Shared with the headless renderer so the two paths are indistinguishable. */
const USER_AGENT = GENERIC_USER_AGENT

/** The transport applies the timeout now, so no AbortController is needed here. */
async function fetchWithTimeout(
  url: string,
  init: AuditedFetchInit | undefined,
  purpose: 'search' | 'webpage' | 'shop' | 'image',
  timeoutMs: number
): Promise<HttpResponseLike> {
  return auditedFetch(url, { ...init, timeoutMs }, purpose)
}

// ---- Providers ---------------------------------------------------------------

async function searchSearXNG(query: string, maxResults: number): Promise<SearchResult[]> {
  const base = getSettings().search.searxngUrl.trim().replace(/\/+$/, '')
  if (!base) throw new Error('No SearXNG URL configured — set it under Settings → Search.')
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } }, 'search', 15_000)
  if (!res.ok) {
    throw new Error(
      `SearXNG returned HTTP ${res.status}. If this is 403, enable JSON output on your instance ` +
        '(settings.yml → search: formats: [html, json]).'
    )
  }
  const data = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string; publishedDate?: string }[]
  }
  return (data.results ?? [])
    .filter((r) => r.title && r.url)
    .slice(0, maxResults)
    .map((r) => ({
      title: r.title!,
      url: r.url!,
      snippet: (r.content ?? '').slice(0, 500),
      published: r.publishedDate ?? undefined
    }))
}

async function searchBrave(query: string, maxResults: number): Promise<SearchResult[]> {
  const apiKey = getBraveApiKey()
  if (!apiKey) {
    throw new Error('No Brave Search API key set — add one under Settings → Search.')
  }
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`
  const res = await fetchWithTimeout(
    url,
    {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
        'User-Agent': USER_AGENT
      }
    },
    'search',
    15_000
  )
  if (!res.ok) throw new Error(`Brave Search returned HTTP ${res.status}${proxyRefusalHint(res.status)}`)
  const data = (await res.json()) as {
    web?: { results?: { title?: string; url?: string; description?: string; age?: string }[] }
  }
  return (data.web?.results ?? [])
    .filter((r) => r.title && r.url)
    .slice(0, maxResults)
    .map((r) => ({
      title: r.title!,
      url: r.url!,
      snippet: (r.description ?? '').slice(0, 500),
      published: r.age ?? undefined
    }))
}

/** DuckDuckGo result links are redirect wrappers; pull the real URL out of uddg. */
function unwrapDuckDuckGoLink(href: string): string {
  try {
    const u = new URL(href, 'https://html.duckduckgo.com')
    const uddg = u.searchParams.get('uddg')
    return uddg ?? href
  } catch {
    return href
  }
}

/**
 * DuckDuckGo's keyless HTML endpoint — a real web-results page rather than
 * the instant-answer API (which mostly returns Wikipedia abstracts). No key,
 * no tracking cookies accepted or sent; rate-limited, so keep bursts low.
 */
async function searchDuckDuckGo(query: string, maxResults: number): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const res = await fetchWithTimeout(
    url,
    { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' } },
    'search',
    15_000
  )
  if (!res.ok) throw new Error(`DuckDuckGo returned HTTP ${res.status}${proxyRefusalHint(res.status)}`)
  const html = await res.text()

  /**
   * Snippets are matched *within each result's span* rather than by zipping two
   * independent match lists together. Zipping (`links[i]` with `snippets[i]`)
   * silently misattributes every following snippet as soon as one result lacks
   * one — which ads, news modules and "related searches" all cause — so the
   * model would receive real URLs described by another result's text.
   *
   * Attributes are read off a single generic anchor pass because DuckDuckGo's
   * class lists and attribute order both vary (`class="result__a js-…"`).
   */
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    index: m.index ?? 0,
    attrs: m[1],
    inner: m[2]
  }))
  const hasClass = (attrs: string, name: string): boolean =>
    new RegExp(`class="[^"]*\\b${name}\\b`).test(attrs)
  const hrefOf = (attrs: string): string | null => attrs.match(/href="([^"]*)"/)?.[1] ?? null

  const titleAnchors = anchors.filter((a) => hasClass(a.attrs, 'result__a'))
  const snippetAnchors = anchors.filter((a) => hasClass(a.attrs, 'result__snippet'))

  const results: SearchResult[] = []
  for (let i = 0; i < titleAnchors.length && results.length < maxResults; i++) {
    const anchor = titleAnchors[i]
    const href = hrefOf(anchor.attrs)
    if (!href) continue
    const resultUrl = unwrapDuckDuckGoLink(decodeEntities(href))
    if (!/^https?:\/\//.test(resultUrl)) continue

    // Only a snippet before the next result's title can belong to this result.
    const nextIndex = titleAnchors[i + 1]?.index ?? html.length
    const snippet = snippetAnchors.find((s) => s.index > anchor.index && s.index < nextIndex)

    results.push({
      title: stripTags(anchor.inner),
      url: resultUrl,
      snippet: snippet ? stripTags(snippet.inner).slice(0, 500) : ''
    })
  }
  return results
}

// ---- Image search ------------------------------------------------------------

/** Protocol-relative URLs (`//cdn.example/…`) need a scheme before parsing. */
function absoluteHttpUrl(url: string): string {
  return url.startsWith('//') ? `https:${url}` : url
}

async function searchSearXNGImages(query: string, maxResults: number): Promise<ImageResult[]> {
  const base = getSettings().search.searxngUrl.trim().replace(/\/+$/, '')
  if (!base) throw new Error('No SearXNG URL configured — set it under Settings → Search.')
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&categories=images`
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } }, 'search', 15_000)
  if (!res.ok) throw new Error(`SearXNG returned HTTP ${res.status}`)
  const data = (await res.json()) as {
    results?: { title?: string; url?: string; img_src?: string; thumbnail_src?: string }[]
  }
  return (data.results ?? [])
    .filter((r) => r.img_src && r.url)
    .slice(0, maxResults)
    .map((r) => ({
      title: r.title ?? '',
      imageUrl: absoluteHttpUrl(r.img_src!),
      thumbnailUrl: r.thumbnail_src ? absoluteHttpUrl(r.thumbnail_src) : undefined,
      pageUrl: r.url!
    }))
}

async function searchBraveImages(query: string, maxResults: number): Promise<ImageResult[]> {
  const apiKey = getBraveApiKey()
  if (!apiKey) {
    throw new Error('No Brave Search API key set — add one under Settings → Search.')
  }
  const url =
    `https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(query)}` +
    `&count=${maxResults}&safesearch=moderate`
  const res = await fetchWithTimeout(
    url,
    {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
        'User-Agent': USER_AGENT
      }
    },
    'search',
    15_000
  )
  if (!res.ok) throw new Error(`Brave Image Search returned HTTP ${res.status}${proxyRefusalHint(res.status)}`)
  const data = (await res.json()) as {
    results?: { title?: string; url?: string; properties?: { url?: string }; thumbnail?: { src?: string } }[]
  }
  return (data.results ?? [])
    .filter((r) => r.properties?.url && r.url)
    .slice(0, maxResults)
    .map((r) => ({
      title: r.title ?? '',
      imageUrl: r.properties!.url!,
      thumbnailUrl: r.thumbnail?.src ?? undefined,
      pageUrl: r.url!
    }))
}

/**
 * DuckDuckGo's keyless image endpoint. The JSON feed requires a `vqd` token
 * from the results page first — same no-key, rate-limited posture as the HTML
 * endpoint, so keep bursts low here too.
 */
async function searchDuckDuckGoImages(query: string, maxResults: number): Promise<ImageResult[]> {
  const page = await fetchWithTimeout(
    `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`,
    { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' } },
    'search',
    15_000
  )
  if (!page.ok) throw new Error(`DuckDuckGo returned HTTP ${page.status}`)
  const html = await page.text()
  const vqd = /vqd=["']([^"']+)["']/.exec(html)?.[1] ?? /vqd=([\d-]+)&/.exec(html)?.[1]
  if (!vqd) throw new Error('DuckDuckGo did not issue an image-search token.')

  const res = await fetchWithTimeout(
    `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}` +
      `&vqd=${encodeURIComponent(vqd)}&f=,,,&p=1`,
    {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        Referer: 'https://duckduckgo.com/'
      }
    },
    'search',
    15_000
  )
  if (!res.ok) throw new Error(`DuckDuckGo images returned HTTP ${res.status}${proxyRefusalHint(res.status)}`)
  const data = (await res.json()) as {
    results?: { title?: string; image?: string; thumbnail?: string; url?: string }[]
  }
  return (data.results ?? [])
    .filter((r) => r.image && r.url)
    .slice(0, maxResults)
    .map((r) => ({
      title: r.title ?? '',
      imageUrl: absoluteHttpUrl(r.image!),
      thumbnailUrl: r.thumbnail ? absoluteHttpUrl(r.thumbnail) : undefined,
      pageUrl: r.url!
    }))
}

/**
 * The ceiling on images per search, and the only one.
 *
 * Every returned image costs a separate fetch to a separate third-party host,
 * so this number is a privacy budget before it is a display choice. It is
 * enforced here rather than downstream: asking a provider for results that are
 * then discarded spends the user's quota to produce nothing.
 */
export const MAX_IMAGE_RESULTS = 6

/**
 * The image counterpart of runWebSearch: same query sanitization, same
 * provider abstraction, same pre-send confirmation hook. Images are NOT
 * cached — the text search cache exists to spare rate limits, and image
 * queries are far rarer; every image search is one provider request.
 */
export async function runImageSearch(
  rawQuery: string,
  maxResults = MAX_IMAGE_RESULTS,
  beforeSend?: (sanitizedQuery: string) => Promise<boolean>
): Promise<ImageSearchOutcome> {
  const settings = getSettings().search
  const { query, redactions, refusal } = sanitizeQuery(String(rawQuery ?? ''))
  const provider = settings.provider

  if (!query) {
    return { ok: false, provider, images: [], redactions, sentQuery: '', error: 'Empty image search query.' }
  }
  if (refusal) {
    return { ok: false, provider, images: [], redactions, sentQuery: '', error: refusal }
  }
  const limit = Math.min(Math.max(1, Math.round(maxResults) || 1), MAX_IMAGE_RESULTS)

  if (settings.confirmBeforeSearch && beforeSend && !(await beforeSend(query))) {
    return {
      ok: false,
      provider,
      images: [],
      redactions,
      sentQuery: query,
      error: 'The user declined this image search.'
    }
  }

  try {
    let images: ImageResult[]
    switch (provider) {
      case 'searxng':
        images = await searchSearXNGImages(query, limit)
        break
      case 'brave':
        images = await searchBraveImages(query, limit)
        break
      case 'duckduckgo':
        images = await searchDuckDuckGoImages(query, limit)
        break
    }
    return { ok: true, provider, images, redactions, sentQuery: query }
  } catch (err) {
    return {
      ok: false,
      provider,
      images: [],
      redactions,
      sentQuery: query,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

// ---- Thumbnail proxying --------------------------------------------------------

/** Largest body we will pull off the wire before deciding it is not a thumbnail. */
const MAX_THUMBNAIL_BYTES = 256 * 1024
/** Largest data URL we will keep, after downscaling. See `downscaleThumbnail`. */
export const MAX_STORED_THUMBNAIL_BYTES = 48 * 1024
const THUMBNAIL_WIDTH = 320
const THUMBNAIL_TIMEOUT_MS = 10_000
const MAX_THUMBNAIL_REDIRECTS = 2
/** Raster formats only — SVG can carry script and is refused outright. */
const THUMBNAIL_TYPES = /^image\/(jpeg|png|gif|webp|avif)$/

export interface ThumbnailOutcome {
  ok: boolean
  dataUrl?: string
  error?: string
}

/**
 * Shrink a fetched image to gallery size.
 *
 * This is not cosmetic. A tool-call record is persisted verbatim with its
 * conversation, and every conversation file is re-read and parsed at launch —
 * so a full-size image here is megabytes of base64 that the app pays for on
 * every start, forever. 320px wide is already more than the three-column grid
 * renders.
 *
 * `nativeImage` decodes PNG and JPEG only; WebP, AVIF and GIF come back empty.
 * Those are kept unchanged when they are already under the stored cap and
 * refused when they are not — a stated limit rather than a silent blank tile.
 */
function downscaleThumbnail(bytes: Uint8Array, contentType: string): ThumbnailOutcome {
  const asDataUrl = (type: string, buffer: Buffer): ThumbnailOutcome => ({
    ok: true,
    dataUrl: `data:${type};base64,${buffer.toString('base64')}`
  })
  const tooBig = (size: number): ThumbnailOutcome => ({
    ok: false,
    error:
      `Thumbnail is ${Math.round(size / 1024)}KB after resizing, over the ` +
      `${Math.round(MAX_STORED_THUMBNAIL_BYTES / 1024)}KB limit.`
  })

  const source = Buffer.from(bytes)
  const image = nativeImage.createFromBuffer(source)
  if (image.isEmpty()) {
    // Undecodable here (WebP/AVIF/GIF, or a corrupt body). Pass it through only
    // if it is already small enough to store.
    if (source.byteLength <= MAX_STORED_THUMBNAIL_BYTES) return asDataUrl(contentType, source)
    return {
      ok: false,
      error:
        `Image is ${Math.round(source.byteLength / 1024)}KB and its format (${contentType}) ` +
        'cannot be resized locally.'
    }
  }

  const { width } = image.getSize()
  const resized =
    width > THUMBNAIL_WIDTH ? image.resize({ width: THUMBNAIL_WIDTH, quality: 'good' }) : image

  // PNG keeps transparency, which some product shots rely on — but PNG of a
  // photograph is far larger than JPEG, so fall back when it does not fit.
  if (contentType === 'image/png') {
    const png = resized.toPNG()
    if (png.byteLength <= MAX_STORED_THUMBNAIL_BYTES) return asDataUrl('image/png', png)
  }
  const jpeg = resized.toJPEG(72)
  if (jpeg.byteLength > MAX_STORED_THUMBNAIL_BYTES) return tooBig(jpeg.byteLength)
  return asDataUrl('image/jpeg', jpeg)
}

/**
 * Fetch one image through the audited egress path and return it as a data URL.
 *
 * The renderer's CSP allows `data:` images only, so a remote thumbnail cannot
 * be loaded by the chat UI directly. That is deliberate, and this is the
 * controlled way around it: the fetch goes through the SSRF guard, the egress
 * session (so a configured proxy actually covers it), and the network activity
 * log — and it carries no cookies, no referrer and no browser fingerprint.
 *
 * What it does not do is hide the user from the image host. Without a proxy the
 * host still sees the user's IP address, because the main process fetches from
 * the same machine. The gain over letting the renderer load the URL directly is
 * auditability, proxy coverage and a stripped request — not invisibility, and
 * the confirmation dialog says so before any of this runs.
 */
export async function fetchImageDataUrl(rawUrl: string): Promise<ThumbnailOutcome> {
  let url: URL
  try {
    url = new URL(String(rawUrl ?? ''))
  } catch {
    return { ok: false, error: 'Unparseable image URL.' }
  }
  if (url.protocol !== 'https:') {
    return { ok: false, error: 'Refused: image URLs must be HTTPS.' }
  }

  try {
    for (let hop = 0; ; hop++) {
      await assertPublicHost(url)
      const res = await fetchWithTimeout(
        url.toString(),
        {
          redirect: 'manual',
          // JPEG and PNG first on purpose: those are the two formats
          // `downscaleThumbnail` can actually resize, so preferring them keeps
          // more results displayable rather than dropped for being too large.
          headers: { 'User-Agent': USER_AGENT, Accept: 'image/jpeg,image/png,image/*' },
          maxBytes: MAX_THUMBNAIL_BYTES
        },
        'image',
        THUMBNAIL_TIMEOUT_MS
      )

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (!location) throw new Error(`Redirect (HTTP ${res.status}) without a Location header.`)
        if (hop >= MAX_THUMBNAIL_REDIRECTS) throw new Error('Too many redirects.')
        const next = new URL(location, url)
        if (next.protocol !== 'https:') throw new Error('Refused: redirect to a non-HTTPS URL.')
        url = next
        continue
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}${proxyRefusalHint(res.status)}`)
      const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
      if (!THUMBNAIL_TYPES.test(contentType)) {
        throw new Error(`Not a supported image (${contentType || 'unknown content type'}).`)
      }
      // A capped body is a *partial* body: base64-encoding it produces a data
      // URL that looks valid and decodes to a broken image. Refuse instead.
      if (res.truncated) {
        throw new Error(
          `Image is larger than the ${Math.round(MAX_THUMBNAIL_BYTES / 1024)}KB fetch limit.`
        )
      }
      const bytes = await readCappedBytes(res, MAX_THUMBNAIL_BYTES)
      return downscaleThumbnail(bytes, contentType)
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---- Public search API -------------------------------------------------------

/**
 * Recent search responses, in RAM.
 *
 * A model working through a research task re-issues near-identical queries
 * routinely — after a failed fetch, when checking its own work, or across two
 * specialists in a pipeline. Serving those from RAM means one fewer contact with
 * the provider (better privacy) and one fewer request against a rate limit that
 * DuckDuckGo and Brave's free tier both enforce tightly. Short TTL, because
 * search results are meant to be fresh.
 */
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000
const SEARCH_CACHE_MAX = 64

interface CachedSearch {
  at: number
  results: SearchResult[]
}

const searchCache = new Map<string, CachedSearch>()

function searchCacheKey(provider: SearchProviderId, query: string, maxResults: number): string {
  return `${provider}\u001f${maxResults}\u001f${query.toLowerCase()}`
}

function readSearchCache(key: string): SearchResult[] | null {
  const hit = searchCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(key)
    return null
  }
  // Refresh insertion order so the entry counts as recently used.
  searchCache.delete(key)
  searchCache.set(key, hit)
  return hit.results
}

function writeSearchCache(key: string, results: SearchResult[]): void {
  searchCache.set(key, { at: Date.now(), results })
  while (searchCache.size > SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next()
    if (oldest.done) break
    searchCache.delete(oldest.value)
  }
}

export function clearSearchCache(): { entries: number } {
  const entries = searchCache.size
  searchCache.clear()
  return { entries }
}

export function searchCacheSize(): number {
  return searchCache.size
}

export async function runWebSearch(
  rawQuery: string,
  beforeSend?: (sanitizedQuery: string) => Promise<boolean>
): Promise<WebSearchOutcome> {
  const settings = getSettings().search
  const { query, redactions, refusal } = sanitizeQuery(String(rawQuery ?? ''))
  const provider = settings.provider

  if (!query) {
    return { ok: false, provider, results: [], redactions, sentQuery: '', error: 'Empty search query.' }
  }
  // Refused before the cache and before the wire: a paragraph about the user
  // is neither a good search nor theirs to disclose. The model gets told how
  // to fix it and calls again.
  if (refusal) {
    return { ok: false, provider, results: [], redactions, sentQuery: '', error: refusal }
  }

  // A cache hit sends nothing, so it is checked before the confirmation prompt —
  // there is no outgoing query for the user to approve.
  const key = searchCacheKey(provider, query, settings.maxResults)
  const cached = readSearchCache(key)
  if (cached) {
    return { ok: true, provider, results: cached, redactions, sentQuery: query, cached: true }
  }

  // The user opted to approve every outgoing query — and sees the exact
  // sanitized string — before anything leaves the machine.
  if (settings.confirmBeforeSearch && beforeSend && !(await beforeSend(query))) {
    return {
      ok: false,
      provider,
      results: [],
      redactions,
      sentQuery: query,
      error: 'The user declined this web search.'
    }
  }

  try {
    let results: SearchResult[]
    switch (provider) {
      case 'searxng':
        results = await searchSearXNG(query, settings.maxResults)
        break
      case 'brave':
        results = await searchBrave(query, settings.maxResults)
        break
      case 'duckduckgo':
        results = await searchDuckDuckGo(query, settings.maxResults)
        break
    }
    // Only successful, non-empty responses are cached: caching a transient empty
    // result would hide a working query for the whole TTL.
    if (results.length > 0) writeSearchCache(key, results)
    return { ok: true, provider, results, redactions, sentQuery: query, cached: false }
  } catch (err) {
    return {
      ok: false,
      provider,
      results: [],
      redactions,
      sentQuery: query,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/** Settings → Search "Test connection" button. */
export async function testSearchProvider(): Promise<{ ok: boolean; detail: string }> {
  const outcome = await runWebSearch('sigma oasis privacy test')
  if (!outcome.ok) return { ok: false, detail: outcome.error ?? 'Unknown error' }
  return {
    ok: true,
    detail:
      outcome.results.length > 0
        ? `OK — ${outcome.results.length} result(s) from ${outcome.provider}.`
        : `Connected to ${outcome.provider}, but the test query returned no results.`
  }
}

// ---- fetch_webpage (SSRF-guarded) --------------------------------------------

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

const MAX_PAGE_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 5
const FETCH_TIMEOUT_MS = 15_000

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
async function assertPublicHost(url: URL): Promise<void> {
  const hostname = url.hostname
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
 * Response body as bytes, capped. The cap is applied by the transport (which
 * stops reading and drops the connection), so this only has to slice defensively
 * in case a stub or future transport hands back more than asked for.
 */
async function readCappedBytes(res: HttpResponseLike, cap: number): Promise<Uint8Array> {
  const buffer = await res.arrayBuffer()
  return new Uint8Array(buffer.byteLength > cap ? buffer.slice(0, cap) : buffer)
}

export interface WebpageOutcome {
  ok: boolean
  url: string
  title: string
  text: string
  truncated: boolean
  /** Outbound links found on the page, resolved and deduped. */
  links: ExtractedLink[]
  /** True when a main-content container was identified (rather than whole page). */
  mainContentFound: boolean
  /** What the page was: 'html', 'text' or 'pdf'. */
  kind: 'html' | 'text' | 'pdf'
  /**
   * Raw response body for HTML pages, used only to decide whether the page is a
   * client-rendered shell worth escalating to the renderer. Never indexed.
   */
  rawHtml?: string
  error?: string
}

function failedPage(url: string, error: string): WebpageOutcome {
  return {
    ok: false,
    url,
    title: '',
    text: '',
    truncated: false,
    links: [],
    mainContentFound: false,
    kind: 'html',
    error
  }
}

/**
 * `purpose` selects the activity-log label only — the SSRF guard, the HTTPS
 * requirement and the redirect handling are identical either way. Shopping
 * fetches pass 'shop' so the user can tell a page they asked to read from a
 * retailer the app contacted on their behalf.
 */
export async function fetchWebpage(
  rawUrl: string,
  purpose: 'webpage' | 'shop' = 'webpage'
): Promise<WebpageOutcome> {
  let url: URL
  try {
    url = new URL(String(rawUrl ?? ''))
  } catch {
    return failedPage('', 'Unparseable URL.')
  }
  if (url.protocol !== 'https:') {
    return failedPage(
      url.toString(),
      `Refused: only HTTPS URLs can be fetched (got ${url.protocol}).`
    )
  }

  try {
    // Manual redirect loop: re-run the SSRF check on every hop, because a
    // public URL may redirect to an internal one.
    for (let hop = 0; ; hop++) {
      await assertPublicHost(url)
      const res = await fetchWithTimeout(
        url.toString(),
        {
          redirect: 'manual',
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,application/pdf,text/plain'
          },
          maxBytes: MAX_PAGE_BYTES
        },
        purpose,
        FETCH_TIMEOUT_MS
      )

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (!location) throw new Error(`Redirect (HTTP ${res.status}) without a Location header.`)
        if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects (>${MAX_REDIRECTS}).`)
        const next = new URL(location, url)
        if (next.protocol !== 'https:') {
          throw new Error('Refused: redirect to a non-HTTPS URL.')
        }
        url = next
        continue
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}${proxyRefusalHint(res.status)}`)
      const contentType = res.headers.get('content-type') ?? ''
      const finalUrl = url.toString()

      if (/application\/pdf|application\/x-pdf/.test(contentType)) {
        const bytes = await readCappedBytes(res, MAX_PAGE_BYTES)
        const pdf = extractPdfText(bytes)
        if (!pdf.ok) return failedPage(finalUrl, pdf.error)
        return {
          ok: true,
          url: finalUrl,
          title: pdf.title || finalUrl.split('/').pop() || '',
          text: pdf.text,
          truncated: bytes.byteLength >= MAX_PAGE_BYTES,
          links: [],
          mainContentFound: false,
          kind: 'pdf'
        }
      }

      if (!/text\/html|application\/xhtml|text\/plain/.test(contentType)) {
        throw new Error(`Refused: unsupported content type "${contentType || 'unknown'}".`)
      }

      const bytes = await readCappedBytes(res, MAX_PAGE_BYTES)
      const raw = new TextDecoder().decode(bytes)
      const truncated = bytes.byteLength >= MAX_PAGE_BYTES

      if (/text\/plain/.test(contentType)) {
        return {
          ok: true,
          url: finalUrl,
          title: '',
          text: raw,
          truncated,
          links: [],
          mainContentFound: false,
          kind: 'text'
        }
      }

      const extracted = extractFromHtml(raw, finalUrl)
      return {
        ok: true,
        url: finalUrl,
        title: extracted.title,
        text: extracted.text,
        truncated,
        links: extracted.links,
        mainContentFound: extracted.mainContentFound,
        kind: 'html',
        rawHtml: raw
      }
    }
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? `Timed out after ${FETCH_TIMEOUT_MS / 1000}s.`
        : err instanceof Error
          ? err.message
          : String(err)
    return failedPage(url.toString(), message)
  }
}

// ---- Static-first, render-on-failure ----------------------------------------

/** Below this much extracted text, a page probably did not render server-side. */
const THIN_TEXT_CHARS = 500

/**
 * Markers of a page whose content arrives only after scripts run. Matched
 * against the *raw HTML*, since by definition the extracted text is empty.
 */
const JS_SHELL_MARKERS = [
  /<div[^>]+id=["'](?:root|app|__next|__nuxt|application)["']/i,
  /<noscript>[^<]*(?:enable|requires?)\s+JavaScript/i,
  /window\.__(?:NUXT|NEXT_DATA|INITIAL_STATE)__/i,
  /\bng-app\b|\bdata-reactroot\b|\bv-cloak\b/i
]

/**
 * Should this page be re-read with the headless renderer?
 *
 * Static-first is deliberate and is as much a privacy decision as a performance
 * one: a plain fetch executes nothing and contacts exactly one host, so it is
 * the cheaper and safer path and should handle the majority of pages. The
 * renderer is escalated to only when the static result is visibly inadequate.
 *
 * Exported for tests — the decision is worth asserting directly.
 */
export function shouldRender(
  kind: 'html' | 'text' | 'pdf',
  extractedText: string,
  rawHtml: string
): { render: boolean; reason?: string } {
  // A PDF or plain-text response has no scripts to run; rendering cannot help.
  if (kind !== 'html') return { render: false }

  const length = extractedText.trim().length
  if (length >= THIN_TEXT_CHARS) return { render: false }

  const marker = JS_SHELL_MARKERS.find((re) => re.test(rawHtml))
  if (marker) {
    return { render: true, reason: 'the page looks like a client-rendered app shell' }
  }
  if (length === 0) {
    return { render: true, reason: 'the static fetch produced no text at all' }
  }
  return {
    render: true,
    reason: `the static fetch produced only ${length} characters of text`
  }
}

// ---- Reading a page: retrieval instead of truncation -------------------------

export interface WebpageReadOutcome {
  ok: boolean
  url: string
  title: string
  truncated: boolean
  /** Served from the in-RAM research index — no network request was made. */
  cached: boolean
  /** Total passages the page was split into. */
  totalChunks: number
  /** What the source was. */
  kind: 'html' | 'text' | 'pdf'
  /** True when a main-content container was identified rather than the whole page. */
  mainContentFound: boolean
  /** Outbound links, so a citation can be followed without a new search. */
  links: ExtractedLink[]
  /** Which path produced the text. */
  source: 'static' | 'rendered'
  /** Characters of visually-hidden text dropped (rendered path only). */
  hiddenTextRemoved: number
  /** Third-party origins the renderer refused to contact. */
  blockedOrigins: string[]
  /** Why rendering was or was not used, when it was considered. */
  renderNote?: string
  /** Ranked passages — present when a `query` was supplied. */
  retrieval?: PassageOutcome
  /** Whole-page text — present when no `query` was supplied. */
  text?: string
  error?: string
}

/**
 * Fetch (or reuse) a page and return either its full text or just the passages
 * relevant to `query`.
 *
 * The query path is the point of the exercise: a 200 KB reference page holds
 * maybe two paragraphs that answer the question, and handing the model the
 * first 8,000 characters instead reliably misses them while consuming the
 * context budget that the next four sources needed.
 */
export async function readWebpage(
  rawUrl: string,
  query: string,
  maxPassages: number
): Promise<WebpageReadOutcome> {
  const key = pageCacheKey(String(rawUrl ?? ''))
  let page = getIndexedPage(key)
  const cached = page !== null

  if (!page) {
    const fetched = await fetchWebpage(rawUrl)
    if (!fetched.ok) {
      return {
        ok: false,
        url: fetched.url,
        title: '',
        truncated: false,
        cached: false,
        totalChunks: 0,
        kind: fetched.kind,
        mainContentFound: false,
        links: [],
        source: 'static',
        hiddenTextRemoved: 0,
        blockedOrigins: [],
        error: fetched.error
      }
    }

    let title = fetched.title
    let text = fetched.text
    let links = fetched.links
    let mainContentFound = fetched.mainContentFound
    let source: 'static' | 'rendered' = 'static'
    let hiddenTextRemoved = 0
    let blockedOrigins: string[] = []
    let renderNote: string | undefined

    // Escalate to the headless renderer only when the cheap path came back
    // visibly inadequate, and only if the user enabled it.
    if (getSettings().search.useHeadlessRenderer) {
      const decision = shouldRender(fetched.kind, fetched.text, fetched.rawHtml ?? '')
      if (decision.render) {
        const rendered = await renderPage(fetched.url)
        if (rendered.ok && rendered.text.trim().length > fetched.text.trim().length) {
          title = rendered.title || title
          text = rendered.text
          links = rendered.links.length > 0 ? rendered.links : links
          mainContentFound = true
          source = 'rendered'
          hiddenTextRemoved = rendered.hiddenTextRemoved
          blockedOrigins = rendered.blockedOrigins
          renderNote = `Rendered with JavaScript because ${decision.reason}.`
        } else {
          // Keep the static result rather than losing content to a failed render.
          renderNote = rendered.ok
            ? 'JavaScript rendering produced no additional text; showing the static result.'
            : `JavaScript rendering failed (${rendered.error}); showing the static result.`
        }
      }
    }

    page = indexPage({
      key,
      url: fetched.url,
      title,
      text,
      truncated: fetched.truncated,
      kind: fetched.kind,
      mainContentFound,
      links,
      source,
      hiddenTextRemoved,
      blockedOrigins,
      renderNote
    })
  }

  const base = {
    ok: true as const,
    url: page.url,
    title: page.title,
    truncated: page.truncated,
    cached,
    totalChunks: page.chunks.length,
    kind: page.kind,
    mainContentFound: page.mainContentFound,
    links: page.links,
    source: page.source,
    hiddenTextRemoved: page.hiddenTextRemoved,
    blockedOrigins: page.blockedOrigins,
    renderNote: page.renderNote
  }

  if (!query.trim()) return { ...base, text: page.text }
  return { ...base, retrieval: await retrievePassages(page, query, maxPassages) }
}

// ---- IPC ---------------------------------------------------------------------

export function registerSearchHandlers(): void {
  ipcMain.handle('search:test', () => testSearchProvider())
  ipcMain.handle('search:braveKeyStatus', () => braveApiKeyStatus())
  ipcMain.handle('search:setBraveApiKey', (_e, key: string) => setBraveApiKey(String(key ?? '')))
  // Both in-RAM caches are reported and cleared together: to the user they are
  // one thing — "what this session still remembers about the web".
  ipcMain.handle('research:stats', () => ({
    ...researchIndexStats(),
    searchQueries: searchCacheSize()
  }))
  ipcMain.handle('research:clear', () => ({
    ...clearResearchIndex(),
    ...clearSearchCache()
  }))
}
