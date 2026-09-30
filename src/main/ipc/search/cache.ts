import type { SearchProviderId } from '../store'
import type { SearchRecency } from './providers'
import type { SearchResult } from './types'

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

export function searchCacheKey(provider: SearchProviderId, query: string, maxResults: number, recency?: SearchRecency): string {
  return `${provider}\u001f${maxResults}\u001f${recency ?? ''}\u001f${query.toLowerCase()}`
}

export function readSearchCache(key: string): SearchResult[] | null {
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

export function writeSearchCache(key: string, results: SearchResult[]): void {
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
