import { ipcMain } from 'electron'
import { braveApiKeyStatus, getSettings, setBraveApiKey } from './store'
import {
  clearResearchIndex,
  getIndexedPage,
  indexPage,
  pageCacheKey,
  researchIndexStats,
  retrievePassages
} from './researchIndex'
import type { PassageOutcome } from './researchIndex'
import { extractFromHtml } from './extract'
import type { ExtractedLink } from './extract'
import { extractPdfTextOffThread } from './pdfOffThread'
import { renderPage } from './render'
import { fetchWithTimeout, proxyRefusalHint, readCappedBytes, USER_AGENT } from './search/http'
import { assertPublicHost, isResearchFixtureOrigin } from './search/ssrf'
import { clearSearchCache, searchCacheSize } from './search/cache'
import { testSearchProvider } from './search/webSearch'
import { shouldRender } from './search/renderDecision'

/**
 * Privacy-preserving web search and webpage fetching.
 *
 * Provider abstraction: `web_search` is served by whichever provider the user
 * picked in Settings → Search & research (self-hosted SearXNG, Brave Search API, or
 * DuckDuckGo's HTML endpoint). All providers are reached through the egress
 * allowlist in net.ts, and every request appears in the network activity log.
 *
 * `fetch_webpage` retrieves a single page at the user's direction, with SSRF
 * guards: HTTPS only, DNS-resolved private/loopback ranges refused, manual
 * redirect handling, size and time caps, and script/ad stripping.
 *
 * v4.2 (R1): this file is the facade. The jobs live beside it in search/ —
 * types, query hygiene and minimization (query), the audited transport and
 * refusal hints (http), text providers (providers), image search (images),
 * thumbnail proxying (thumbnails), the in-RAM result cache (cache), the web
 * search entry point (webSearch), the SSRF guard (ssrf) and the static-vs-render
 * decision (renderDecision). Page fetching and reading stay here (the off-thread
 * PDF guard in test/pdfOffThread.test.ts reads this file for them). Everything
 * is re-exported below, so callers and tests keep importing from this path.
 */

export type { SearchResult, WebSearchOutcome, ImageResult, ImageSearchOutcome } from './search/types'
export { minimizeQuery, subjectFromContext } from './search/query'
export type { MinimizedQuery } from './search/query'
export { providerSearchUrl, SEARCH_RECENCIES } from './search/providers'
export type { SearchRecency } from './search/providers'
export { MAX_IMAGE_RESULTS, runImageSearch } from './search/images'
export { MAX_STORED_THUMBNAIL_BYTES, fetchImageDataUrl } from './search/thumbnails'
export type { ThumbnailOutcome } from './search/thumbnails'
export { clearSearchCache, searchCacheSize } from './search/cache'
export { runWebSearch, testSearchProvider } from './search/webSearch'
export { proxyRefusalHint } from './search/http'
export { assertPublicHost } from './search/ssrf'
export { shouldRender } from './search/renderDecision'

// ---- fetch_webpage ------------------------------------------------------------

const MAX_PAGE_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 5
const FETCH_TIMEOUT_MS = 15_000

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
  purpose: 'webpage' | 'shop' = 'webpage',
  /**
   * v4.1 (G2d): a whole-fetch deadline, redirects included, for the app's own
   * page reads before the model is asked — a reader waits on those. Clamped
   * to the ordinary per-request timeout; absent, nothing changes.
   */
  options: { timeoutMs?: number } = {}
): Promise<WebpageOutcome> {
  const limitMs =
    options.timeoutMs !== undefined ? Math.min(FETCH_TIMEOUT_MS, Math.max(1_000, options.timeoutMs)) : FETCH_TIMEOUT_MS
  const deadline = options.timeoutMs !== undefined ? Date.now() + limitMs : null
  const hopTimeout = (): number => (deadline === null ? FETCH_TIMEOUT_MS : Math.max(1, deadline - Date.now()))
  let url: URL
  try {
    url = new URL(String(rawUrl ?? ''))
  } catch {
    return failedPage('', 'Unparseable URL.')
  }
  if (url.protocol !== 'https:' && !isResearchFixtureOrigin(url)) {
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
        hopTimeout()
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
        // v3.1 (M4): off the main thread, where an agent task's stream runs.
        const pdf = await extractPdfTextOffThread(bytes)
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
        ? `Timed out after ${limitMs / 1000}s.`
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
  maxPassages: number,
  /**
   * v4.1 (G2d): the app's own bounded read. The deadline covers the fetch;
   * the headless renderer is not tried, because it has no share of a deadline
   * to spend — a page that needs it is left to the model's own fetch.
   */
  options: { timeoutMs?: number } = {}
): Promise<WebpageReadOutcome> {
  const key = pageCacheKey(String(rawUrl ?? ''))
  let page = getIndexedPage(key)
  const cached = page !== null

  if (!page) {
    const fetched = await fetchWebpage(rawUrl, 'webpage', options)
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
    if (getSettings().search.useHeadlessRenderer && options.timeoutMs === undefined) {
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
