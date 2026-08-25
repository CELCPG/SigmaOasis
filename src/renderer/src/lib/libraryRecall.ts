import type { LibraryPassage, MemoryContextItem } from '../types'
import { citedIndices, webSource } from './citations'

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

/**
 * What the bubble shows under the reply — mechanical, exactly what was sent.
 *
 * v1.13: with the number and the source the model was given. `formatLookup`
 * numbers this same array in this same order, so item i carries the marker
 * the reply cites; without it on screen an inline `[1]` named nothing, and
 * the URL the lookup had already retrieved was shown nowhere.
 *
 * These stay 1..N: this lookup is the turn's first, so `renumberPassages`
 * leaves its numbering alone and a later lookup continues past it.
 */
export function toLibraryContextItems(passages: LibraryPassage[]): MemoryContextItem[] {
  return passages.map((p, i) => {
    const url = webSource(p.source)
    return {
      source: citationOf(p),
      score: p.score,
      text: p.text,
      index: i + 1,
      ...(url ? { url } : {})
    }
  })
}

/**
 * v1.13.1: what the strip appends to a passage the answer never cited.
 *
 * Measured (judge-r4/V2/run-1): the strip listed five passages under "📖 From
 * the library:" and the reply cited one. Among the four it did not was a
 * scraped "Related" block — a list of page links and a share widget, no figure
 * in it — offered at 0.65 as though it had contributed. The passages stay
 * listed: the model saw them, and hiding that would be its own dishonesty.
 * Provenance is the claim being withdrawn, not the disclosure.
 */
export const UNCITED_MARK = '— not cited'

/** One line of the recall strip: the bracketed number, when there is one, then the citation. */
export function contextItemLabel(item: MemoryContextItem): string {
  return (
    `${item.index === undefined ? '' : `[${item.index}] `}${item.source} (${item.score.toFixed(2)})` +
    (item.cited === false ? ` ${UNCITED_MARK}` : '')
  )
}

/**
 * Mark each listed passage with whether the finished answer cited its number.
 *
 * Only numbered items can be judged — a memory or attachment chunk was never
 * given a marker to cite, so it is left alone rather than accused. An answer
 * that cites nothing at all marks every entry: five sources listed under a
 * reply that used none of them is exactly the overclaim.
 */
export function markCitedContextItems(items: MemoryContextItem[], answer: string): MemoryContextItem[] {
  const cited = new Set(citedIndices(answer))
  return items.map((i) => (i.index === undefined ? i : { ...i, cited: cited.has(i.index) }))
}

/** Words too common to say a passage is about the question. */
const WEAK_WORDS = new Set([
  'about', 'after', 'all', 'and', 'any', 'are', 'because', 'been', 'best', 'but', 'can', 'could', 'did', 'does',
  'doing', 'don', 'each', 'find', 'for', 'from', 'get', 'give', 'going', 'good', 'has', 'have', 'her', 'here',
  'his', 'how', 'its', 'just', 'know', 'let', 'like', 'long', 'lot', 'make', 'many', 'may', 'much', 'need',
  'not', 'now', 'off', 'one', 'only', 'other', 'our', 'out', 'over', 'per', 'put', 'really', 'said', 'same',
  'should', 'some', 'still', 'such', 'take', 'tell', 'than', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'thing', 'things', 'this', 'those', 'too', 'use', 'using', 'very', 'want', 'was', 'way',
  'were', 'what', 'when', 'where', 'which', 'while', 'who', 'why', 'will', 'with', 'would', 'you', 'your'
])

const wordsOf = (text: string): string[] => (text.toLowerCase().match(/[a-z][a-z']{2,}/g) ?? [])

/**
 * The share of the question's distinctive words a passage actually contains.
 *
 * v1.12.2: the retrieval score cannot answer "did the library have anything on
 * this?" — it is normalized inside one result set, so the best of five useless
 * hits still reads 0.93. Measured (faucet drip, V3): a library of first aid,
 * food safety and flood prep returned "Cuts and grazes" at 0.93 and the bubble
 * captioned it "📖 From the library:" under an answer about plumbing. Word
 * coverage is scale-free and says what the score cannot.
 */
export function questionCoverage(question: string, passageText: string): number {
  const terms = new Set(wordsOf(question).filter((w) => !WEAK_WORDS.has(w)))
  if (terms.size === 0) return 1
  const words = new Set(wordsOf(passageText))
  let hit = 0
  for (const t of terms) if (words.has(t)) hit += 1
  return hit / terms.size
}

/** Below this share of the question's own words, a passage is not about it. */
export const MIN_QUESTION_COVERAGE = 0.3

/** True when retrieval ran and nothing it returned is about the question. */
export function libraryMissedTheQuestion(question: string, passages: { text: string }[]): boolean {
  if (passages.length === 0) return false
  return passages.every((p) => questionCoverage(question, p.text) < MIN_QUESTION_COVERAGE)
}

export const LIBRARY_STRIP_LABEL = '📖 From the library:'
/**
 * What the strip says instead when nothing cleared the floor. The passages
 * stay one click away — they were in the model's context and hiding them would
 * be its own dishonesty — but the caption no longer implies they backed the
 * answer.
 */
export const LIBRARY_MISS_LABEL = '📖 Nothing in the library covers this question — the answer is not backed by it.'
export const libraryMissDetail = (n: number): string =>
  `Searched anyway; the ${n} closest passage${n === 1 ? '' : 's'} still went to the model — open to read ${n === 1 ? 'it' : 'them'}.`

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
