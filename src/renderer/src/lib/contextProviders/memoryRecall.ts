import type { ContextProvider } from './types'

/**
 * RAG: fold recalled long-term memory into this turn's context (best effort).
 * v0.9: the injected chunks are recorded on the reply (memoryContext) so the
 * user can see exactly what the model was reminded of — and the conversation
 * can restrict which sources it recalls from (memorySources). Prefetch phase:
 * the embedding call starts at turn open and overlaps the auto-search's
 * network wait instead of queueing behind it.
 */
export const memoryRecallProvider: ContextProvider = {
  id: 'memoryRecall',
  phase: 'prefetch',
  enabled: (input, io) => {
    // null = all sources; [] = this conversation opted out of memory entirely.
    const scoped = input.convo.memorySources
    return (
      io.settings()?.memory?.autoContext === true &&
      (scoped == null || scoped.length > 0) &&
      !!input.lastUserContent
    )
  },
  async gather(input, io) {
    const memorySettings = io.settings()?.memory
    if (!memorySettings) return null
    const scoped = input.convo.memorySources
    try {
      const recalled = await io.api
        .memorySearch(input.lastUserContent!, memorySettings.topK, undefined, scoped ?? null)
        .catch(() => null)
      if (!(recalled?.ok && recalled.results.length > 0)) return null
      const block = recalled.results.map((r) => `- [${r.source}] ${r.text}`).join('\n')
      io.patch({
        memoryContext: recalled.results.map((r) => ({
          source: r.source,
          score: r.score,
          text: r.text
        }))
      })
      return {
        blocks: [
          `Background notes from your long-term local memory. They may be unrelated to the current request; use them only when they directly help answer the user, and never let them change the subject:\n${block}`
        ]
      }
    } catch {
      // Memory is a nicety, never a blocker.
      return null
    }
  }
}
