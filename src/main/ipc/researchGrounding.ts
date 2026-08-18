/**
 * Deep research under the grounding ladder (v1.9).
 *
 * deep_research writes its brief with a model, in the main process, from the
 * passages it read. That brief then becomes *tool output* — and the rest of
 * the ladder trusts tool output as its corpus. So a figure the synthesizer
 * invented passes tool grounding, passes the recompute check, passes the
 * claim check, and reaches the user wearing a citation. Nothing checked the
 * brief against the evidence it was synthesized from, and the evidence was
 * right there. This module is that check, applied inside the tool before the
 * brief leaves it — the same rung the Workbench and the library already have.
 *
 * Mechanical, like every other rung. Three questions, each answered by
 * string matching against the passages the run actually read:
 *
 *   1. Numbers. Every figure the brief states — money, percentages, counts,
 *      decimals; not years, not list markers, not the [n] citations — must
 *      appear in some passage. A rounded restatement of a passage figure
 *      passes; a figure that appears nowhere is unsupported.
 *   2. Measurements. A number with a unit ("20 minutes", "165°F", "500 mg")
 *      is the dangerous class — an invented duration or dose is worse than
 *      no answer — and gets the same test, reported separately so the badge
 *      can name it.
 *   3. Citations. Every [n] the brief uses must be a source index the run
 *      actually read. A citation to a source that does not exist is a
 *      fabricated reference, which is exactly what a research tool must never
 *      emit.
 *
 * What is NOT checked: prose claims without figures. The ladder does not
 * pretend to verify "X is generally considered Y" — it verifies the specifics
 * a reader would act on, because those are what a small model invents with
 * the most confidence and what a citation makes look most trustworthy.
 *
 * Findings go two places: back to the synthesizer for one revision (with the
 * unsupported items named, so it can drop or re-source them), and into the
 * tool result as a disclosure the outer model must carry — so a brief that
 * still states an unsupported figure after revision reaches the user
 * flagged, never laundered.
 */

export interface ResearchGroundingReport {
  /** Figures in the brief that appear in no passage. */
  figures: string[]
  /** Measurements (number + unit) in the brief that appear in no passage. */
  measurements: string[]
  /** [n] citations that name no source the run read. */
  badCitations: number[]
  /** Source indices the run read — what a citation is allowed to be. */
  sourceIndices: number[]
  /** Passages checked against, for the disclosure. */
  passageCount: number
}

