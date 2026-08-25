import type { ToolCallRecord } from '../types'

/**
 * v1.13: making a citation the app produced followable.
 *
 * The library hands the model numbered passages — `[1] pack › doc · 31% in`,
 * each with the document's own `source:` line under it — and the turn block
 * tells it to "cite them by their bracketed number". It does: a measured tax
 * question came back with "[1]" and "[2]" in the body. Both resolved to
 * nothing. The strip under the reply listed the passages without their
 * numbers, so a marker had nothing to name; the IRS URL the lookup had
 * already retrieved was rendered nowhere at all; and nothing checked that a
 * marker named a passage that existed. A URL the model merely typed into
 * prose became a working link, while the one the app verified stayed dead.
 *
 * This module parses the locators back out of the app's own tool output. The
 * renderer uses them to turn an inline `[n]` into the passage it names, and
 * the grounding pass reports an `[n]` that names no retrieved passage — the
 * same class of finding as an invented figure or link, caught the same
 * mechanical way, with no model in the loop.
 */

export interface Citation {
  /** The bracketed number the model was given for this passage. */
  index: number
  /** The citation line: pack › document › section · N% in. */
  label: string
  /** The document's locator — a URL for a published pack, a path for a folder pack. */
  source?: string
  /** The source when it is a web URL: the only kind this app ever makes clickable. */
  href?: string
  /**
   * v1.17.2: the `relevance` the lookup printed above the passage, and the
   * passage's own words. Present so the provenance strip can be built from the
   * turn's records — the same parse the inline marker resolves through, so the
   * two cannot disagree about what was retrieved. Absent only when the block
   * was cut mid-way by the tool handler's output cap.
   */
  score?: number
  text?: string
}

/** The `[n] citation` line that opens each passage block of a lookup result. */
const PASSAGE_HEADER = /^\[(\d{1,3})\][ \t]+(\S.*)$/gm
/** The `source:` line the formatter indents directly under that header. */
const PASSAGE_SOURCE = /^\n[ \t]+source:[ \t]*(\S+)/
/** The last of the indented metadata lines: the passage's own text starts after it. */
const PASSAGE_RELEVANCE = /^[ \t]+relevance[ \t]+(\d+(?:\.\d+)?)[ \t]*$/m
/** `formatLookup` appends the lookup's notes after the final passage; they are not part of it. */
const TRAILING_NOTES = /\n\n(?:Note: [^\n]*(?:\n|$))+$/

/**
 * A run of bracketed markers in prose: `[1]`, or `[2][5]` written together.
 *
 * v1.17.2: matched as a run rather than one at a time. The old single-marker
 * pattern refused any `[n]` sitting directly after a `]` — the guard that keeps
 * `m[0][1]` as array indexing — which silently swallowed the second half of
 * every `[2][5]`. Measured (judge-r7/V2/run-1): the reply cited `[2][5]`, the
 * strip marked `[5]` "— not cited", and the marker rendered as dead black text.
 * Anchoring the guard to the START of the run keeps `m[0][1]` out (its run
 * begins after a word character) and lets an adjacent pair in.
 *
 * Not before `(`, which would be a markdown link.
 */
