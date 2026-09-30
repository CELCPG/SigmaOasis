import { chatComplete, resolveChatModel } from '../llm'
import { ASSIST_DEADLINE_MS, withDeadline } from './modelAssist'

/**
 * v4.2 (L3): query expansion with a hypothetical answer (HyDE), for the same
 * high-stakes domains as the re-rank (modelAssist.ts).
 *
 * "How do I make flood water safe to drink" never says *boil*, so neither
 * BM25 nor the question's own embedding reaches the "Boiling" section
 * (STRATEGY-capability-multipliers.md §B2). A short answer written by the
 * model does say it — right or wrong in its details, it is written in the
 * vocabulary of the passage that answers. So the lookup embeds that answer
 * and averages it with the question's vector for the semantic leg.
 *
 * Embedding-side only: the text goes to the loopback embedder and nowhere
 * else — not into BM25, not into the relevance floor, not into the passages,
 * notes or citations the model is handed, and never onto the wire to a
 * search provider (the library has no network leg to put it on). Bounded: 120
 * output tokens, 1,200 characters kept, a ~4 s deadline, and cached per
 * question so the prefetch and the model's own reference_lookup of the same
 * question pay once.
 */

/** Output cap: two or three sentences is all the embedding needs. */
const HYDE_MAX_TOKENS = 120
/** Questions remembered. The prefetch and the model's own tool call often ask the same one within a turn. */
const HYDE_CACHE_MAX = 64
/** A failed expansion is retried after this long, not on the very next lookup. */
const HYDE_FAILURE_TTL_MS = 60_000

const hydeCache = new Map<string, Promise<string | null>>()

/** Test seam: forget every cached expansion. */
export function clearHydeCacheForTests(): void {
  hydeCache.clear()
}

/**
 * A short passage written as a reference manual would answer `query`, for
 * embedding only. Cached per (model, question) — in-flight included, so two
 * lookups of one question make one call — and bounded: the oldest question
 * is forgotten first. Null on failure or timeout.
 */
export function hypotheticalAnswer(query: string, modelId?: string): Promise<string | null> {
  const key = `${modelId ?? ''}\n${query.trim().toLowerCase()}`
  const cached = hydeCache.get(key)
  if (cached) {
    // Refresh recency: Map order is insertion order.
    hydeCache.delete(key)
    hydeCache.set(key, cached)
    return cached
  }
  const pending = (async (): Promise<string | null> => {
    const model = await resolveChatModel(modelId)
    if (!model) return null
    const text = await withDeadline(
      (signal) =>
        chatComplete({
          model,
          messages: [
            {
              role: 'system',
              content:
                'Write the passage a reference manual would contain that answers the question: two or three ' +
                'plain sentences, stating the method, figures or steps directly. No preamble, no hedging, no lists.'
            },
            { role: 'user', content: query }
          ],
          temperature: 0,
          maxTokens: HYDE_MAX_TOKENS,
          thinking: false,
          signal,
          timeoutMs: ASSIST_DEADLINE_MS
        }),
      ASSIST_DEADLINE_MS
    )
    const trimmed = (text ?? '').trim()
    return trimmed ? trimmed.slice(0, 1_200) : null
  })()
  hydeCache.set(key, pending)
  while (hydeCache.size > HYDE_CACHE_MAX) hydeCache.delete(hydeCache.keys().next().value as string)
  void pending.then((text) => {
    if (text !== null) return
    const t = setTimeout(() => {
      if (hydeCache.get(key) === pending) hydeCache.delete(key)
    }, HYDE_FAILURE_TTL_MS)
    t.unref?.()
  })
  return pending
}
