/**
 * Response caching layer for chat completions.
 * Caches responses based on hash of messages + modelId to avoid redundant API calls.
 * TTL-based expiration prevents stale responses.
 */

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const MAX_CACHE_SIZE = 100

interface CacheEntry {
  response: string
  createdAt: number
  toolCalls?: any[]
}

const cache = new Map<string, CacheEntry>()

async function hashMessages(messages: any[], modelId: string): Promise<string> {
  const content = JSON.stringify({
    messages: messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    })),
    modelId
  })
  
  // Simple hash function (not cryptographically secure, but sufficient for cache keys)
  let hash = 0
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32bit integer
  }
  return `cache_${Math.abs(hash).toString(36)}_${modelId.replace(/[^a-z0-9]/gi, '_')}`
}

export async function getFromCache(
  messages: any[],
  modelId: string
): Promise<{ hit: true; response: string; toolCalls?: any[] } | { hit: false }> {
  const key = await hashMessages(messages, modelId)
  const entry = cache.get(key)
  
  if (!entry) {
    return { hit: false }
  }
  
  if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
    cache.delete(key)
    return { hit: false }
  }
  
  return { hit: true, response: entry.response, toolCalls: entry.toolCalls }
}

export async function setInCache(
  messages: any[],
  modelId: string,
  response: string,
  toolCalls?: any[]
): Promise<void> {
  const key = await hashMessages(messages, modelId)
  
  // Evict oldest entries if cache is full
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldestKey = cache.keys().next().value
    if (oldestKey) cache.delete(oldestKey)
  }
  
  cache.set(key, {
    response,
    toolCalls,
    createdAt: Date.now()
  })
}

export function clearCache(): void {
  cache.clear()
}

export function getCacheStats(): { size: number; oldestEntry?: number } {
  const oldest = Math.min(...Array.from(cache.values()).map(e => e.createdAt))
  return {
    size: cache.size,
    oldestEntry: cache.size > 0 ? oldest : undefined
  }
}
