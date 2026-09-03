import type { LibraryPassage, MemoryContextItem, ToolCallRecord } from '../types'
import { MEMORY_ORIGIN_LABELS } from '../../../shared/memoryOrigin'
import {
  citedIndices,
  danglingCitations,
  retrievedCitations,
  turnLookups,
  webSource,
  type Citation
} from './citations'

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

/**
 * v1.17.2: what the strip appends instead when it cannot tell.
 *
 * "— not cited" is a claim about the answer, and the app can only make it while
 * it can account for every marker the answer used. When one of them names no
 * listed passage the marker→passage map is known-incomplete — a tool result cut
 * by the output cap really does drop passages the model read, and a
 * conversation recorded before per-turn numbering holds two `[1]`s of which the
 * app can only see one. Measured (judge-r7/V2/run-1): the reply cited `[2][5]`,
 * the binder never saw the `[5]`, and the strip stated as fact that the passage
 * the reply had just quoted went uncited. Saying nothing would read as "cited";
 * this says which of the two it is.
 */
export const UNSETTLED_MARK = '— cannot tell'

/** One line of the recall strip: the bracketed number, when there is one, then the citation. */
export function contextItemLabel(item: MemoryContextItem): string {
  // v2.6: a memory's origin is part of its citation when it is not the user's
  // own — the reader should know a recalled note was a model's.
  const origin = item.origin && item.origin !== 'user' ? ` · ${MEMORY_ORIGIN_LABELS[item.origin]}` : ''
  return (
    `${item.index === undefined ? '' : `[${item.index}] `}${item.source} (${item.score.toFixed(2)})${origin}` +
    (item.cited === false ? ` ${UNCITED_MARK}` : item.unsettled ? ` ${UNSETTLED_MARK}` : '')
  )
}

/**
 * Mark each listed passage with whether the finished answer cited its number.
 *
 * Only numbered items can be judged — a memory or attachment chunk was never
 * given a marker to cite, so it is left alone rather than accused. An answer
 * that cites nothing at all marks every entry: five sources listed under a
 * reply that used none of them is exactly the overclaim.
 *
 * v1.17.2: the negative is withheld when a marker resolves to nothing. See
 * `UNSETTLED_MARK`. The positive is not — a marker that names a listed passage
 * is evidence that passage was used, whatever the app failed to resolve
 * elsewhere.
 */
