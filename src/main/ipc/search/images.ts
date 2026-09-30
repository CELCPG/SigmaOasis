import { getBraveApiKey, getSettings } from '../store'
import { fetchWithTimeout, proxyRefusalHint, USER_AGENT } from './http'
import { sanitizeQuery } from './query'
import type { ImageResult, ImageSearchOutcome } from './types'

// ---- Image search ------------------------------------------------------------

/** Protocol-relative URLs (`//cdn.example/…`) need a scheme before parsing. */
function absoluteHttpUrl(url: string): string {
  return url.startsWith('//') ? `https:${url}` : url
}

async function searchSearXNGImages(query: string, maxResults: number): Promise<ImageResult[]> {
  const base = getSettings().search.searxngUrl.trim().replace(/\/+$/, '')
  if (!base) throw new Error('No SearXNG URL configured — set it under Settings → Search & research.')
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
    throw new Error('No Brave Search API key set — add one under Settings → Search & research.')
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
  const { query, redactions, refusal, refusalReason } = sanitizeQuery(String(rawQuery ?? ''))
  const provider = settings.provider

  // Same three never-contacted paths as runWebSearch; same reasoning.
  if (!query) {
    return {
      ok: false,
      provider,
      images: [],
      redactions,
      sentQuery: '',
      error: 'Empty image search query.',
      declined: 'the query was empty'
    }
  }
  if (refusal) {
    return {
      ok: false,
      provider,
      images: [],
      redactions,
      sentQuery: '',
      error: refusal,
      declined: refusalReason ?? 'the query was not usable as search terms'
    }
  }
  const limit = Math.min(Math.max(1, Math.round(maxResults) || 1), MAX_IMAGE_RESULTS)

  if (settings.confirmBeforeSearch && beforeSend && !(await beforeSend(query))) {
    return {
      ok: false,
      provider,
      images: [],
      redactions,
      sentQuery: query,
      error: 'The user declined this image search.',
      declined: 'the user declined this image search'
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
