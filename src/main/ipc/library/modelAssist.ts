import { chatCompleteJson, resolveChatModel } from '../llm'
import { getSettings } from '../store'
import { referenceDomains } from '../../../renderer/src/lib/grounding'

/**
 * v4.2 (L2): a ranking aid that asks the answering model, for the domains
 * where a wrong passage is expensive. (L3's query expansion, hyde.ts, shares
 * the domain gate, the settings read and the deadline below.)
 *
 * The library eval's stable failure (STRATEGY-capability-multipliers.md §B2)
 * is a retrieval one: the dedicated "Boiling" section ranked below flood
 * passages because the question never says *boil*, and a wrong-section
 * passage is then quoted with full confidence. Keyword + embedding fusion
 * cannot see that a passage shares the question's words but answers a
 * different question; the model that is about to answer can. So, in health,
 * first aid, finance and building/structural questions only, the top
 * candidates after fusion are shown to the model, which lists the ones that
 * actually answer the question; the lookup returns those first and drops the
 * rest.
 *
 * One extra model call, capped (tokens and a ~4 s deadline), thinking closed,
 * structured JSON where the server supports it, and the fused order stands on
 * any failure. Ships off (Settings → Grounding & checks) because every lookup
 * in those domains pays for it; docs/library-ranking.md has the cost.
 */

/** Domains a wrong passage costs most in — the grounding module's own detectors decide. */
const STAKES_DOMAINS = new Set(['first-aid', 'health', 'building', 'finance'])

/** The high-stakes domain a lookup query falls in, or null. */
export function stakesDomain(query: string): string | null {
  return referenceDomains(query).find((d) => STAKES_DOMAINS.has(d)) ?? null
}

/**
 * Settings read defensively: a store written before v4.2 has neither key,
 * and the switches default off.
 */
export function assistSettings(): { rerank: boolean; hyde: boolean } {
  const g = (getSettings() as { grounding?: { libraryRerank?: unknown; libraryHyde?: unknown } }).grounding
  return { rerank: g?.libraryRerank === true, hyde: g?.libraryHyde === true }
}

/**
 * One deadline for a model call, whatever it is doing. A lookup is on the
 * path to the first token of the reply, so the aid either lands inside it or
 * is abandoned and the fused order stands. The abort also cancels the request
 * so an abandoned call does not keep the model busy behind the real answer.
 */
export const ASSIST_DEADLINE_MS = 4_000

export async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T | null> {
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      abort.abort()
      resolve(null)
    }, ms)
  })
  try {
    return await Promise.race([run(abort.signal).catch(() => null), expired])
  } finally {
    clearTimeout(timer)
  }
}

// ---- L2: re-rank ------------------------------------------------------------

/** Candidates shown to the model: enough to reach past a wrong-section cluster, few enough to prefill fast. */
export const RERANK_POOL = 15
/** Characters of each passage the model reads. The answering sentence is near the top of a section chunk. */
const RERANK_PASSAGE_CHARS = 600
/** Output cap: a list of at most fifteen small integers. */
const RERANK_MAX_TOKENS = 80

export interface RerankCandidate {
  id: string
  label: string
  text: string
}

/**
 * Ask the model which candidates answer `query`. Returns their ids in the
 * model's order — best first — or null when the call failed, timed out, or
 * named nothing usable (an empty list is treated as no signal, not as "none
 * answer": the relevance floor already judged these, and the renderer's miss
 * check still reads what is returned).
 */
export async function rerankPassages(query: string, candidates: RerankCandidate[], modelId?: string): Promise<string[] | null> {
  const pool = candidates.slice(0, RERANK_POOL)
  if (pool.length < 2) return null
  const model = await resolveChatModel(modelId)
  if (!model) return null
  const listing = pool
    .map((c, i) => `[${i + 1}] (${c.label})\n${c.text.length > RERANK_PASSAGE_CHARS ? `${c.text.slice(0, RERANK_PASSAGE_CHARS)}…` : c.text}`)
    .join('\n\n')
  const parsed = await withDeadline(
    (signal) =>
      chatCompleteJson<{ answering?: unknown }>({
        model,
        messages: [
          {
            role: 'system',
            content:
              'You judge reference passages for a question. List the numbers of the passages that directly ' +
              'answer the question, most useful first. Leave out passages about a different situation, method ' +
              'or topic, even when they share words with the question. Return JSON only: {"answering": [numbers]}.'
          },
          { role: 'user', content: `Question: ${query}\n\nPassages:\n\n${listing}` }
        ],
        temperature: 0,
        maxTokens: RERANK_MAX_TOKENS,
        thinking: false,
        signal,
        timeoutMs: ASSIST_DEADLINE_MS,
        jsonSchema: {
          name: 'library_rerank',
          schema: {
            type: 'object',
            properties: {
              answering: { type: 'array', items: { type: 'integer', minimum: 1, maximum: pool.length }, maxItems: pool.length }
            },
            required: ['answering'],
            additionalProperties: false
          }
        }
      }),
    ASSIST_DEADLINE_MS
  )
  const picks = Array.isArray(parsed?.answering) ? parsed.answering : []
  const ids: string[] = []
  for (const n of picks) {
    const i = typeof n === 'number' ? n : Number(n)
    // A number off the list, or a repeat, is dropped rather than trusted.
    if (!Number.isInteger(i) || i < 1 || i > pool.length) continue
    const id = pool[i - 1].id
    if (!ids.includes(id)) ids.push(id)
  }
  return ids.length > 0 ? ids : null
}
