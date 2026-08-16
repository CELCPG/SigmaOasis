import { formatLookup, lookupLibrary, MAX_LOOKUP_PASSAGES } from '../library'
import { truncate } from './types'
import type { ToolHandler } from './types'

/**
 * reference_lookup — the Almanac's tool face. Reads the user's installed
 * reference packs (and folder packs of their own documents); no network, and
 * the passages arrive with provenance the model is told to carry into its
 * answer. Not prefixed UNTRUSTED_HEADER: these are documents the user chose
 * to install, not text pulled from the public web mid-turn.
 */
const MAX_LIBRARY_OUTPUT_CHARS = 10_000

const referenceLookup: ToolHandler = async (args) => {
  const query = String(args.query ?? '').trim()
  if (!query) return { ok: false, error: 'A query is required.' }
  const requested = Number(args.max_passages)
  const topK = Number.isFinite(requested) ? Math.min(MAX_LOOKUP_PASSAGES, Math.max(1, Math.round(requested))) : 6
  const packId = typeof args.pack === 'string' && args.pack.trim() ? args.pack.trim() : null
  const outcome = await lookupLibrary({ query, packId, topK })
  if (!outcome.ok) return { ok: false, error: outcome.error ?? 'Lookup failed.' }
  return { ok: true, output: truncate(formatLookup(outcome, query), MAX_LIBRARY_OUTPUT_CHARS) }
}

export const libraryHandlers = {
  reference_lookup: referenceLookup
} satisfies Record<string, ToolHandler>