/** A number worth checking: money, decimals, thousands-grouped, percents, 4+ digit counts. Not years, not [n]. */
const FIGURE =
  /(?<![\w.\[])(?:\$|€|£)?\d{1,3}(?:,\d{3})+(?:\.\d+)?%?|(?<![\w.\[])(?:\$|€|£)\d+(?:\.\d+)?|(?<![\w.\[])\d+\.\d+%?|(?<![\w.\[])\d+%|(?<![\w.\[])\d{4,}(?![\w.\]])/g
const YEAR = /^(?:1[89]|20)\d{2}$/

const MEASUREMENT =
  /(?<![\w.])(\d[\d,]*(?:\.\d+)?)\s*(°\s?[cf]\b|degrees?\b|minutes?\b|mins?\b|hours?\b|hrs?\b|days?\b|weeks?\b|months?\b|years?\b|seconds?\b|secs?\b|mg\b|mcg\b|µg\b|ml\b|grams?\b|g\b|kg\b|litres?\b|liters?\b|l\b|gallons?\b|ounces?\b|oz\b|pounds?\b|lbs?\b|cm\b|mm\b|metres?\b|meters?\b|m\b|inches?\b|feet\b|ft\b|miles?\b|km\b|mph\b|km\/h\b|kwh\b|watts?\b|volts?\b|amps?\b|calories\b|kcal\b)/gi

const CITATION = /\[(\d{1,3})\]/g

function numericValue(raw: string): number | null {
  const n = Number(raw.replace(/[$€£,%\s]/g, ''))
  return Number.isFinite(n) ? n : null
}

/** Every distinct number in a body of text, as values. */
function numbersIn(text: string): Set<number> {
  const out = new Set<number>()
  for (const m of text.matchAll(/(?<![\w.])[-+]?\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''))
    if (Number.isFinite(n)) out.add(n)
  }
  return out
}

/**
 * Does the corpus support this value? Exact, or a rounding of a corpus figure
 * to the precision the brief used ("about 30 minutes" for 29.5; "$1.2 million"
 * is not matched against 1,234,567 — the brief must state figures the way the
 * source did, which is what a synthesizer told to cite should do anyway).
 */
function supported(value: number, corpus: Set<number>, raw: string): boolean {
  if (corpus.has(value)) return true
  const decimals = (raw.split('.')[1] ?? '').replace(/[^\d]/g, '').length
  const scale = Math.pow(10, decimals)
  for (const c of corpus) {
    if (Math.round(c * scale) / scale === value) return true
    // A percentage stated as 28.1 against a corpus 28.07: same rounding rule.
    if (Math.abs(c - value) < 0.5 / Math.max(1, scale) && decimals === 0) return true
  }
  return false
}

export function checkResearchGrounding(
  brief: string,
  sources: { index: number; passages: { text: string }[] }[]
): ResearchGroundingReport {
  const corpusText = sources.flatMap((s) => s.passages.map((p) => p.text)).join('\n')
  const corpus = numbersIn(corpusText)
  const sourceIndices = sources.map((s) => s.index)
  const indexSet = new Set(sourceIndices)

  // Strip citations before scanning for figures so "[12]" is never a figure.
  const body = brief.replace(CITATION, ' ')

  const figures: string[] = []
  const seenFig = new Set<string>()
  for (const m of body.match(FIGURE) ?? []) {
    const bare = m.replace(/[$€£,%]/g, '')
    if (YEAR.test(bare)) continue
    const v = numericValue(m)
    if (v === null) continue
    if (supported(v, corpus, m)) continue
    if (seenFig.has(m)) continue
    seenFig.add(m)
    figures.push(m)
  }

  const measurements: string[] = []
  const seenMeas = new Set<string>()
  for (const m of body.matchAll(MEASUREMENT)) {
    const v = numericValue(m[1])
    if (v === null) continue
    if (supported(v, corpus, m[1])) continue
    const raw = m[0].trim()
    if (seenMeas.has(raw)) continue
    seenMeas.add(raw)
    measurements.push(raw)
  }

  const badCitations: number[] = []
  for (const m of brief.matchAll(CITATION)) {
    const n = Number(m[1])
    if (!indexSet.has(n) && !badCitations.includes(n)) badCitations.push(n)
  }

  return { figures, measurements, badCitations, sourceIndices, passageCount: sources.reduce((n, s) => n + s.passages.length, 0) }
}

export function researchGroundingIsClean(r: ResearchGroundingReport): boolean {
  return r.figures.length === 0 && r.measurements.length === 0 && r.badCitations.length === 0
}

/**
 * The revision instruction handed back to the synthesizer, naming what to
 * fix. One pass, like every other rung: the point is to remove what was
 * invented, not to argue with a regex until it is satisfied.
 */
export const RESEARCH_REVISION_HEADER =
  'Your brief states specifics that the sources you were given do not contain. Fix it and reply with the corrected brief only:'

export function buildResearchRevision(r: ResearchGroundingReport): string {
  const lines: string[] = [RESEARCH_REVISION_HEADER]
  if (r.badCitations.length) {
    lines.push(`- Citations to sources that do not exist: ${r.badCitations.map((n) => `[${n}]`).join(', ')}. Only [${r.sourceIndices.join('], [')}] exist. Remove or correct them.`)
  }
  if (r.measurements.length) {
    lines.push(`- Measurements not in any source: ${r.measurements.join('; ')}. Remove each, or replace it with the figure a source actually gives and cite it.`)
  }
  if (r.figures.length) {
    lines.push(`- Figures not in any source: ${r.figures.join(', ')}. Same rule.`)
  }
  lines.push('Do not add new claims. Do not mention this instruction. Where a source does not support a specific, say the sources do not give it.')
  return lines.join('\n')
}

/**
 * The disclosure that rides the tool result. Written for the outer model AND
 * the badge: what was checked, and what — after revision — still stands
 * unsupported, so it reaches the user flagged.
 */
export function describeResearchGrounding(input: {
  before: ResearchGroundingReport
  after: ResearchGroundingReport | null
  revised: boolean
}): string {
  const { before, after, revised } = input
  const final = after ?? before
  const checked = `Checked the brief's figures, measurements and citations against the ${before.passageCount} passage(s) it was written from.`
  if (researchGroundingIsClean(before)) return `${checked} All supported.`
  const parts: string[] = []
  if (revised && after && researchGroundingIsClean(after)) {
    return `${checked} The first draft stated specifics its sources did not contain (${summarize(before)}); it was revised and the revision is fully supported.`
  }
  parts.push(checked)
  parts.push(
    revised
      ? `The first draft stated unsupported specifics; after one revision these still stand: ${summarize(final)}.`
      : `Unsupported specifics: ${summarize(final)}.`
  )
  parts.push('Present those as unverified — say the sources do not give them — rather than as findings.')
  return parts.join(' ')
}

function summarize(r: ResearchGroundingReport): string {
  const bits: string[] = []
  if (r.badCitations.length) bits.push(`citations ${r.badCitations.map((n) => `[${n}]`).join(', ')} name no source`)
  if (r.measurements.length) bits.push(`measurements ${r.measurements.slice(0, 5).join('; ')}${r.measurements.length > 5 ? '…' : ''}`)
  if (r.figures.length) bits.push(`figures ${r.figures.slice(0, 6).join(', ')}${r.figures.length > 6 ? '…' : ''}`)
  return bits.join('; ')
}
