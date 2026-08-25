import type { ContextProvider } from './types'
import { buildSearchContext, buildSearchQuery } from '../grounding'

/**
 * v1.1 auto-verify: small models almost never volunteer a web_search on a
 * factual question, so the app runs one itself and injects the results as
 * reference context. The option to confabulate is removed, not discouraged.
 * Gated on the slot's full allowlist (never the embedder's per-turn subset —
 * an app-run search must not depend on the embedder's opinion); offline the
 * library provider takes its place. A failure never blocks the turn.
 */
export const autoSearchProvider: ContextProvider = {
  id: 'autoSearch',
  phase: 'serial',
  wait: {
    label: 'Searching the web',
    detail: 'the app checks sources before the model is asked'
  },
  enabled: (input) =>
    input.factualTurn &&
    !input.offline &&
    !!input.lastUserContent &&
    input.slotTools.some((t) => t.function.name === 'web_search'),
  async gather(input, io) {
    // The user message before this one anchors context-dependent follow-ups
    // ("lets go with the first one") so the query carries the topic too.
    const query = buildSearchQuery(input.lastUserContent!, input.previousUserContent)
    const result = await io.runTool('web_search', { query })
    if (!result.ok) return null
    return { blocks: [buildSearchContext(query, result.output ?? '')] }
  }
}