export const CITATION_RUN = /(?<![\w\])])\[\d{1,3}\](?:\[\d{1,3}\])*(?!\()/g
/** One marker inside a run matched by `CITATION_RUN`. */
export const CITATION_IN_RUN = /\[(\d{1,3})\]/g

const FENCED_CODE = /```[\s\S]*?(?:```|$)/g
const INLINE_CODE = /`[^`\n]*`/g

/** Only http(s) sources are linkable — a folder pack's source is a local path. */
export function webSource(source: string | undefined): string | undefined {
  if (!source) return undefined
  try {
    const { protocol } = new URL(source)
    return protocol === 'http:' || protocol === 'https:' ? source : undefined
  } catch {
    return undefined
  }
}

/** The passages one `reference_lookup` result handed over, in the order it numbered them. */
export function parseCitations(output: string): Citation[] {
  const heads = [...output.matchAll(PASSAGE_HEADER)]
  return heads.map((m, i) => {
    // A block runs from its header to the newline that `formatLookup` joined
    // the next header on with — so the passage text keeps its own shape and
    // borrows nothing from its neighbour.
    const next = heads[i + 1]
    const body = output.slice(m.index + m[0].length, next ? next.index - 1 : output.length)
    const source = PASSAGE_SOURCE.exec(body)?.[1]
    const href = webSource(source)
    const relevance = PASSAGE_RELEVANCE.exec(body)
    const score = relevance ? Number(relevance[1]) : NaN
    const text = relevance
      ? body.slice(relevance.index + relevance[0].length).replace(/^\n/, '').replace(TRAILING_NOTES, '')
      : ''
    return {
      index: Number(m[1]),
      label: m[2].trim(),
      ...(source ? { source } : {}),
      ...(href ? { href } : {}),
      ...(Number.isFinite(score) ? { score } : {}),
      ...(text ? { text } : {})
    }
  })
}

/**
 * The highest passage number this turn's finished lookups have already handed
 * the model. `renumberPassages` continues from here.
 */
export function passagesHandedOver(records: ToolCallRecord[]): number {
  let high = 0
  for (const r of records) {
    if (r.name !== 'reference_lookup' || r.status !== 'done') continue
    for (const c of parseCitations(r.result ?? '')) if (c.index > high) high = c.index
  }
  return high
}

/**
 * v1.13.1: continue a lookup's numbering from where the turn left off.
 *
 * `formatLookup` numbers each result from [1] — correct for one lookup, a trap
 * for two. Measured (judge-r4/TH3/run-1): a turn ran `reference_lookup` twice,
 * so the model was handed two different `[1]`s — an FDA power-outage checklist
 * and the USDA line "Leftovers can be kept in the refrigerator for 3 to 4
 * days". It quoted the USDA line and cited "[1]"; every resolver in the app
 * read the first block's, so a correctly-sourced quote pointed the reader at a
 * passage about losing power. Nothing was dangling and nothing was invented —
 * the marker simply named two passages, and the reader could only follow one.
 *
 * Numbering per turn rather than per lookup is the fix, and it beats the
 * alternatives: scoping markers per lookup (`[2.1]`) changes the notation the
 * model is asked to emit and a 9B model would keep writing `[1]`, and
 * re-resolving after the fact cannot work — the reply is already written, and
 * a duplicated number carries no evidence of which block it meant. Renumbering
 * before the text reaches the model means the collision is never created.
 *
 * Done in the renderer because "the turn" only exists here: the lookup handler
 * is stateless by design and answers one call at a time.
 */
export function renumberPassages(output: string, handedOver: number): string {
  if (handedOver <= 0) return output
  // `.test()` is avoided deliberately: PASSAGE_HEADER is global, and a probe
  // would leave lastIndex behind for the next parse. `.replace()` resets it.
  let numbered = false
  const shifted = output.replace(PASSAGE_HEADER, (_m, n: string, rest: string) => {
    numbered = true
    return `[${Number(n) + handedOver}] ${rest}`
  })
  // A lookup that found nothing has no numbering to continue.
  if (!numbered) return output
  const lines = shifted.split('\n')
  // Said out loud, so a model that reads "[6]" does not helpfully renumber it
  // back to [1] on its way into the answer.
  lines[0] +=
    ` This turn already handed you ${handedOver} numbered passage${handedOver === 1 ? '' : 's'}, so these ` +
    `continue from [${handedOver + 1}] — the earlier ones keep their own numbers.`
  return lines.join('\n')
}

/**
 * Every passage this turn's library lookups produced.
 *
 * A number is claimed once: `renumberPassages` keeps a turn's lookups from
 * colliding, so on a fresh turn every index here is unique. A conversation
 * recorded before that landed can still hold two `[1]`s — the first to claim
 * it keeps it, which is also how the model read them.
 */
export function retrievedCitations(records: ToolCallRecord[]): Citation[] {
  const byIndex = new Map<number, Citation>()
  for (const r of records) {
    if (r.name !== 'reference_lookup' || r.status !== 'done') continue
    for (const c of parseCitations(r.result ?? '')) {
      if (!byIndex.has(c.index)) byIndex.set(c.index, c)
    }
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index)
}

/** The bracketed numbers a reply cites, code blocks excluded. */
export function citedIndices(answer: string): number[] {
  const prose = answer.replace(FENCED_CODE, ' ').replace(INLINE_CODE, ' ')
  const seen = new Set<number>()
  // Every marker of every run: `[2][5]` is two citations, not one.
  for (const run of prose.matchAll(CITATION_RUN)) {
    for (const m of run[0].matchAll(CITATION_IN_RUN)) seen.add(Number(m[1]))
  }
  return [...seen].sort((a, b) => a - b)
}

/** One `reference_lookup` this turn ran, and the passages it numbered. */
export interface Lookup {
  /** The query string the call carried, when it had one. */
  query: string
  passages: Citation[]
}

/**
 * The turn's library lookups, in the order they ran, each with its own
 * passages.
 *
 * v1.17.2: the strip groups by this. `retrievedCitations` flattens the turn
 * into one numbered list — right for resolving a marker, wrong for reading:
 * measured (judge-r7/V1/run-2) a single turn ran three lookups and handed over
 * seventeen passages, and seventeen citation lines in one undivided list is a
 * wall. The lookup that produced a passage is also the only thing that says
 * *why* it is there, so it is the natural heading.
 */
export function turnLookups(records: ToolCallRecord[]): Lookup[] {
  const out: Lookup[] = []
  const claimed = new Set<number>()
  for (const r of records) {
    if (r.name !== 'reference_lookup' || r.status !== 'done') continue
    // Same first-claim rule as `retrievedCitations`, so a conversation recorded
    // before per-turn numbering cannot list one number under two headings.
    const passages = parseCitations(r.result ?? '').filter((c) => {
      if (claimed.has(c.index)) return false
      claimed.add(c.index)
      return true
    })
    if (passages.length > 0) out.push({ query: String(r.args?.query ?? ''), passages })
  }
  return out
}

/**
 * Markers the reply used that name no retrieved passage.
 *
 * Gated on something actually having been retrieved: with no lookup behind it
 * a `[1]` is the model's own footnote and none of this check's business. When
 * passages *were* handed over and the reply cites a number that is not among
 * them, the citation points at nothing — an invented source, told in the one
 * notation the reader is most likely to trust.
 */
export function danglingCitations(answer: string, retrieved: Citation[]): string[] {
  if (retrieved.length === 0) return []
  const known = new Set(retrieved.map((c) => c.index))
  return citedIndices(answer)
    .filter((i) => !known.has(i))
    .map((i) => `[${i}]`)
}