export function markCitedContextItems(items: MemoryContextItem[], answer: string): MemoryContextItem[] {
  const cited = new Set(citedIndices(answer))
  const listed = new Set<number>()
  for (const i of items) if (i.index !== undefined) listed.add(i.index)
  const settled = [...cited].every((n) => listed.has(n))
  return items.map((i) => {
    if (i.index === undefined) return i
    if (cited.has(i.index)) return { ...i, cited: true }
    return settled ? { ...i, cited: false } : { ...i, unsettled: true }
  })
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
 * v1.17.2: the floor was not cleared and the answer cited one of the passages
 * anyway.
 *
 * Measured (judge-r7/TH3/run-1): the header read "the answer is not backed by
 * it" and the strip directly beneath it left `[5]` as the one entry not marked
 * "not cited" — because the reply had quoted its "3 to 4 days" verbatim. Two
 * sentences of the same message, disagreeing about the same fact. The half the
 * app measured is the retrieval floor; the half it got wrong is the claim about
 * the answer, so that half is replaced with what the answer actually did. It
 * reads as a sharper warning than the original, which is correct: a reply
 * leaning on a passage the app has just measured as off-topic is worse news
 * than a reply leaning on nothing.
 */
export const libraryMissCitedLabel = (markers: string[]): string =>
  `📖 Nothing in the library covers this question — the answer cites ${markers.join(' ')} from it anyway.`

/**
 * v1.17.2: the floor judged the app's own lookup, and the turn went on to
 * retrieve more.
 *
 * The finding is real and stays on screen, but it never examined the passages
 * the later lookups returned, so it may not caption them. Naming its scope is
 * the whole repair.
 */
export const libraryMissScopedLabel = (checked: number, later: number): string =>
  `📖 Nothing in the ${checked} passage${checked === 1 ? '' : 's'} the app looked up covers this question; ` +
  `the model then retrieved ${later} more.`

/**
 * The collapsed header when one turn ran several lookups.
 *
 * Measured (judge-r7/V1/run-2): three lookups, seventeen passages. Listing
 * seventeen citation lines in the collapsed header is not a strip, it is a
 * paragraph — and the reader's actual question at that moment is "which one is
 * [14]". So the header answers that instead, and the entries move into the
 * panel under a heading per lookup.
 */
export const libraryStripSummary = (passages: number, lookups: number, cited: string[]): string =>
  `${passages} passages from ${lookups} lookups — ` +
  (cited.length > 0 ? `the answer cites ${cited.join(' ')}.` : 'the answer cites none of them.')

/**
 * v1.17.2: why the strip has stopped saying "not cited".
 *
 * Shown whenever a marker in the answer names no listed passage, which is
 * exactly when the app's account of what the answer used is incomplete.
 */
export const unresolvedMarkerNote = (markers: string[]): string =>
  `⚠️ ${markers.join(' ')} name${markers.length === 1 ? 's' : ''} no passage listed here, ` +
  'so the rest are left unjudged.'

/** One lookup's block in the expanded panel. */
export interface LibraryStripGroup {
  heading: string
  items: MemoryContextItem[]
}

/** Everything the provenance strip renders, computed in one place so it cannot self-contradict. */
export interface LibraryStrip {
  label: string
  /** Replaces the citation list in the collapsed header, when listing would overclaim or overflow. */
  detail?: string
  /** The withheld-negative warning, when there is one. */
  note?: string
  title: string
  items: MemoryContextItem[]
  /** Present only when the turn ran more than one lookup; otherwise the flat list reads better. */
  groups?: LibraryStripGroup[]
}

/** A retrieved passage as the strip lists it — the same parse the inline marker resolves through. */
function toStripItem(c: Citation): MemoryContextItem {
  return {
    source: c.label,
    score: c.score ?? 0,
    text: c.text ?? '',
    index: c.index,
    ...(c.href ? { url: c.href } : {})
  }
}

/** A lookup's query, short enough to sit in a heading. */
function shortQuery(query: string): string {
  const one = query.replace(/\s+/g, ' ').trim()
  return one.length > 72 ? `${one.slice(0, 71)}…` : one
}

/**
 * v1.17.2: the provenance strip, built from the turn's own lookup records.
 *
 * It used to be built from `libraryContext`, which the app-initiated pre-flight
 * provider patches and nothing else does — so a turn whose model ran two more
 * lookups showed the first five passages and hid the other twelve. Measured
 * (judge-r7/V1/run-2): the strip listed `[1]`–`[5]`, every one marked "not
 * cited", while the answer cited `[8] [9] [14]`, none of which appeared
 * anywhere in it. The markers a reader most needs to check were the only ones
 * the strip refused to show.
 *
 * Reading the records instead makes the strip and the inline marker binder the
 * same parse of the same text, so the two can no longer disagree about which
 * passages exist. `libraryContext` stays as the record of what the app itself
 * retrieved, which is what the relevance-floor finding is a claim about.
 */
export function libraryStrip(input: {
  records: ToolCallRecord[]
  answer: string
  /** The relevance-floor finding, measured over the app's own pre-flight passages. */
  miss: boolean
  /** How many passages that pre-flight lookup returned; 0 when the app never ran one. */
  preflight: number
}): LibraryStrip | null {
  const lookups = turnLookups(input.records)
  if (lookups.length === 0) return null
  const items = markCitedContextItems(
    lookups.flatMap((l) => l.passages.map(toStripItem)),
    input.answer
  )
  const cited = items.filter((i) => i.cited).map((i) => `[${i.index}]`)
  const unresolved = danglingCitations(input.answer, retrievedCitations(input.records))
  const many = lookups.length > 1

  const label = !input.miss
    ? LIBRARY_STRIP_LABEL
    : many
      ? libraryMissScopedLabel(input.preflight, items.length - input.preflight)
      : cited.length > 0
        ? libraryMissCitedLabel(cited)
        : LIBRARY_MISS_LABEL
  const detail = many
    ? libraryStripSummary(items.length, lookups.length, cited)
    : input.miss
      ? libraryMissDetail(items.length)
      : undefined

  return {
    label,
    ...(detail ? { detail } : {}),
    ...(unresolved.length > 0 ? { note: unresolvedMarkerNote(unresolved) } : {}),
    title: input.miss
      ? 'The app searched your local reference library before the model answered. None of the passages it returned is ' +
        'about this question — the retrieval score is relative to the result set, so a weak best match still scores ' +
        'high. They are shown because the model saw them, not because they support the answer.'
      : 'Every passage this turn retrieved from your local reference library — the model saw exactly these, with their ' +
        'citations, and cites them by the number shown. One marked "not cited" was seen but never cited by the answer, ' +
        'so it is not a source for it.',
    items,
    ...(many
      ? {
          groups: lookups.map((l, i) => {
            const first = l.passages[0].index
            const last = l.passages[l.passages.length - 1].index
            const range = first === last ? `[${first}]` : `[${first}]–[${last}]`
            const who =
              i === 0 && input.preflight > 0
                ? 'The app looked this up before the model answered'
                : 'The model looked this up'
            return {
              heading: `${who} · ${range}${l.query ? ` · “${shortQuery(l.query)}”` : ''}`,
              items: items.filter((it) => l.passages.some((p) => p.index === it.index))
            }
          })
        }
      : {})
  }
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
