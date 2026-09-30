import { getSettings } from '../store'
import { readSearchCache, searchCacheKey, writeSearchCache } from './cache'
import { SEARCH_RECENCIES, searchBrave, searchDuckDuckGo, searchSearXNG } from './providers'
import type { SearchRecency } from './providers'
import { sanitizeQuery } from './query'
import type { SearchResult, WebSearchOutcome } from './types'

export async function runWebSearch(
  rawQuery: string,
  beforeSend?: (sanitizedQuery: string) => Promise<boolean>,
  /** v4.1 (G2c): ask the provider for recent results only. See `SearchRecency`. */
  options: { recency?: SearchRecency } = {}
): Promise<WebSearchOutcome> {
  const settings = getSettings().search
  const { query, redactions, refusal, refusalReason } = sanitizeQuery(String(rawQuery ?? ''))
  const provider = settings.provider
  const recency = options.recency && SEARCH_RECENCIES.includes(options.recency) ? options.recency : undefined

  // Every `declined` below is a path on which nothing was contacted. They are
  // errors to the model — it has to do something else — but they are not
  // failures, and the tool row must not draw them as one.
  if (!query) {
    return {
      ok: false,
      provider,
      results: [],
      redactions,
      sentQuery: '',
      error: 'Empty search query.',
      declined: 'the query was empty'
    }
  }
  // Refused before the cache and before the wire: a paragraph about the user
  // is neither a good search nor theirs to disclose. The model gets told how
  // to fix it and calls again.
  if (refusal) {
    return {
      ok: false,
      provider,
      results: [],
      redactions,
      sentQuery: '',
      error: refusal,
      declined: refusalReason ?? 'the query was not usable as search terms'
    }
  }

  // A cache hit sends nothing, so it is checked before the confirmation prompt —
  // there is no outgoing query for the user to approve.
  const key = searchCacheKey(provider, query, settings.maxResults, recency)
  const cached = readSearchCache(key)
  if (cached) {
    return { ok: true, provider, results: cached, redactions, sentQuery: query, cached: true, ...(recency ? { recency } : {}) }
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
      error: 'The user declined this web search.',
      declined: 'the user declined this search'
    }
  }

  const ask = (within?: SearchRecency): Promise<SearchResult[]> => {
    switch (provider) {
      case 'searxng':
        return searchSearXNG(query, settings.maxResults, within)
      case 'brave':
        return searchBrave(query, settings.maxResults, within)
      case 'duckduckgo':
        return searchDuckDuckGo(query, settings.maxResults, within)
    }
  }
  try {
    let results = await ask(recency)
    let applied = recency
    // v4.1 (G2c): a filter that emptied the page is worse than no filter. Asked
    // once more without it — the same query, already disclosed and approved, so
    // nothing new leaves the machine but the request itself.
    if (recency && results.length === 0) {
      results = await ask(undefined)
      applied = undefined
    }
    // Only successful, non-empty responses are cached: caching a transient empty
    // result would hide a working query for the whole TTL.
    if (results.length > 0) writeSearchCache(key, results)
    return { ok: true, provider, results, redactions, sentQuery: query, cached: false, ...(applied ? { recency: applied } : {}) }
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

/** Settings → Search & research "Test connection" button. */
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
