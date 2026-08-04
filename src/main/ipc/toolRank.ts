import { ipcMain } from 'electron'
import { cosine, embedTexts, NoEmbeddingModelError, resolveEmbeddingModel } from './embeddings'

/**
 * Per-turn tool subsetting (strategy Layer 1b).
 *
 * Even inside a role's allowlist, most turns need two tools, not seven — and
 * every schema on the wire evicts conversation history. This module ranks a
 * turn's candidate tools against the user's message by embedding cosine, so
 * the renderer can send the always-on tools plus the top matches instead of
 * the whole list.
 *
 * It is an optimization, never a gate: any failure — no embedding model, an
 * HTTP error, a malformed request — returns { ok: false } and the renderer
 * falls back to the full per-role allowlist.
 *
 * Tool descriptions are embedded once and cached (keyed by model + text, so
 * a mid-session embedding-model swap cannot mix vector spaces); the per-turn
 * cost is a single /embeddings round-trip for the query alone.
 */

const descriptionVectors = new Map<string, number[]>()

export async function rankToolsByRelevance(
  query: string,
  tools: { name: string; description: string }[]
): Promise<Record<string, number>> {
  // Resolve first so cache keys carry the model — a mid-session embedding
  // model swap must not mix vector spaces.
  const model = await resolveEmbeddingModel()
  if (!model) throw new NoEmbeddingModelError()
  const key = (description: string): string => `${model} ${description}`

  const missing = tools.map((t) => t.description).filter((d) => !descriptionVectors.has(key(d)))
  // One batch: the query plus any not-yet-cached descriptions.
  const { vectors } = await embedTexts([query, ...missing])
  const queryVector = vectors[0]
  missing.forEach((d, i) => descriptionVectors.set(key(d), vectors[i + 1]))

  const scores: Record<string, number> = {}
  for (const t of tools) {
    const cached = descriptionVectors.get(key(t.description))
    scores[t.name] = cached ? cosine(queryVector, cached) : 0
  }
  return scores
}

export function registerToolRankHandlers(): void {
  ipcMain.handle(
    'tools:rank',
    async (_e, query: unknown, tools: { name: string; description: string }[]) => {
      try {
        if (typeof query !== 'string' || !query.trim() || !Array.isArray(tools) || tools.length === 0) {
          return { ok: false, error: 'tools:rank needs a query and at least one tool' }
        }
        const scores = await rankToolsByRelevance(query, tools)
        return { ok: true, scores }
      } catch (err) {
        // Fallback is the renderer's full allowlist — never a turn failure.
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}
