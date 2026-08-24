import type { ContextProvider } from './types'
import { buildSearchQuery } from '../grounding'
import {
  LIBRARY_PASSAGES_PER_TURN,
  buildLibraryContext,
  libraryMissedTheQuestion,
  shouldConsultLibrary,
  toLibraryContextItems
} from '../libraryRecall'

/**
 * v1.5 app-initiated reference lookup (STRATEGY-depth-and-reasoning.md,
 * Feature A). For the domains a reference book answers — first aid, health,
 * finance rules, legal, preparedness, home repair — and for any factual turn
 * while offline, the app consults the local library before the model speaks
 * and hands the passages over with their citations. Local and private, so the
 * trigger is broad; an empty library or no match injects nothing (and records
 * nothing — only a lookup that returned passages counts as a source).
 */
export const libraryPassagesProvider: ContextProvider = {
  id: 'libraryPassages',
  phase: 'serial',
  enabled: (input) =>
    !!input.lastUserContent &&
    shouldConsultLibrary({
      enabled: input.slotTools.some((t) => t.function.name === 'reference_lookup'),
      reference: input.referenceTurn,
      factual: input.factualTurn,
      offline: input.offline
    }),
  async gather(input, io) {
    const query = buildSearchQuery(input.lastUserContent!, input.previousUserContent)
    const looked = await io.api.libraryLookup(query, null, LIBRARY_PASSAGES_PER_TURN).catch(() => null)
    if (!(looked?.ok && looked.passages.length > 0 && looked.formatted)) return null
    // Recorded like the auto-search: a tool-call record the user can open,
    // an audit line, and a source for the grounding check.
    io.recordSyntheticCall('reference_lookup', { query }, looked.formatted)
    io.patch({
      libraryContext: toLibraryContextItems(looked.passages),
      // The lookup fires on the domain, not on the corpus: a library with no
      // plumbing in it still returns its five closest passages. Whether any of
      // them is about the question is a separate fact, and the strip says so.
      libraryMiss: libraryMissedTheQuestion(input.lastUserContent!, looked.passages)
    })
    return { blocks: [buildLibraryContext(looked.formatted, input.offline)] }
  }
}
