import { ipcMain } from 'electron'
import { lookup } from 'dns/promises'
import { auditedFetch, isLoopbackHostname } from './net'
import { braveApiKeyStatus, getBraveApiKey, getSettings, setBraveApiKey } from './store'
import type { SearchProviderId } from './store'

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
  { label: 'absolute file path', re: /(?:\/[\w .-]+){2,}|[A-Z]:\\(?:[\w .-]+\\)+[\w .-]+/g },
  { label: 'private IP address', re: /\b(?:10|127|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2,3}\b/g },
  { label: 'credit-card-like number', re: /\b(?:\d[ -]?){13,19}\b/g }
]

function sanitizeQuery(query: string): { query: string; redactions: string[] } {
  const redactions = new Set<string>()
  let cleaned = query
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

const USER_AGENT = 'Sigma Oasis/0.5 (privacy-first local AI client)'

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

/** Decode HTML entities — enough of them for search snippets and page text. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
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

  const links = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
  const snippets = [...html.matchAll(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)]

  const results: SearchResult[] = []
  for (let i = 0; i < links.length && results.length < maxResults; i++) {
    const resultUrl = unwrapDuckDuckGoLink(decodeEntities(links[i][1]))
    if (!/^https?:\/\//.test(resultUrl)) continue
    results.push({
      title: stripTags(links[i][2]),
      url: resultUrl,
      snippet: snippets[i] ? stripTags(snippets[i][1]).slice(0, 500) : ''
    })
  }
  return results
}

// ---- Public search API -------------------------------------------------------

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
    return { ok: true, provider, results, redactions, sentQuery: query }
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

/** Read a response body with a hard byte cap (content-length can lie). */
async function readCapped(res: Response, cap: number): Promise<string> {
  if (!res.body) return res.text()
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
  return new TextDecoder().decode(merged)
}

/**
 * HTML → plain text: drop scripts/styles/ads/navigation chrome, keep block
 * structure as newlines, decode entities, collapse whitespace. Deliberately
 * simple — this is model context, not a browser rendering.
 */
export function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? stripTags(titleMatch[1]) : ''

  let body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|canvas|iframe|form|nav|footer|header|aside)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  // Block-level tags become newlines so structure survives tag stripping.
  body = body.replace(
    /<\/?(p|div|br|hr|li|ul|ol|h[1-6]|tr|table|section|article|blockquote|pre)[^>]*>/gi,
    '\n'
  )
  const text = stripTags(body)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
  return { title, text }
}

export interface WebpageOutcome {
  ok: boolean
  url: string
  title: string
  text: string
  truncated: boolean
  error?: string
}

export async function fetchWebpage(rawUrl: string): Promise<WebpageOutcome> {
  let url: URL
  try {
    url = new URL(String(rawUrl ?? ''))
  } catch {
    return { ok: false, url: '', title: '', text: '', truncated: false, error: 'Unparseable URL.' }
  }
  if (url.protocol !== 'https:') {
    return {
      ok: false,
      url: url.toString(),
      title: '',
      text: '',
      truncated: false,
      error: `Refused: only HTTPS URLs can be fetched (got ${url.protocol}).`
    }
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
          headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' }
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
      if (!/text\/html|application\/xhtml|text\/plain/.test(contentType)) {
        throw new Error(`Refused: unsupported content type "${contentType || 'unknown'}".`)
      }
      const raw = await readCapped(res, MAX_PAGE_BYTES)
      const { title, text } = /text\/plain/.test(contentType)
        ? { title: '', text: raw }
        : htmlToText(raw)
      return {
        ok: true,
        url: url.toString(),
        title,
        text,
        truncated: raw.length >= MAX_PAGE_BYTES
      }
    }
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? `Timed out after ${FETCH_TIMEOUT_MS / 1000}s.`
        : err instanceof Error
          ? err.message
          : String(err)
    return { ok: false, url: url.toString(), title: '', text: '', truncated: false, error: message }
  }
}

// ---- IPC ---------------------------------------------------------------------

export function registerSearchHandlers(): void {
  ipcMain.handle('search:test', () => testSearchProvider())
  ipcMain.handle('search:braveKeyStatus', () => braveApiKeyStatus())
  ipcMain.handle('search:setBraveApiKey', (_e, key: string) => setBraveApiKey(String(key ?? '')))
}
