import type { ContextProvider } from './types'
import { buildSearchContext, looksLive } from '../grounding'
import {
  LIVE_READ_TIMEOUT_MS,
  MAX_APP_QUERIES,
  SNIPPETS_ONLY_NOTE,
  buildPageReadContext,
  pagesToRead,
  planAppSearch
} from '../appSearch'

/**
 * v1.1 auto-verify: small models almost never volunteer a web_search on a
 * factual question, so the app runs one itself and injects the results as
 * reference context. The option to confabulate is removed, not discouraged.
 * Gated on the slot's full allowlist (never the embedder's per-turn subset —
 * an app-run search must not depend on the embedder's opinion); offline the
 * library provider takes its place. A failure never blocks the turn.
 *
 * v4.1 (G2): the query is the question rewritten, not the sentence; a question
 * about now asks the provider for recent results; and a live question has its
 * top result pages read, so the model is handed their text, not only snippets
 * (lib/appSearch.ts). The page reads are bounded (LIVE_READ_TIMEOUT_MS, both at
 * once) and spend none of the model's own fetch budget.
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
    const plan = planAppSearch(input.lastUserContent!, input.previousUserContent)
    const queries = plan.queries.slice(0, MAX_APP_QUERIES)
    const searched = await Promise.all(
      queries.map((query) => io.runTool('web_search', { query, ...(plan.recency ? { recency: plan.recency } : {}) }))
    )
    const blocks: string[] = []
    const outputs: string[] = []
    searched.forEach((result, i) => {
      if (!result.ok) return
      blocks.push(buildSearchContext(queries[i], result.output ?? ''))
      outputs.push(result.output ?? '')
    })
    if (blocks.length === 0) return null

    if (looksLive(input.lastUserContent)) {
      const canRead = input.slotTools.some((t) => t.function.name === 'fetch_webpage')
      const urls = canRead ? pagesToRead(outputs) : []
      const read = await Promise.all(
        urls.map((url) =>
          io.runTool(
            'fetch_webpage',
            { url, query: queries[0], max_passages: 2, timeout_ms: LIVE_READ_TIMEOUT_MS },
            { charge: false }
          )
        )
      )
      const pages = read.filter((r) => r.ok && r.output).map((r) => r.output!)
      blocks.push(pages.length > 0 ? buildPageReadContext(pages) : SNIPPETS_ONLY_NOTE)
    }
    return { blocks }
  }
}
