import { getBraveApiKey, getSettings } from '../store'
import type { SearchProviderId } from '../store'
import { decodeEntities, stripTags } from '../extract'
import { fetchWithTimeout, proxyRefusalHint, USER_AGENT } from './http'
import type { SearchResult } from './types'

// ---- Providers ---------------------------------------------------------------

/**
 * v4.1 (G2c): how recent the results must be — each provider's own filter, by
 * its own name: SearXNG `time_range`, Brave `freshness`, DuckDuckGo `df`. Set
 * by the app on live questions ("today", "this week", "latest"); the model's
 * own calls never carry it — it is not in the tool's schema.
 */
export type SearchRecency = 'day' | 'week' | 'month' | 'year'

export const SEARCH_RECENCIES: readonly SearchRecency[] = ['day', 'week', 'month', 'year']

const SEARXNG_TIME_RANGE: Record<SearchRecency, string> = { day: 'day', week: 'week', month: 'month', year: 'year' }
const BRAVE_FRESHNESS: Record<SearchRecency, string> = { day: 'pd', week: 'pw', month: 'pm', year: 'py' }
const DUCKDUCKGO_DF: Record<SearchRecency, string> = { day: 'd', week: 'w', month: 'm', year: 'y' }

/** The provider request URL, recency included. Exported so the parameters are pinned by test. */
export function providerSearchUrl(
  provider: SearchProviderId,
  query: string,
  maxResults: number,
  recency?: SearchRecency,
  searxngBase = ''
): string {
  const q = encodeURIComponent(query)
  switch (provider) {
    case 'searxng':
      return `${searxngBase}/search?q=${q}&format=json${recency ? `&time_range=${SEARXNG_TIME_RANGE[recency]}` : ''}`
    case 'brave':
      return (
        `https://api.search.brave.com/res/v1/web/search?q=${q}&count=${maxResults}` +
        (recency ? `&freshness=${BRAVE_FRESHNESS[recency]}` : '')
      )
    case 'duckduckgo':
      return `https://html.duckduckgo.com/html/?q=${q}${recency ? `&df=${DUCKDUCKGO_DF[recency]}` : ''}`
  }
}

export async function searchSearXNG(query: string, maxResults: number, recency?: SearchRecency): Promise<SearchResult[]> {
  const base = getSettings().search.searxngUrl.trim().replace(/\/+$/, '')
  if (!base) throw new Error('No SearXNG URL configured — set it under Settings → Search & research.')
  const url = providerSearchUrl('searxng', query, maxResults, recency, base)
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

export async function searchBrave(query: string, maxResults: number, recency?: SearchRecency): Promise<SearchResult[]> {
  const apiKey = getBraveApiKey()
  if (!apiKey) {
    throw new Error('No Brave Search API key set — add one under Settings → Search & research.')
  }
  const url = providerSearchUrl('brave', query, maxResults, recency)
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
export async function searchDuckDuckGo(query: string, maxResults: number, recency?: SearchRecency): Promise<SearchResult[]> {
  const url = providerSearchUrl('duckduckgo', query, maxResults, recency)
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
