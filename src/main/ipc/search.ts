import { ipcMain } from 'electron'
import { lookup } from 'dns/promises'
import { homedir } from 'os'
import { auditedFetch, isLoopbackHostname } from './net'
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

function sanitizeQuery(query: string): { query: string; redactions: string[] } {
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
  return { query: cleaned, redactions: [...redactions] }
}

// ---- HTTP helpers ------------------------------------------------------------

/**
 * A common, unremarkable browser UA — deliberately not an app-specific one.
 *
 * The previous value ("Sigma Oasis/0.5 …") announced the app, its version, and
 * by extension its user population to every host contacted, which is a
 * fingerprint no privacy-first client should hand out. Following the Tor
 * Browser approach, every install sends the *same* common string rather than
 * anything derived from the local platform or Electron build, so one user looks
 * like the next. Windows is used regardless of host OS because it is the
 * largest population to blend into.
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  purpose: 'search' | 'webpage',
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await auditedFetch(url, { ...init, signal: controller.signal }, purpose)
  } finally {
    clearTimeout(timer)
  }
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
  if (!res.ok) throw new Error(`Brave Search returned HTTP ${res.status}`)
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
  if (!res.ok) throw new Error(`DuckDuckGo returned HTTP ${res.status}`)
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
  return `${provider} ${maxResults} ${query.toLowerCase()}`
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
  const { query, redactions } = sanitizeQuery(String(rawQuery ?? ''))
  const provider = settings.provider

  if (!query) {
    return { ok: false, provider, results: [], redactions, sentQuery: '', error: 'Empty search query.' }
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

/**
 * Resolve the host and refuse anything that points at a private, loopback,
 * link-local, or reserved address — including the LM Studio server itself.
 */
async function assertPublicHost(url: URL): Promise<void> {
  const hostname = url.hostname
  if (isLoopbackHostname(hostname)) {
    throw new Error('Refused: fetch_webpage cannot fetch loopback addresses.')
  }
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

/** Read a response body with a hard byte cap, as bytes (content-length can lie). */
async function readCappedBytes(res: Response, cap: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array((await res.arrayBuffer()).slice(0, cap))
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      await reader.cancel()
      chunks.push(value.slice(0, Math.max(0, cap - (total - value.byteLength))))
      break
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(Math.min(total, cap))
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.byteLength
  }
  return merged
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

export async function fetchWebpage(rawUrl: string): Promise<WebpageOutcome> {
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
          }
        },
        'webpage',
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

      if (!res.ok) throw new Error(`HTTP ${res.status}`)
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
        kind: 'html'
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
        error: fetched.error
      }
    }
    page = indexPage({
      key,
      url: fetched.url,
      title: fetched.title,
      text: fetched.text,
      truncated: fetched.truncated,
      kind: fetched.kind,
      mainContentFound: fetched.mainContentFound,
      links: fetched.links
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
    links: page.links
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
