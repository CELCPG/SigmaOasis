import type { LibraryPassage, MemoryContextItem } from '../types'

/**
 * v1.5: app-initiated reference lookup — the renderer half.
 *
 * The same move the v1.1 auto-search makes for factual turns, for the domains
 * a reference book answers: when the user's message reads as first aid,
 * health, finance rules, legal/civic, preparedness or home repair — or when
 * the app is offline and the turn is factual at all — the app queries the
 * local reference library itself before the model speaks and hands the
 * passages over. The option to recite a dosage from memory is removed, not
 * discouraged. Headless so the decision and the labelling are pinned by tests.
 */

/** Passages injected per turn. Small: a 9B model reads six well, not sixteen. */
export const LIBRARY_PASSAGES_PER_TURN = 5

/**
 * Should this turn consult the library before the model answers?
 * `enabled` = reference_lookup is on for this slot; `reference` / `factual`
 * = grounding.ts classifiers; `offline` = the renderer reports no network.
 */
export function shouldConsultLibrary(input: {
  enabled: boolean
  reference: boolean
  factual: boolean
  offline: boolean
}): boolean {
  if (!input.enabled) return false
  return input.reference || (input.offline && input.factual)
}

/** The renderer's view of "are we offline" — Chromium's own signal, nothing more. */
export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

/** Citation as shown in the strip: pack › document › section · N% in. */
export function citationOf(p: LibraryPassage): string {
  const parts = [p.packName, p.docTitle]
  if (p.section) parts.push(p.section)
  return `${parts.join(' › ')} · ${Math.round(p.position * 100)}% in`
}

/** What the bubble shows under the reply — mechanical, exactly what was sent. */
export function toLibraryContextItems(passages: LibraryPassage[]): MemoryContextItem[] {
  return passages.map((p) => ({ source: citationOf(p), score: p.score, text: p.text }))
}

/**
 * The turn-context block. `formatted` is the main process's model-facing
 * rendering (library.ts formatLookup) — the same text the tool would return —
 * prefixed with why it is here and what to do if it does not answer.
 */
export function buildLibraryContext(formatted: string, offline: boolean): string {
  return (
    (offline
      ? 'The app is offline, so the local reference library was consulted automatically before ' +
        'you answered. '
      : 'This question is in a domain the local reference library covers, so it was consulted ' +
        'automatically before you answered. ') +
    'Use these passages if they bear on the question — cite them by their bracketed number and ' +
    'quote steps, figures and dosages rather than paraphrasing. If they do not answer it, say so; ' +
    'do not fill the gap from memory.\n' +
    formatted
  )
}
