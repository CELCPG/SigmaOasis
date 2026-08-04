/**
 * v1.4 response cache for chat completions.
 *
 * Keyed on the exact wire messages plus the model id, with a short TTL. The
 * point is the repeated-question case — asking the same thing twice in a
 * session, or re-sending after an edit — where a local model would otherwise
 * spend seconds regenerating a byte-identical answer.
 *
 * Deliberately narrow, because a cache that returns a stale or wrong answer is
 * worse than no cache at all:
 *
 * - RAM only. Nothing is written to disk, so a cached reply can never outlive
 *   the session or leak into `conversations/`. This keeps the ephemeral-chat
 *   promise intact: no new on-disk trace of anything said.
 * - Opt-in per call site. Only the main chat path caches. The critic,
 *   claim-check, consultation and plan-step passes stay live — a cached verdict
 *   would silently re-verify nothing.
 * - Never caches a round that produced tool calls, and never serves a cached
 *   round to a request that offers tools. Tool output is time-varying by
 *   definition (search, prices, the clock), so a cached tool round could
 *   restate yesterday's figures as today's.
 * - Stores the full key material and compares it on hit, so a hash collision
 *   degrades to a miss rather than to somebody else's answer.
 */

import type { ApiMessage } from './agentLoop'

const CACHE_TTL_MS = 5 * 60 * 1000
const MAX_CACHE_SIZE = 100

interface CacheEntry {
  /** Exact serialized key material, re-checked on hit to rule out collisions. */
  keyContent: string
  response: string
  reasoning: string
  createdAt: number
}

const cache = new Map<string, CacheEntry>()

function keyMaterial(messages: ApiMessage[], modelId: string): string {
  return JSON.stringify({
    modelId,
    messages: messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? null)
    }))
  })
}

/**
 * FNV-1a over two 32-bit lanes. Not cryptographic — it only has to spread keys
 * across the map. Correctness does not rest on it: `keyContent` is compared in
 * full before any hit is returned.
 */
function hashKey(content: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 ^ c, 0x85ebca6b)
  }
  return `${(h1 >>> 0).toString(36)}_${(h2 >>> 0).toString(36)}_${content.length.toString(36)}`
}

export interface CacheHit {
  hit: true
  response: string
  reasoning: string
}

export function getFromCache(messages: ApiMessage[], modelId: string): CacheHit | { hit: false } {
  const content = keyMaterial(messages, modelId)
  const key = hashKey(content)
  const entry = cache.get(key)
  if (!entry) return { hit: false }

  if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
    cache.delete(key)
    return { hit: false }
  }
  // Collision guard: a matching hash with different key material is a miss.
  if (entry.keyContent !== content) return { hit: false }

  return { hit: true, response: entry.response, reasoning: entry.reasoning }
}

export function setInCache(
  messages: ApiMessage[],
  modelId: string,
  response: string,
  reasoning = ''
): void {
  if (!response) return
  const content = keyMaterial(messages, modelId)
  const key = hashKey(content)

  // Oldest-first eviction: Map preserves insertion order, and re-caching an
  // existing key deletes it first so it re-enters at the back.
  cache.delete(key)
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }

  cache.set(key, { keyContent: content, response, reasoning, createdAt: Date.now() })
}

/** Called when settings change under the cache, and on context rollback. */
export function clearCache(): void {
  cache.clear()
}

export function getCacheStats(): { size: number; oldestEntry?: number } {
  if (cache.size === 0) return { size: 0 }
  let oldest = Infinity
  for (const entry of cache.values()) {
    if (entry.createdAt < oldest) oldest = entry.createdAt
  }
  return { size: cache.size, oldestEntry: oldest }
}
