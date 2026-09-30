import { tokenize } from '../retrieval'

/**
 * v4.2 (L4): the wrong-section guard.
 *
 * Section-aware chunking (v1.7) made every passage about one section, but it
 * did not make the ranking prefer the right one. A "how long do I boil water"
 * question scores the Chlorination section — which says *boil* and *water*
 * in passing, and says *water* more often — within a hair of the Boiling
 * section that answers it, and a hair is enough for the model to quote
 * chlorination's "30 minutes" (STRATEGY-capability-multipliers.md §B2 has the
 * eval's version). The section heading is the cheapest evidence of what a
 * passage is *about*, and the fusion ignores it.
 *
 * So: when two candidates' relevance is within SECTION_TIE of each other, one
 * whose heading shares a content word with the question moves ahead of one
 * whose heading does not. Only a near-tie is broken — a clearly better
 * passage under an unhelpful heading keeps its place — and the scores stay
 * with the positions, so the result reads as the same ranking with two
 * neighbours swapped. Deterministic, no model, no I/O.
 */

/** Relevance (0..1, min-max scaled) within which a heading match breaks the tie. */
export const SECTION_TIE = 0.05

/**
 * A light stem, so "Boiling" meets "boil" and "Burns" meets "burn". String
 * operations rather than a pattern: the question and the heading are both
 * short, and the suffix list is the whole rule. Never shortens below three
 * letters, so "gas" stays "gas".
 */
export function stem(term: string): string {
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (term.length - suffix.length >= 3 && term.endsWith(suffix)) return term.slice(0, -suffix.length)
  }
  return term
}

/** Does `heading` share a (stemmed) word with the question's content terms? */
export function headingMatches(heading: string, questionStems: ReadonlySet<string>): boolean {
  if (!heading || questionStems.size === 0) return false
  return tokenize(heading).some((t) => questionStems.has(stem(t)))
}

/**
 * Reorder `ranked` (best first) so that within a near-tie a heading match
 * leads. Stable otherwise. Returns a new array; each position keeps the
 * relevance that position had, so callers can write it back as the score.
 */
export function preferMatchingSections<T extends { id: string; relevance: number }>(
  ranked: readonly T[],
  matches: (id: string) => boolean,
  tie: number = SECTION_TIE
): T[] {
  const items = ranked.map((r) => ({ item: r, match: matches(r.id) }))
  if (!items.some((x) => x.match) || items.every((x) => x.match)) return [...ranked]
  for (let i = 1; i < items.length; i++) {
    // Bubble a matching item up past non-matching ones it nearly ties with,
    // comparing original relevances so one move cannot license the next.
    let j = i
    while (
      j > 0 &&
      items[j].match &&
      !items[j - 1].match &&
      items[j - 1].item.relevance - items[j].item.relevance <= tie
    ) {
      const above = items[j - 1]
      items[j - 1] = items[j]
      items[j] = above
      j -= 1
    }
  }
  return items.map((x, k) => ({ ...x.item, relevance: ranked[k].relevance }))
}
