import type { ToolCallRecord } from '../types'
import {
  convertUnit,
  isRatioScale,
  measurementGroup,
  measurementsIn,
  type Measurement
} from '../../../shared/measurements'
import { TOOL_DEFS } from '../../../shared/tools'
import { LAUNDERED_OUTPUT_MARKER } from './workbenchChecks'
import { danglingCitations, retrievedCitations, type Citation } from './citations'

/**
 * v1.3 tool grounding: did the answer actually use what the tools returned?
 *
 * The v1.1 `unverified` flag catches the easy case — a factual turn where no
 * source was consulted at all. This catches the harder and more damaging one:
 * a tool ran, returned a number or a link, and the reply contains a *different*
 * number or link instead.
 *
 * That is not hypothetical. Measured in a v1.3 session: the user asked for a
 * car payment with $5,000 down, `finance_calculator` was called (with the wrong
 * principal — the sticker price rather than the amount financed) and returned
 * $396.02/mo, and the reply told the user **$293.50/mo**. Every figure in that
 * answer — payment, interest, totals — was written by the model, and all of
 * them were wrong. The same session produced a product URL that appeared in no
 * search result.
 *
 * The check is deliberately mechanical: string and number extraction, no model
 * call, no network. It cannot judge whether a figure is *right* — only whether
 * anything the app actually retrieved or computed supports it. A figure the
 * model derived itself is reported as exactly that, and the user decides.
 */

/** Tools whose output is the authoritative source for numbers in a reply. */
// market_data joined in v1.12: its output IS app-computed figures (last close,
// range high/low, drawdown), and on its first live run the checker flagged the
// tool's own numbers as "not backed by the tool output" because this set did
// not know the tool existed.
const NUMERIC_TOOLS = new Set(['finance_calculator', 'shop_compare', 'price_watch', 'run_python', 'analyze_file', 'market_data'])

/**
 * Tools that return retrieved *text* the reply is meant to quote from.
 *
 * v1.12.2, and it arms exactly one check: measurements. A passage is not a
 * computation, so it must not license the money or percentage rungs — but it
 * is every bit as authoritative about the dose it states as `run_python` is
 * about its own total. "Give 500 mg" over a retrieved passage reading "200 mg
 * to 400 mg" is the same failure as a headline contradicting the app's
 * arithmetic, and until now it produced no finding at all.
 */
const RETRIEVAL_TOOLS = new Set(['reference_lookup'])

/** Tools whose output is the authoritative source for links in a reply. */
const SOURCE_TOOLS = new Set([
  'web_search',
  'image_search',
  'fetch_webpage',
  'deep_research',
  'shop_compare',
  'shop_requirements',
  'price_watch',
  // v1.5: library passages carry their document's source URL/path.
  'reference_lookup'
])

/** Beyond this many findings the badge stops enumerating and just counts. */
const MAX_REPORTED = 6

export interface GroundingReport {
  /** Money figures in the reply that no tool output or user message contains. */
  figures: string[]
  /**
   * v1.9.2: quantities with units — miles, minutes, milligrams — that nothing
   * computed or retrieved supports. Money and percentages were checked from
   * v1.4.5 and v1.6; everything measured in any other unit was not.
   */
  quantities?: string[]
  /** Links in the reply that appear in no tool output. */
  links: string[]
  /** Countries the reply names that contradict the geography the sources gave. */
  origins?: string[]
  /** Street addresses in the reply that appear in no tool output. */
  addresses?: string[]
  /** Phone numbers and email addresses that appear in no tool output. */
  contacts?: string[]
  /** v1.12.1: tools the reply says it used that never ran this turn. */
  toolClaims?: string[]
  /** v1.14: tools that DID run and the reply's own "Tools used" section omits. */
  toolDisclosure?: string[]
  /**
   * v2.2: a tool the reply's account credits with more calls than ran. The
   * name is right, the account names it, the arguments may even be the ones
   * that went — and the number of times it happened is inflated. See
   * `overstatedToolCounts`.
   */
  toolCounts?: string[]
  /**
   * v1.17: an argument the reply quotes as the one it passed, where the call
   * carried something else. The name was right and the query was invented —
   * see `misstatedToolArguments`.
   */
  toolArgs?: string[]
  /** v1.6: the reply's Python failed when run in the sandbox (finding lines). */
  code?: string[]
  /**
   * v1.13: bracketed markers — "[3]" — naming a passage the library lookup
   * never returned. A citation index is a claim of the same kind as a figure
   * or a link, and until now it was the one kind nothing checked.
   */
  citations?: string[]
  /** v1.14: spans quoted as verbatim that no captured tool output contains. */
  quotes?: string[]
  /** v1.14: `[n] (Document)` where the named document is not passage n's. */
  attributions?: string[]
  /**
   * v2.1: what the measurement rung did **not** look at.
   *
   * Every field above this line is a fault found. This one is the opposite kind
   * of fact and it is here because the badge was implying it by omission.
   * Measured, blind, round 8, task V3 — the user asks how much water a dripping
   * faucet wastes, and the two arms answer `105 gallons (400 liters)` and
   * `35 gallons (130 liters)`, a factor of three apart and invented by both:
   *
   *     ⚠️ 4 figures ($10, $25, $40, $80) in this reply are not backed by the
   *        tool output.
   *     Checked against: no tool output — nothing ran this turn.
   *
   * Four incidental repair costs named, and the one number the user came for
   * not mentioned — because `unsourcedFigures` has an unprompted path (several
   * unsupported prices are worth saying so about on their own) and the
   * quantities rung has none: with nothing computed and nothing retrieved it
   * does not run, and the volumes were never candidates. Nothing on screen said
   * so. A reader looking at four named figures reads a completed scan.
   *
   * So the pass now reports its own coverage. This is deliberately **not** a
   * ranking of which figure matters — see the note on `describeCoverage` for
   * why that was tried on paper and rejected.
   */
  coverage?: QuantityCoverageReport
  /**
   * v2.2: the other half of the same disclosure — where the measurements it
   * DID check were found, and on how many lines. Not a fault, like `coverage`
   * and unlike everything above it. See `measurementSources` for the check
   * this is instead of.
   */
  matched?: MeasurementSource[]
  /** Tools whose output was used as the corpus, for the disclosure text. */
  checkedAgainst: string[]
}

/** How much of the reply's measured claims the quantities rung actually reached. */
export interface QuantityCoverageReport {
  /** Distinct measurements put beside something the turn produced. */
  checked: number
  /** Distinct measurements compared against nothing at all. */
  unchecked: number
  /** The first few of those, as the reader can find them on screen. */
  uncheckedNamed: string[]
}

/**
 * Below this many money figures, a reply is mentioning a number, not building a
 * pricing table out of thin air. The distinction is what lets the figure check
 * run on turns where no pricing tool fired without commenting on every passing
 * "about $20" in ordinary conversation.
 */
const MIN_UNPROMPTED_FIGURES = 2

// ---- correction ----------------------------------------------------------------

/**
 * The findings, written for the model that produced them.
 *
 * v1.4.6. Everything above this line detects; nothing acted on what it found.
 * Across ten measured sessions the checks correctly identified invented
 * addresses, prices, phone numbers and a relocated brand — and then rendered a
 * badge underneath an answer the user had already read. The detection was
 * right and the answer was still wrong.
 *
 * So the findings go back to the model for one revision. Two things make that
 * safe rather than destructive: it names the specific items rather than
 * asking for a general rewrite, and it offers verification as the first
 * option — the model still has its tools, and an address it can confirm is
 * better kept than deleted.
 */
/** How many separate unsupported things a report names. */
export function groundingFindingCount(report: GroundingReport | null): number {
  if (!report) return 0
  return (
    report.figures.length +
    report.links.length +
    (report.quantities?.length ?? 0) +
    (report.origins?.length ?? 0) +
    (report.contacts?.length ?? 0) +
    (report.addresses?.length ?? 0) +
    (report.toolClaims?.length ?? 0) +
    (report.toolDisclosure?.length ?? 0) +
    (report.toolCounts?.length ?? 0) +
    (report.toolArgs?.length ?? 0) +
    (report.code?.length ?? 0) +
    (report.citations?.length ?? 0) +
    (report.quotes?.length ?? 0) +
    (report.attributions?.length ?? 0)
  )
}

/**
 * Is a revision an improvement, or just a different set of inventions?
 *
 * v1.4.6, and this guard is why the correction pass is safe to run at all.
 * Asked to fix an itinerary with two invented addresses, the model — measured,
 * against the live model — returned the same table with *different* invented
 * addresses ("155 W 52nd St" became "150 W 52nd St") plus a line claiming the
 * rest had been "verified against search results" when nothing had run. The
 * prompt forbids exactly that and the model did it anyway, which is the usual
 * lesson: an instruction is a preference, a check is a guarantee.
 *
 * So a revision is kept only when it strictly reduces what the checker can
 * fault. Anything else and the original stands, flagged — the answer the user
 * gets is never worse than the one the model first produced.
 */
export function revisionIsAnImprovement(
  before: GroundingReport,
  after: GroundingReport | null
): boolean {
  return groundingFindingCount(after) < groundingFindingCount(before)
}

/** Beyond this many, the revision line names the first few and counts the rest. */
const MAX_NAMED = 4
/** A single named item longer than this is elided — the line has to stay a line. */
const MAX_LABEL = 48

/**
 * Elide to `max`, but never across the break a quotation excerpt is marked at.
 *
 * v1.17, and the same lesson as the excerpt itself: a label whose only job is to
 * let the reader find the faulted thing on screen must not cut away the part
 * that identifies it. A head-clamp at 48 characters would land inside the
 * run-up to the marker on almost every quotation, so when the marker is there,
 * the window moves with it.
 */
function elideLabel(text: string, max: number): string {
  if (text.length <= max) return text
  const [open, close] = QUOTE_BREAK_MARKS
  const at = text.indexOf(open)
  if (at < 0) return `${text.slice(0, max - 1)}…`
  const shut = text.indexOf(close, at)
  const room = max - 2
  const width = (shut < 0 ? text.length : shut + close.length) - at
  const from = width >= room ? at : Math.max(0, at - Math.floor((room - width) / 2))
  const to = Math.min(text.length, from + room)
  const body = text.slice(from, to)
  return `${from > 0 && !body.startsWith('…') ? '…' : ''}${body}${to < text.length && !body.endsWith('…') ? '…' : ''}`
}

/**
 * Every faulted thing, as the short string a reader can look for on screen.
 *
 * The count and the names must come from the same place. `groundingFindingCount`
 * spans fourteen categories; a line that says "3 unsupported items" and then
 * names two is worse than one that names none, so this walks the same fourteen
 * and the invariant `labels.length === count` is pinned in the tests.
 *
 * A code finding is the one that cannot be quoted — it is a traceback plus an
 * instruction — so it is named by what it is. The 🧪 check line carries the
 * detail directly under this one.
 */
export function groundingFindingLabels(report: GroundingReport | null): string[] {
  if (!report) return []
  return [
    ...(report.code ?? []).map(() => "the answer's Python"),
    ...(report.toolClaims ?? []),
    ...(report.toolDisclosure ?? []),
    ...(report.toolCounts ?? []),
    ...(report.toolArgs ?? []),
    // Elided before it is wrapped, not after: a label ending in a lone `”` is
    // the sort of debris that makes a reader distrust the whole line.
    ...(report.quotes ?? []).map((q) => `“${elideLabel(q, MAX_LABEL - 2)}”`),
    ...(report.attributions ?? []),
    ...(report.addresses ?? []),
    ...(report.contacts ?? []),
    ...report.links,
    ...(report.citations ?? []),
    ...report.figures,
    ...(report.quantities ?? []),
    ...(report.origins ?? [])
  ].map((s) => elideLabel(s, MAX_LABEL))
}

export interface RevisionOutcome {
  /** How many findings went back to the model. */
  sent: number
  /** How many of them the re-check still faults in the answer now on screen. */
  remaining: number
  /** True only when the re-check faults none of them. */
  resolved: boolean
  /** The line, for the reader. Empty when nothing was sent back. */
  text: string
}

function nameList(labels: string[]): string {
  if (labels.length <= MAX_NAMED) return labels.join(', ')
  return `${labels.slice(0, MAX_NAMED).join(', ')} and ${labels.length - MAX_NAMED} more`
}

/**
 * What the revision pass actually accomplished, in the words it can stand behind.
 *
 * The v1.4.6 line said "N unsupported items were sent back for verification or
 * removal" and stopped there — which is a description of a *request*, not of a
 * result, and it was rendered in green underneath answers where the finding was
 * still standing. Measured, blind, round 4 task V1: the reply stated 165°F/74°C
 * over passages that contain neither string, and the only chrome on screen was
 * "✎ Revised: 1 unsupported item were sent back for verification or removal."
 * A judge chose the older build over it and named that line as the reason.
 *
 * Three things were wrong and all three are the same thing. It asserted a
 * resolution it had not checked; it named nothing, so nobody could check it
 * either; and it agreed a plural verb with "1 item". So the line is now a
 * function of both reports — what went back and what came back still faulted —
 * it names the items, and `resolved` is what the colour keys off. An unresolved
 * finding is not a resolution and must not be painted like one.
 *
 * Note what `resolved` does and does not claim: the re-check no longer faults
 * these items, which is a statement about the check, not about the world. It is
 * the strongest thing this code knows.
 */
export function describeRevisionOutcome(
  before: GroundingReport | null,
  after: GroundingReport | null
): RevisionOutcome {
  const sent = groundingFindingCount(before)
  const remaining = groundingFindingCount(after)
  if (sent === 0) return { sent: 0, remaining, resolved: false, text: '' }
  const head = `Revised: ${sent} unsupported item${sent === 1 ? ' was' : 's were'} sent back`
  if (remaining === 0) {
    return {
      sent,
      remaining,
      resolved: true,
      text: `${head} (${nameList(groundingFindingLabels(before))}); the re-check faults none of them.`
    }
  }
  return {
    sent,
    remaining,
    resolved: false,
    text:
      `${head}; ${remaining} ${remaining === 1 ? 'is' : 'are'} still unsupported in this ` +
      `answer: ${nameList(groundingFindingLabels(after))}.`
  }
}

/** `a`, `a and b`, `a, b and c` — never `a and b and c`. */
function andList(parts: string[]): string {
  if (parts.length < 2) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/**
 * The amber banner's first line: the categories that were faulted, the items in
 * each, and a verb that agrees with the items.
 *
 * v1.17.1, and it is round 6's own generalisation applied to the sentence that
 * carries the whole verifiability claim. `MessageBubble` wrote
 * `parts.length > 1 ? 'are' : 'is'`, and `parts` holds one entry per CATEGORY —
 * figures, links, measurements — not per item. So the app shipped, verbatim,
 * from recorded runs:
 *
 *     ⚠️ 2 measurements (165°F, 74°C) in this reply is not backed by the tool output.
 *     ⚠️ 3 figures ($0.01, $36, $10) in this reply is not backed by the tool output.
 *     ⚠️ 4 links in this reply is not backed by the tool output.
 *
 * Every plural-within-one-category case was ungrammatical, and the two-category
 * case read correctly only by accident — a compound subject is plural however
 * its halves count, so the wrong quantity happened to cross the threshold with
 * the right one. The verb now agrees with the total, which is what the subject
 * denotes.
 *
 * It lives here rather than in the component for the reason the count and the
 * names of `describeRevisionOutcome` do: a sentence with no test is how "1 item
 * were sent back" survived to a blind judge in round 4.
 */
export function describeUnbackedItems(report: GroundingReport): string {
  const parts: string[] = []
  let items = 0
  const add = (named: string[], noun: string, list: boolean): void => {
    if (named.length === 0) return
    items += named.length
    // Named in full where naming is possible: a figure is checked by looking at
    // it. Links carry their own bulleted list under this line, so counting them
    // here and listing them there says each URL once.
    parts.push(`${named.length} ${noun}${named.length === 1 ? '' : 's'}${list ? ` (${named.join(', ')})` : ''}`)
  }
  add(report.figures, 'figure', true)
  add(report.links, 'link', false)
  add(report.quantities ?? [], 'measurement', true)
  if (items === 0) return ''
  return `${andList(parts)} in this reply ${items === 1 ? 'is' : 'are'} not backed by the tool output.`
}

/** Beyond this many, the coverage line names the first few and counts the rest. */
const MAX_UNCHECKED_NAMED = 4

/**
 * The one line that says what this pass did *not* do.
 *
 * **Why this and not a ranking.** The obvious reading of the V3 failure is that
 * the checker needs to know which claim the reply is about, and the prompt is
 * right there. It was tried on paper and it does not survive contact with this
 * app's own corpus.
 *
 * `buildSearchQuery` offers nothing: it flattens whitespace, caps at 240
 * characters and optionally prepends the previous user message. It performs no
 * topical analysis, so there is no existing machinery to lean on. Building it
 * means a noun→dimension lexicon — "water" is a volume — and the shipped packs
 * break it immediately. *How much water should I store per person* is a volume;
 * *how much water weight will I lose* is a mass; *how much can my landlord
 * raise the rent* is money or a percentage; *how long do leftovers last* is a
 * duration; and *how much does it cost to fix a dripping faucet* is money —
 * which on this very reply makes `$10`–`$80` the headline and `105 gallons` the
 * incidental. Two questions a hair apart, opposite answers, and the app cannot
 * tell them apart without understanding the sentence.
 *
 * The cost of guessing wrong is not a miss, it is a new way to mislead. A line
 * reading "the figure that answers your question is unsupported" pointing at
 * `$25` asserts that the app understood the question, in the one place a reader
 * has no way to check. Round 4's stricter quote checker was judged *worse* than
 * the gap it closed for exactly this reason, and that finding was at least
 * falsifiable by eye. This one would not be.
 *
 * So the honest smaller thing: report the coverage, name nothing as important,
 * and let the reader see that the number they came for was never looked at.
 *
 * **Its failure mode, stated.** This line can only ever *understate* what the
 * pass knows. If a named measurement turns out to be perfectly correct, "it was
 * compared against nothing" is still true — it is a fact about the check, not a
 * verdict on the answer. It elevates no figure because it names every one the
 * rung skipped, in the order the reply states them. Its real cost is length on
 * a reply full of incidental durations, which is why it is capped, and why it
 * rides an existing badge rather than appearing on its own: a reply the pass
 * faults nowhere makes no coverage claim to correct, and a permanent grey line
 * under every mention of "20 minutes" is round 4's cry-wolf in a quieter ink.
 *
 * **And the noise it would have made.** The first version of this line said
 * "compared against nothing" the moment a dimension was unarmed, which is true
 * and was still wrong to print. Measured while building it: a passage reading
 * "wastes about 2,000 gallons **per year**" against a reply reading "wastes
 * about 2,000 gallons **a year**" produced *Covered 0 of the 1 measurement …
 * Not compared against anything: 2,000 gallons* — because the rate suffix makes
 * `gallon per year` a different unit from `gallon`, deliberately (a pace is not
 * a duration). Every word of that was accurate and a reader looking at the
 * passage would have called the app broken, which is how a disclosure becomes
 * noise. The line is therefore gated on `coverageWorthSaying`: at least one
 * skipped measurement whose number the reader cannot find in what the tools
 * returned. See there for why the gate is on the line and not on the items.
 */
export function describeCoverage(report: GroundingReport): string {
  const gap = report.coverage
  if (!gap || gap.unchecked === 0) return ''
  const total = gap.checked + gap.unchecked
  const shown = gap.uncheckedNamed.slice(0, MAX_UNCHECKED_NAMED)
  const rest = gap.unchecked - shown.length
  const named = rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ')
  return (
    `Covered ${gap.checked} of the ${total} measurement${total === 1 ? '' : 's'} in this reply. ` +
    `Not compared against anything: ${named}.`
  )
}

/**
 * The companion to `describeCoverage`, and the same rank of statement: about
 * the check, not about the answer.
 *
 * `describeCoverage` reports what the pass never reached. This reports where
 * what it *did* reach was found — and, when a value sits on more than one line
 * of a passage, says so, because that is precisely the situation in which
 * "the passage states this number" is at its weakest as evidence. See
 * `measurementSources` for why this is the line and not a verdict on the row.
 */
export function describeMatchedMeasurements(report: GroundingReport): string {
  const found = report.matched ?? []
  if (found.length === 0) return ''
  const parts = found.slice(0, MAX_REPORTED).map((s) => {
    const shown = s.passages.slice(0, MAX_SOURCE_PASSAGES)
    const rest = s.passages.length - shown.length
    const where = rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ')
    return `${s.raw} — ${where}, ${s.lines} line${s.lines === 1 ? '' : 's'}`
  })
  const ambiguous = found.some((s) => s.lines > 1)
  return (
    `Matched by value, not by row: ${parts.join('; ')}.` +
    (ambiguous
      ? ' Where a value is stated on more than one line, only the passage itself shows which one the answer took it from.'
      : '')
  )
}

export function describeGroundingFindings(report: GroundingReport): string {
  const lines: string[] = []
  if (report.code?.length) lines.push(...report.code)
  if (report.toolClaims?.length) {
    lines.push(
      `- Your answer says you used ${report.toolClaims.join(', ')}; no such call ran this turn. ` +
        'Either make the call, or say what you actually did instead.'
    )
  }
  if (report.toolDisclosure?.length) {
    lines.push(
      `- Your answer lists the tools it used and never names ${report.toolDisclosure.join(', ')}, ` +
        'which is what actually ran. List the calls this turn made, not the documents they returned.'
    )
  }
  if (report.toolCounts?.length) {
    lines.push(
      `- Your answer accounts for more calls than the turn made: ${report.toolCounts.join('; ')}. ` +
        'Give one entry per call that actually ran, and fold what a single call returned into ' +
        'that call rather than splitting it across rows.'
    )
  }
  if (report.toolArgs?.length) {
    lines.push(
      `- Quoted as the argument you passed, but not what the call received: ${report.toolArgs.join('; ')}. ` +
        'Quote the argument the call actually carried, or describe the call in your own words ' +
        'without putting a string in quotation marks.'
    )
  }
  if (report.quotes?.length) {
    lines.push(
      `- Presented as direct quotations but in no tool output: ${report.quotes.map((q) => `“${q}”`).join('; ')}. ` +
        (report.quotes.some(marksABreak)
          ? `${QUOTE_BREAK_MARKS.join('')} marks where the quotation stops matching the source. `
          : '') +
        'Quote the source line exactly, or drop the quotation marks and say you are paraphrasing.'
    )
  }
  if (report.attributions?.length) {
    lines.push(
      `- Attributed to the wrong document: ${report.attributions.join('; ')}. ` +
        'Name the document the numbered passage actually came from.'
    )
  }
  if (report.addresses?.length) {
    lines.push(`- Addresses that appear in no result: ${report.addresses.join('; ')}`)
  }
  if (report.contacts?.length) {
    lines.push(`- Contact details no tool returned: ${report.contacts.join('; ')}`)
  }
  if (report.links.length) {
    lines.push(`- Links that appear in no result: ${report.links.join('; ')}`)
  }
  if (report.citations?.length) {
    lines.push(
      `- Citation markers naming a passage that was never retrieved: ${report.citations.join(', ')}. ` +
        'Cite only the numbered passages you were handed, or drop the marker and say what is uncited.'
    )
  }
  if (report.figures.length) {
    lines.push(`- Figures nothing retrieved or computed supports: ${report.figures.join(', ')}`)
  }
  if (report.quantities?.length) {
    lines.push(
      '- Measurements nothing computed or retrieved supports: ' +
        `${report.quantities.join(', ')}. If a tool computed, or a retrieved passage states, a ` +
        'different number, use that one.'
    )
  }
  if (report.origins?.length) {
    lines.push(
      `- Your answer places the subject in ${report.origins.join(', ')}, which the sources never mention.`
    )
  }
  if (lines.length === 0) return ''

  return (
    // "…returned" alone was true until v1.17 and is not any more: the argument
    // rung reads what the calls were SENT. Round 6's recurring critique is a
    // sentence describing something adjacent to what was measured, and the
    // cheapest way to keep this one honest is to name both corpora it reads.
    'A mechanical check compared your answer against what this turn\'s tools were sent and ' +
    `what they returned (${report.checkedAgainst.join(', ')}). It found specifics nothing ` +
    'supports:\n\n' +
    `${lines.join('\n')}\n\n` +
    'Rewrite the answer. For each item: verify it with a tool, or drop it and say plainly what ' +
    'you could not confirm. Do not restate any of them as fact, and do not replace one ' +
    'unverified specific with another. Everything the sources do support stays — this is a ' +
    'correction, not a shorter answer. Give the full corrected answer, not a description of ' +
    'what you changed.'
  )
}

// ---- figures -----------------------------------------------------------------

/**
 * Currency amounts, with or without cents and with optional `~`/`about`.
 * Deliberately money-only: bare integers appear constantly in prose ("2017
 * models", "60 months") and flagging those would bury the signal.
 *
 * v1.17.2: the fraction is `\d+`, not `\d{1,2}`.
 *
 * The cap was an enumeration of the shapes money is *usually* written in —
 * whole dollars, tenths, cents — and a per-unit rate is not on that list. Over
 * `$0.007 per gallon` the pattern matched `$0.00` and left the `7` behind, so
 * the badge named **`$0.00`**: a figure that appears nowhere on screen, over a
 * figure that does. A reader who searches the answer for it finds nothing and
 * learns to discount the badge, which is round 4's cry-wolf in a new place.
 *
 * The cap was also, quietly, wrong about the *verdict* and not only the label.
 * `precisionOf` reads the matched text, so a sub-cent rate was checked at two
 * decimals against a value the reply never stated — and a reply quoting a
 * source's own `$0.007` came back unsupported, because 0.007 does not round to
 * 0.00. Reading the whole number makes the comparison strictly stricter (three
 * decimals must agree to three) as well as truthful about what it read.
 *
 * The digit group also has to *end* in a digit. `\d[\d,]*` is greedy about the
 * separator, so the sentence "rises to $30,000, an increase of…" yielded the
 * label **`$30,000,`** — the same defect as `$0.00` in miniature, a reader
 * searching the answer for a string it does not contain. Found by the v1.17.2
 * sweep, on the recorded V2 passage.
 */
const CURRENCY = /\$\s?(\d(?:[\d,]*\d)?(?:\.\d+)?)/g

/**
 * Money amounts in a blob of text — the only legitimate bases for arithmetic.
 *
 * Deriving from every bare number instead was a hole big enough to drive the
 * whole check through: a conversation containing the message "1" (a menu pick)
 * put 1 in the base set, and 1 multiplied by the permitted factors certifies
 * every integer from 2 to 24 as "supported". A fabricated "$5.00/bottle" came
 * back clean on exactly that. Prices derive from prices; counts are the
 * multipliers, not the source.
 */
function moneyIn(text: string): number[] {
  const found: number[] = []
  for (const m of text.matchAll(CURRENCY)) {
    const value = Number(m[1].replace(/,/g, ''))
    if (Number.isFinite(value)) found.push(value)
  }
  return found
}

/** Every number in a blob of text, as numeric values. */
function numbersIn(text: string): number[] {
  const found: number[] = []
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)/g)) {
    const value = Number(m[1].replace(/,/g, ''))
    if (Number.isFinite(value)) found.push(value)
  }
  return found
}

/**
 * Every number in a blob of text that is **not** already spoken for by a unit.
 *
 * v1.17.2, and it is `moneyIn`'s argument applied to the other side of the
 * same comparison. That function exists because deriving prices from every
 * bare number was "a hole big enough to drive the whole check through"; the
 * *support* side kept the hole. Measured on the recorded V3 run: the reply
 * stated `$5` for a washer kit and the badge said nothing, because a passage
 * mentioning "every 5 months" put a bare 5 in the corpus and a whole-dollar
 * figure is judged at zero decimals. A count of months is not an amount of
 * money, and the app already has one vocabulary that knows the difference —
 * shared/measurements.ts, the same one the quantities rung reads.
 *
 * Only the number a unit claims is dropped, by offset rather than by value, so
 * a corpus that prints `36.5` on one line and `36.5 miles` on another still
 * supports `$36.50` from the first.
 */
function amountsIn(text: string): number[] {
  const measured = new Set(measurementsIn(text).map((m) => m.index))
  const found: number[] = []
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)/g)) {
    if (measured.has(m.index)) continue
    const value = Number(m[1].replace(/,/g, ''))
    if (Number.isFinite(value)) found.push(value)
  }
  return found
}

/** Decimal places written in the source text, so rounding is judged at its precision. */
function precisionOf(raw: string): number {
  const dot = raw.indexOf('.')
  return dot === -1 ? 0 : raw.length - dot - 1
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/**
 * Multipliers a legitimate derivation reaches for: pack sizes, case counts,
 * bottles per pallet. Bounded so the search stays cheap and, more importantly,
 * so the check keeps its teeth — permit enough arithmetic and every invented
 * number becomes "derivable" from something.
 */
const MAX_DERIVATION_FACTOR = 24
/** Corpus numbers considered for derivation, newest first. */
const MAX_DERIVATION_BASES = 300

/**
 * Is `value` simple arithmetic on something already known?
 *
 * v1.4.5. The check flagged its own correct work: told "$2.51 per bottle", the
 * model wrote "$15.06 per 6-bottle case" and the badge reported $15.06 as
 * unsourced, because multiplication is not quotation. Every per-case and
 * per-unit figure in a pricing conversation tripped it, which is precisely the
 * kind of noise that teaches someone to ignore the badge on the turn it
 * matters. Integer multiples and divisions only — the derivations a pack size
 * or a case count produces, not a free hand with the numbers.
 */
function isDerivable(value: number, decimals: number, known: number[]): boolean {
  for (const k of known) {
    if (!k) continue
    for (let n = 2; n <= MAX_DERIVATION_FACTOR; n++) {
      if (roundTo(k * n, decimals) === value) return true
      if (roundTo(k / n, decimals) === value) return true
    }
  }
  return false
}

/**
 * Money figures in `answer` that nothing in `corpus` supports.
 *
 * A figure counts as supported when some corpus number rounds to it at the
 * precision the answer used — so "about $396" is backed by a computed
 * $396.02, while $293.50 is backed by nothing and is reported — or when it is
 * simple arithmetic on a corpus number (see `isDerivable`).
 */
export function unsourcedFigures(answer: string, corpus: string, sourceText = ''): string[] {
  const known = amountsIn(corpus)
  const bases = [...new Set(moneyIn(corpus))].slice(0, MAX_DERIVATION_BASES)
  // v1.11.2: a figure that appears verbatim in a page or search result the
  // model was handed is SOURCED, not invented — that is the whole point of the
  // source. Presence only, never derivation: a fetched page full of numbers
  // must not become a derivation base that certifies arbitrary arithmetic.
  const inSources = amountsIn(sourceText)
  const flagged: string[] = []
  const seen = new Set<string>()
  for (const match of answer.matchAll(CURRENCY)) {
    const raw = match[1]
    const value = Number(raw.replace(/,/g, ''))
    if (!Number.isFinite(value)) continue
    const decimals = precisionOf(raw)
    const supported =
      known.some((k) => roundTo(k, decimals) === value) ||
      isDerivable(value, decimals, bases) ||
      inSources.some((k) => roundTo(k, decimals) === value)
    if (supported) continue
    const label = `$${raw}`
    if (seen.has(label)) continue
    seen.add(label)
    flagged.push(label)
  }
  return flagged
}

/**
 * v1.9.2: quantities with units, checked when a computation tool ran — or,
 * from v1.12.2, when the library returned passages (see RETRIEVAL_TOOLS).
 *
 * The gap this closes, from a real session. Asked to sketch a cycling route,
 * the model called `run_python`, which added the legs and printed
 * "Grand total: 3755 miles" — with the standing instruction to state computed
 * numbers exactly as shown. The reply's own leg tables summed to 3,755, and
 * its headline said **"Total: ~3,015 miles"**. A figure contradicting the
 * app's own arithmetic, in the same message, and every rung of the ladder
 * passed it: `unsourcedFigures` iterates currency, `unsourcedPercentages`
 * iterates percents, and 3,015 miles is neither.
 *
 * The asymmetry is what makes this worth fixing rather than debating: a
 * measurement invented inside a *research brief* has been caught since v1.9,
 * because `researchGrounding` treats a number with a unit as the dangerous
 * class. The same invention in an ordinary reply went unremarked. Both rungs
 * now share one vocabulary — see shared/measurements.ts.
 *
 * Supported means what it means everywhere else here: the corpus contains the
 * value, at the precision the answer stated it ("about 20 minutes" for 19.6),
 * or it is simple arithmetic on something the corpus contains. Unit strings
 * are not compared — "3755 miles" is supported by a corpus that computed 3755
 * however it labelled it, because the failure being caught is an invented
 * *number*, and demanding matching labels would flag a reply for converting
 * "0.5 hours" into "30 minutes".
 *
 * v2.1: the walk also reports what it *skipped* — see `QuantityCoverage`.
 */

/**
 * Every measurement the reply states, split by whether this rung could say
 * anything about it at all.
 *
 * v2.1, and it is the same walk `unsourcedQuantities` has always done — the
 * two `continue`s in the loop below were already deciding "there is nothing
 * here to compare this against", they just did it in silence. Naming the two
 * skips is the whole of the change; no verdict moves.
 *
 * `checked` means a corpus quantity of the same kind was genuinely put beside
 * it. `unchecked` means one of the two skips fired: the dimension was never
 * armed (nothing this turn measured a volume at all), or it was armed and the
 * corpus holds nothing of comparable magnitude (a passage's "3 minutes" cannot
 * confirm or contradict "4 days"). Both are honestly "compared against
 * nothing", and a coverage claim that counted the second as covered would be
 * the same overstatement one rung down.
 */
export interface QuantityCoverage {
  /** Distinct `raw` spans this rung compared against the corpus. */
  checked: string[]
  /** Distinct `raw` spans it compared against nothing. */
  unchecked: string[]
  /** The subset of `checked` that nothing supports — the findings. */
  flagged: string[]
}

/** The findings only, which is what every caller before v2.1 wanted. */
export function unsourcedQuantities(answer: string, toolOutput: string, userText = ''): string[] {
  return quantityCoverage(answer, toolOutput, userText).flagged
}

/**
 * Is a coverage gap worth a line, or is it the checker's own vocabulary showing?
 *
 * The gap this filters is real but invisible to the reader. `gallon per year`
 * and `gallon` are different units here on purpose, so a passage stating
 * "2,000 gallons per year" arms neither the reply's "2,000 gallons" nor
 * anything else — and the pass then truthfully reports a measurement it never
 * compared, sitting directly above a passage that states it. The reader cannot
 * see the unit table; they can see the number, and a warning contradicted by
 * what is on screen is one they learn to skip.
 *
 * So: say it only when at least one skipped measurement's value appears
 * **nowhere** in what this turn produced or the user said. That is the V3
 * shape exactly — nothing ran, so 105 and 400 are in nothing — and it is not
 * the shape above.
 *
 * The gate is on the LINE, not on the items, and that is deliberate. Filtering
 * item by item would leave `checked + unchecked` short of the measurements the
 * reply states, so "covered 1 of 4" would name two things and silently drop a
 * third — a count the reader cannot reproduce from the screen, which is the
 * defect `describeRevisionOutcome` was fixed for in round 4. Every named item
 * is one the rung genuinely compared against nothing; the gate only decides
 * whether the set is worth showing.
 */
function coverageWorthSaying(unchecked: string[], findable: string): boolean {
  if (unchecked.length === 0) return false
  const known = numbersIn(findable)
  return unchecked.some((raw) => {
    const [m] = measurementsIn(raw)
    if (!m) return true
    const decimals = precisionOf(String(m.value))
    return !known.some((k) => roundTo(k, decimals) === m.value)
  })
}

export function quantityCoverage(
  answer: string,
  toolOutput: string,
  userText = ''
): QuantityCoverage {
  // Only ever judged against measurements of the same kind. If the tools
  // computed distances and the answer states a distance none of them support,
  // that is a disagreement with the app's own arithmetic — the case this rung
  // exists for. If the tools produced no duration at all, the answer's
  // duration is working-out or restated context, and there is nothing to
  // disagree with.
  //
  // Measured, and this is why the rule is shaped this way. The first version
  // compared every quantity against every number anywhere in the corpus, and
  // on the quantitative suite it fired twice, both times on answers scored
  // CORRECT: "227 minutes" (the tool printed the same time as "3:47") and
  // "42.54 gallons" (an intermediate Python computed but never printed). Both
  // were the model showing its work. A checker whose only findings are against
  // right answers is worse than no checker, because the next person to see the
  // badge has been taught to dismiss it.
  // Two corpora, two jobs, and conflating them is what defeated the previous
  // version. Only what the tools *produced* — computed, or retrieved verbatim
  // from a passage — can arm the check: if they worked in miles and the answer
  // states a distance they do not support, that is a disagreement with the
  // app's own arithmetic. A unit the user merely used in passing arms nothing:
  // the marathon prompt says "1 mile = 1.609344 km" and "3 hours 47 minutes",
  // which armed `mile` with the value 1 and `minute` with 47, and then
  // reported a correct 26.219 miles and a correct 227 minutes as unsupported.
  // Measured 2026-08-19, on an answer scored correct.
  //
  // But once armed, a value is supported by either corpus — a measurement the
  // user gave is theirs to restate, and always has been here.
  //
  // v1.17.2: armed by DIMENSION, not by unit string. v1.15 made temperature
  // "one dimension in two scales" because a corpus written in Fahrenheit armed
  // nothing about Celsius and half an invented "165°F / 74°C" went unnamed.
  // That was an instance of the rule, applied to one dimension; every other
  // quantity kept the enumeration. Measured consequence, recorded run V3: a
  // reply stated "2,000 to 3,600 gallons per year", "170 to 300 gallons" and
  // "7,570 to 13,640 liters", and the only rung that fired was currency —
  // litres and gallons were unrelated keys, so the corpus armed neither
  // against the other. See shared/measurements.ts.
  const armed = new Set(measurementsIn(toolOutput).map((m) => m.unit))
  const armedGroups = new Set<string>()
  for (const unit of armed) {
    const group = measurementGroup(unit)
    if (group) armedGroups.add(group)
  }
  const corpus = [...measurementsIn(toolOutput), ...measurementsIn(userText)]
  const flagged: string[] = []
  const checked: string[] = []
  const unchecked: string[] = []
  const seen = new Set<string>()
  // Distinct by the span as written, like `flagged` — a reply saying
  // "105 gallons" twice states one measurement, and a coverage count that read
  // it as two would be arithmetic the reader cannot reproduce from the screen.
  const seenChecked = new Set<string>()
  const seenUnchecked = new Set<string>()
  const record = (into: string[], mark: Set<string>, raw: string): void => {
    if (mark.has(raw)) return
    mark.add(raw)
    into.push(raw)
  }
  for (const m of measurementsIn(answer)) {
    const group = measurementGroup(m.unit)
    if (!armed.has(m.unit) && !(group && armedGroups.has(group))) {
      // Nothing this turn measured this kind of thing at all. This is the V3
      // skip: a plumbing reply's volumes over a turn that computed and
      // retrieved nothing, or over passages that state only money and months.
      record(unchecked, seenUnchecked, m.raw)
      continue
    }
    // Two support corpora, because the two say different things. A corpus
    // value in the SAME unit is the reply restating a number, and is judged at
    // the precision the reply wrote it. A corpus value in another unit of the
    // same dimension is the reply *converting* a number, which is arithmetic
    // it performed with a factor of its own choosing — see CONVERSION_SLACK.
    const exact: number[] = []
    const converted: number[] = []
    for (const c of corpus) {
      if (c.unit === m.unit) {
        exact.push(c.value)
        continue
      }
      if (!group || measurementGroup(c.unit) !== group) continue
      const inUnit = convertUnit(c.value, c.unit, m.unit)
      if (inUnit !== null && comparableMagnitude(m.value, inUnit, m.unit)) converted.push(inUnit)
    }
    if (exact.length === 0 && converted.length === 0) {
      // The dimension was armed and the corpus still holds nothing that is a
      // claim about the same thing — a passage's "3 minutes" beside a reply's
      // "4 days". `comparableMagnitude` is what keeps that quiet, and quiet is
      // right; calling it *checked* would be the overstatement this whole field
      // exists to stop.
      record(unchecked, seenUnchecked, m.raw)
      continue
    }
    record(checked, seenChecked, m.raw)
    const decimals = precisionOf(String(m.value))
    if (exact.some((k) => roundTo(k, decimals) === m.value)) continue
    if (converted.some((k) => agreesAfterConversion(m.value, k, decimals, m.unit))) continue
    // An interval scale is not derivable. Multiplying a temperature by a pack
    // size is meaningless — a fridge held at 40 °F does not license 80 °F, and
    // the integer-multiple rule that keeps per-case pricing quiet was
    // certifying exactly that. Ratio scales keep it, across the dimension: a
    // corpus that measured 950 miles supports "1900 miles" and, for the same
    // reason, supports it when the corpus wrote 1,528.9 km instead.
    if (
      isRatioScale(m.unit) &&
      isDerivable(m.value, decimals, [...exact, ...converted].slice(0, MAX_DERIVATION_BASES))
    )
      continue
    record(flagged, seen, m.raw)
  }
  return { checked, unchecked, flagged }
}

/**
 * Are two values of one dimension claims about the same thing at all?
 *
 * This is the bound on what dimension-arming is allowed to add, and the sweep
 * that built it is why it exists. Duration spans five orders of magnitude
 * between `second` and `week`, so a passage reading "rest for 3 minutes" armed
 * every duration in the reply and reported **`4 days`** — a storage figure
 * faulted because an unrelated line mentioned a resting time. Measured on the
 * recorded food-safety fixtures; it is round 4's cry-wolf with more units
 * armed, which is this change's whole risk.
 *
 * The bound is the one the file already uses: `isDerivable` says a corpus
 * value within `MAX_DERIVATION_FACTOR` can *explain* a stated value, as a pack
 * size or a case count. Past that factor it can neither produce the stated
 * value nor contradict it — it is a different quantity that happens to share a
 * dimension, and a check has nothing to say about it. Temperature is exempt
 * because a ratio between two points on an interval scale means nothing (0 °C
 * is not "no temperature"), and because the scale is narrow by nature: that is
 * why v1.15's two-scale rule needed no bound.
 *
 * Same-unit support is deliberately not gated. There the reply is speaking the
 * corpus's own language and a magnitude gap is a disagreement, not an
 * inference the check made — and that path keeps exactly the behaviour it has
 * had since v1.9.2.
 */
function comparableMagnitude(stated: number, corpus: number, unit: string): boolean {
  if (!isRatioScale(unit)) return true
  if (stated === 0 || corpus === 0) return stated === corpus
  const ratio = Math.abs(stated) / Math.abs(corpus)
  return ratio <= MAX_DERIVATION_FACTOR && ratio >= 1 / MAX_DERIVATION_FACTOR
}

/**
 * How far a converted value may sit from the stated one before the two are a
 * disagreement rather than the same quantity written twice.
 *
 * Half a percent, and only on a ratio scale. The argument for it is that a
 * unit conversion is arithmetic the *reply* did: it picks the factor (3.785,
 * 3.79, 3.8) and it picks how many digits to keep, and a value written to
 * three significant figures does not land on the exact product. Measured on
 * the run this rung was extended for: 2,000 gallons is 7,570.8 litres and the
 * reply wrote "7,570"; 3,600 gallons is 13,627.5 and the reply wrote
 * "13,640". Both are the same quantity, and a rung that named them would be
 * round 4's cry-wolf with more units armed.
 *
 * It is deliberately not applied to same-unit support, which keeps exactly the
 * rule it has had since v1.9.2, nor to an interval scale: °F↔°C is exact
 * arithmetic on small integers with no factor to round, so `74.2 °C` over a
 * retrieved `165 °F` (73.889) stays a finding. Half a percent is also far
 * tighter than the integer-multiple rule the same function grants two lines
 * below, so this is the strictest path to support, not a new loophole.
 */
const CONVERSION_SLACK = 0.005

function agreesAfterConversion(
  stated: number,
  converted: number,
  decimals: number,
  unit: string
): boolean {
  const rounding = 0.5 * 10 ** -decimals
  const slack = isRatioScale(unit) ? CONVERSION_SLACK * Math.abs(stated) : 0
  // 1e-9 absorbs the float error of the conversion itself, never a digit.
  return Math.abs(stated - converted) <= Math.max(rounding, slack) + 1e-9
}

// ---- where a supported measurement was found (v2.2) ----------------------------

/**
 * **The check that was asked for, and why it is not here.**
 *
 * Round 9's critics, on tasks V1 and V3: "Both screens report only literal
 * string presence, not aptness. One run's `3 to 5 days` and `1 week` are drawn
 * from the **ham** rows of the cold-storage table, and the other's `3 to 4
 * days` from `Fresh, uncured, cooked` — the chicken rows in the same passage
 * read `| Chicken or turkey, whole | 1 to 2 days |`. Neither app flagged a
 * quantity taken from the wrong row of a cited table."
 *
 * The observation is right and the check it asks for cannot be built honestly
 * here. Three reasons, in order of how badly each one bites.
 *
 * **The app does not know which row the model read, and neither did the
 * critic.** `3 to 4 days` occurs in *eleven* rows of
 * `packs/food-safety/docs/cold-food-storage-chart.md` — salads, cooked ham,
 * canned ham, egg substitutes, casseroles, two kinds of pie, soups and stews,
 * leftovers, chicken nuggets, pizza. A value repeated down a column has no
 * unique provenance. Naming one row as the source is a guess dressed as a
 * measurement, in the one place a reader has no way to check it.
 *
 * **On the critic's own example the guess points the wrong way.** The question
 * was how long cooked chicken keeps in the fridge. The row that answers it is
 * `| Leftovers | Cooked meat or poultry | 3 to 4 days |` — so `3 to 4 days` is
 * *correct*, and a rung built to this specification would have fired on a
 * right answer while attributing it to a ham. A checker whose findings land on
 * correct answers is worse than no checker; this file has paid for that lesson
 * twice (round 4's quote checker, and `quantityCoverage`'s own first version).
 *
 * **And deciding it requires understanding the question.** To know that
 * "cooked chicken in the fridge" is the leftovers row and not the fresh-
 * poultry row is to have comprehended the sentence — the exact assertion
 * `describeCoverage` refuses to make, for the exact reason set out there: the
 * app cannot tell *how much water should I store* from *how much water weight
 * will I lose*, and a line that implies it understood the question is
 * unfalsifiable by the reader it is addressed to.
 *
 * **So: the smaller true thing.** Say where a supported measurement was
 * actually matched — which numbered passage, and on how many of its lines —
 * and say plainly that the match was by value and not by row. That asserts
 * exactly what was measured: this value occurs *here*. A figure matched on one
 * line is located; a figure matched on eleven is disclosed as ambiguous, which
 * is the honest form of the critic's finding and is the fact a reader needs in
 * order to go and look at the rows themselves.
 *
 * Its failure mode, stated, as `describeCoverage`'s is: this line can never
 * tell a reader that a figure is wrong. It can only tell them where to look
 * and how many places there are to look at. That is less than was asked for
 * and it is all the evidence supports.
 */
export interface MeasurementSource {
  /** The span as the reply wrote it, so the reader can find it on screen. */
  raw: string
  /** The passages whose own text states that value, as their markers. */
  passages: string[]
  /** Lines of retrieved passage text that state it — a table row is a line. */
  lines: number
}

/** Beyond this many passages, the line stops naming them and counts the rest. */
const MAX_SOURCE_PASSAGES = 3

/**
 * Is `found` the same claim as `stated`, at the precision the reply wrote?
 *
 * The same two rules `quantityCoverage` supports a measurement by, minus
 * derivation. An integer multiple of a corpus value can *explain* a figure but
 * it is not a place the figure appears, and this line's whole claim is that
 * the reader will find the value there.
 */
function statesTheSameValue(stated: Measurement, found: Measurement): boolean {
  const decimals = precisionOf(String(stated.value))
  if (found.unit === stated.unit) return roundTo(found.value, decimals) === stated.value
  const group = measurementGroup(stated.unit)
  if (!group || measurementGroup(found.unit) !== group) return false
  const inUnit = convertUnit(found.value, found.unit, stated.unit)
  if (inUnit === null || !comparableMagnitude(stated.value, inUnit, stated.unit)) return false
  return agreesAfterConversion(stated.value, inUnit, decimals, stated.unit)
}

/**
 * Where each measurement the rung checked can be found in the passages.
 *
 * Only passages, deliberately: a marker is what a reader can open. A value
 * supported solely by the user's own words or by the app's arithmetic has no
 * passage to point at and is left out rather than pointed at vaguely.
 */
export function measurementSources(checked: string[], retrieved: Citation[]): MeasurementSource[] {
  if (retrieved.length === 0) return []
  const out: MeasurementSource[] = []
  for (const raw of checked) {
    const [stated] = measurementsIn(raw)
    if (!stated) continue
    const passages: string[] = []
    let lines = 0
    for (const c of retrieved) {
      let here = 0
      for (const line of (c.text ?? '').split('\n')) {
        if (measurementsIn(line).some((found) => statesTheSameValue(stated, found))) here++
      }
      if (here === 0) continue
      passages.push(`[${c.index}]`)
      lines += here
    }
    if (passages.length > 0) out.push({ raw, passages, lines })
  }
  return out
}

/**
 * v1.6: percentages, checked only when a computation tool ran this turn. A
 * model that has just had the app compute "East: 37,907.39" for it will still
 * add "about 45% of the total" from nowhere (measured; the true share was
 * 25.6%). Supported when the percentage appears in the tool output, or is the
 * ratio of two numbers the output contains, to the stated precision.
 */
const PERCENT = /(?<![\w.])(\d{1,3}(?:\.\d+)?)\s?%/g
const MAX_RATIO_BASES = 40

export function unsourcedPercentages(answer: string, corpus: string, sourceText = ''): string[] {
  const known = [...new Set(numbersIn(corpus))]
  const bases = known.filter((k) => k !== 0).slice(0, MAX_RATIO_BASES)
  // Presence-only source support — see unsourcedFigures. Measured (2026-08-19
  // session transcript): "1.7%" and "2.6%" stood verbatim in the web_search
  // results the reply was summarizing, and a trivial run_python on the same
  // turn armed this check against a corpus that excluded them — flagging a
  // correct reply. A checker whose findings are against right answers teaches
  // the reader to dismiss the badge.
  const inSources = [...new Set(numbersIn(sourceText))]
  const flagged: string[] = []
  const seen = new Set<string>()
  for (const match of answer.matchAll(PERCENT)) {
    const raw = match[1]
    const value = Number(raw)
    if (!Number.isFinite(value)) continue
    const decimals = precisionOf(raw)
    let supported =
      known.some((k) => roundTo(k, decimals) === value) ||
      inSources.some((k) => roundTo(k, decimals) === value)
    if (!supported) {
      outer: for (const a of bases) {
        for (const b of bases) {
          if (roundTo((a / b) * 100, decimals) === value) {
            supported = true
            break outer
          }
        }
      }
    }
    if (supported) continue
    const label = `${raw}%`
    if (seen.has(label)) continue
    seen.add(label)
    flagged.push(label)
  }
  return flagged
}

// ---- cross-tool figure conflicts (v1.12) --------------------------------------

/**
 * Two numeric tools stating different values for the same labelled figure in
 * one turn. Measured live on market_data's first real outing: the tool said
 * "period return (6mo): 14.61%" and the model's own run_python printed
 * "Period Return: -8.99%" — same turn, same label, wildly different numbers.
 * The reply happened to relay the right one, but nothing would have said a
 * word if it had picked the wrong one. This check makes the disagreement
 * itself visible; it does not adjudicate which side is right.
 *
 * Deliberately conservative: only figures written as an explicit
 * `label: value` line, only exact normalized-label matches across DIFFERENT
 * tool calls, only like units (% with %, $ with $), and only disagreements
 * beyond both a relative and an absolute threshold. A false "conflict" badge
 * teaches the reader to dismiss the badge — the recurring lesson of this file.
 */
interface LabeledFigure {
  label: string
  value: number
  unit: '%' | '$' | ''
  /** As written, for the report. */
  shown: string
}

const LABELED_FIGURE =
  /^[\s\-–•*]*([A-Za-z][A-Za-z0-9 /_'&.-]{3,48}?)(?:\s*\([^)]{0,24}\))?\s*[:=]\s*(\$)?\s*(-?\d[\d,]*(?:\.\d+)?)\s*(%)?/gm

function normalizeFigureLabel(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}

export function labeledFiguresIn(text: string): LabeledFigure[] {
  const out: LabeledFigure[] = []
  for (const m of text.matchAll(LABELED_FIGURE)) {
    const value = Number(m[3]!.replace(/,/g, ''))
    if (!Number.isFinite(value)) continue
    const label = normalizeFigureLabel(m[1]!)
    if (label.length < 4) continue
    out.push({
      label,
      value,
      unit: m[4] ? '%' : m[2] ? '$' : '',
      shown: `${m[1]!.trim()}: ${m[2] ?? ''}${m[3]}${m[4] ?? ''}`
    })
  }
  return out
}

/** Disagreement thresholds: beyond both, or it is rounding, not conflict. */
const CONFLICT_REL = 0.01
const CONFLICT_ABS = 0.02
const MAX_CONFLICTS = 3

export function conflictingToolFigures(records: ToolCallRecord[]): string[] {
  const numeric = records.filter((r) => NUMERIC_TOOLS.has(r.name) && r.status === 'done' && r.result)
  if (numeric.length < 2) return []
  const perRecord = numeric.map((r) => ({ name: r.name, figures: labeledFiguresIn(r.result ?? '') }))
  const conflicts: string[] = []
  const seen = new Set<string>()
  for (let a = 0; a < perRecord.length; a++) {
    for (let b = a + 1; b < perRecord.length; b++) {
      for (const fa of perRecord[a]!.figures) {
        for (const fb of perRecord[b]!.figures) {
          if (fa.label !== fb.label || fa.unit !== fb.unit) continue
          const abs = Math.abs(fa.value - fb.value)
          const rel = abs / Math.max(Math.abs(fa.value), Math.abs(fb.value), 1e-9)
          if (abs <= CONFLICT_ABS || rel <= CONFLICT_REL) continue
          const key = `${fa.label}|${fa.value}|${fb.value}`
          if (seen.has(key)) continue
          seen.add(key)
          conflicts.push(
            `${perRecord[a]!.name} says "${fa.shown}" but ${perRecord[b]!.name} says "${fb.shown}"`
          )
          if (conflicts.length >= MAX_CONFLICTS) return conflicts
        }
      }
    }
  }
  return conflicts
}

// ---- contact details ----------------------------------------------------------

/**
 * Phone numbers, including vanity spellings, and email addresses.
 *
 * The measured case: member-facing email copy closing with "call Member
 * Services at 1-800-SAM'S-CUB". That number is not Sam's Club's, is not a
 * number at all, and appeared in no tool result — it was assembled from the
 * shape of the brand name. A wrong price is embarrassing; a wrong phone number
 * in a mailshot sends real people somewhere real.
 */
// Case-sensitive, and the groups after the area code are joined by punctuation
// rather than a space, because both relaxations turn ordinary prose into a
// phone number: with neither, "$5,000 down you stay under $400" matched as
// "000 down you". Lowercase vanity numbers exist and are not worth the noise.
const PHONE =
  /(?:\+?\d{1,2}[-. ]?)?(?:\(\d{3}\)|\d{3})[-. ]?[A-Z0-9']{2,5}[-.][A-Z0-9']{3,5}\b/g
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g

/** Comparison form: letters and digits only, so punctuation cannot hide a match. */
function normalizeContact(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

/**
 * What a phone number is never chained to: another word, another digit group,
 * or the hyphen joining them. Deliberately not `'`, `_`, `*` or a quote — a
 * real number gets wrapped in those ("**1-800-555-0134**", `'212-308-6922'`)
 * and losing a true positive to markdown would be the worse trade.
 */
const CHAINED_TO_CONTACT = /[A-Za-z0-9-]/

/**
 * v1.16. The match is a slice of a longer unbroken token, not a number of its
 * own.
 *
 * Measured, task VC1: the user pasted a 220-character base64 probe out of a
 * server log and asked what it was. The reply decoded it — correctly — and the
 * decoded tail, "…-the-chat-column-0001-0002-0003-0004-…-0013", handed this
 * scanner four phone numbers: 0001-0002-0003, 0004-0005-0006, 0007-0008-0009,
 * 0010-0011-0012, under a badge telling the reader to verify them before
 * sending them anywhere. There were no contact details in that turn at all.
 * Round 4 recorded the lesson for the quote checker and it holds here: findings
 * against honest answers teach the reader to dismiss the badge.
 *
 * A dialable number is its own word. The trailing `\b` in PHONE already stops a
 * match that ends inside one; this is the other end and the other direction —
 * a match that STARTED mid-token, or whose digit chain runs on past it.
 */
function chainedInsideToken(text: string, start: number, end: number): boolean {
  if (start > 0 && CHAINED_TO_CONTACT.test(text[start - 1])) return true
  return /^-[A-Za-z0-9]/.test(text.slice(end, end + 2))
}

/**
 * Contact details the reply states that appear in no tool output and in
 * nothing the user said.
 *
 * Unlike links this is not gated on a source tool having run. A link with no
 * search behind it is often just the model recalling a homepage, but a support
 * line quoted to a customer is a specific, dialable claim, and there is no
 * version of inventing one that is acceptable.
 *
 * The corpus keeps the wider recognizer on purpose: `chainedInsideToken`
 * narrows what the ANSWER may be accused of, and a `known` set that admits more
 * shapes can only ever suppress a finding, never create one.
 */
export function unsourcedContacts(answer: string, corpus: string): string[] {
  const known = new Set(
    [...(corpus.match(PHONE) ?? []), ...(corpus.match(EMAIL) ?? [])].map(normalizeContact)
  )
  const phones: string[] = []
  for (const m of answer.matchAll(PHONE)) {
    const at = m.index ?? 0
    if (chainedInsideToken(answer, at, at + m[0].length)) continue
    phones.push(m[0])
  }
  const flagged: string[] = []
  const seen = new Set<string>()
  for (const raw of [...phones, ...(answer.match(EMAIL) ?? [])]) {
    const key = normalizeContact(raw)
    // A bare year range or "2026-2027" is not a phone number; require enough
    // characters that the match is a real contact rather than punctuation.
    if (key.length < 10) continue
    if (known.has(key) || seen.has(key)) continue
    seen.add(key)
    flagged.push(raw.trim())
  }
  return flagged
}

// ---- street addresses ----------------------------------------------------------

/**
 * A US street address: number, then street words, then a street type.
 *
 * The measured case: a sales route where three of seven stops carried
 * addresses that appeared in none of the search results the same turn had
 * collected — "Gristedes, 800 3rd Ave" on a turn where every Gristedes search
 * had failed on budget, and two Whole Foods addresses invented outright. The
 * three that were real came from the results verbatim, so the model was
 * perfectly capable of quoting; it filled the gaps rather than leaving them.
 *
 * An address is the same kind of claim as a link — specific, checkable, and
 * acted on by driving there.
 */
// Spaces and tabs between the words, never a newline. With `\s` the scanner
// glued a phone number to the address on the line below it — "212-308-6922\n
// 1031 First Avenue" matched as a single address, so the real one never
// entered the known set and was then reported as invented. An address does not
// wrap across lines in any output this reads.
const STREET_ADDRESS =
  /\b\d{1,5}[ \t]+(?:[A-Z0-9][A-Za-z0-9'.-]*[ \t]+){0,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Place|Pl|Plaza|Square|Sq|Parkway|Pkwy|Terrace|Broadway|Way)\b\.?/g

/**
 * Comparison form: case-folded, punctuation dropped, and the common street
 * types spelled out, so "800 3rd Ave" matches "800 Third Avenue" only when it
 * genuinely is the same string — abbreviation is normalized, wording is not.
 */
function normalizeAddress(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\bst\b/, 'street')
    .replace(/\bave\b/, 'avenue')
    .replace(/\brd\b/, 'road')
    .replace(/\bblvd\b/, 'boulevard')
    .replace(/\bdr\b/, 'drive')
    .replace(/\bln\b/, 'lane')
    .replace(/\bpl\b/, 'place')
    .replace(/\bsq\b/, 'square')
    .replace(/\bpkwy\b/, 'parkway')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Street addresses the reply states that appear in no tool output and in
 * nothing the user said.
 *
 * Gated on a source tool having run, like links: with no retrieval behind it an
 * address is the model answering from memory, which the `unverified` badge
 * already covers. The failure this catches is narrower and worse — sources
 * *were* consulted, some addresses came from them, and others were filled in
 * to complete the list.
 */
export function unsourcedAddresses(answer: string, corpus: string, retrievalRan = false): string[] {
  const known = new Set((corpus.match(STREET_ADDRESS) ?? []).map(normalizeAddress))
  if (known.size === 0 && !corpus.trim() && !retrievalRan) return []
  const flagged: string[] = []
  const seen = new Set<string>()
  for (const raw of answer.match(STREET_ADDRESS) ?? []) {
    const key = normalizeAddress(raw)
    if (known.has(key) || seen.has(key)) continue
    seen.add(key)
    flagged.push(raw.trim())
  }
  return flagged
}

// ---- origin ------------------------------------------------------------------

/**
 * Countries and their demonyms, for the one factual contradiction this app can
 * catch without a model: the reply relocating something the sources placed.
 *
 * The measured failure: a session researching Vichy Catalan, whose search
 * results said "Spain" or "Spanish" in ten separate snippets, produced a buyer
 * pitch deck describing "French spa water" and an outreach email promising
 * "direct import from France". Nothing flagged it. Of every error in that
 * conversation it is the one that would have cost the user the meeting.
 */
const ORIGINS: [country: string, pattern: RegExp][] = [
  ['Spain', /\b(spain|spanish)\b/i],
  ['France', /\b(france|french)\b/i],
  ['Italy', /\b(italy|italian)\b/i],
  ['Germany', /\b(germany|german)\b/i],
  ['Portugal', /\b(portugal|portuguese)\b/i],
  ['Switzerland', /\b(switzerland|swiss)\b/i],
  ['Japan', /\b(japan|japanese)\b/i],
  ['China', /\b(china|chinese)\b/i],
  ['Mexico', /\b(mexico|mexican)\b/i],
  ['Norway', /\b(norway|norwegian)\b/i],
  ['Iceland', /\b(iceland|icelandic)\b/i],
  // Fiji is deliberately absent. In this app's most common commercial domain
  // it is a water brand far more often than a country, and reporting the
  // competitor named in a comparison table as a geography error is the kind of
  // false positive that costs the badge its credibility. Measured: it fired on
  // "Fiji: ~$1.25/bottle @ club" in a competitor list.
  ['Greece', /\b(greece|greek)\b/i],
  ['Austria', /\b(austria|austrian)\b/i],
  ['Belgium', /\b(belgium|belgian)\b/i],
  ['Ireland', /\b(ireland|irish)\b/i],
  ['Scotland', /\b(scotland|scottish)\b/i],
  ['Canada', /\b(canada|canadian)\b/i],
  ['Brazil', /\b(brazil|brazilian)\b/i],
  ['India', /\b(india|indian)\b/i]
]

/**
 * Countries the answer names that appear nowhere in what the tools returned.
 *
 * Only speaks when the corpus establishes a geography of its own — if the
 * sources never mention a country, the reply naming one is ordinary knowledge
 * and none of this check's business. When they do, and the reply names a
 * different one, that is a contradiction worth showing the user.
 */
export function contradictedOrigins(answer: string, corpus: string): string[] {
  const inCorpus = ORIGINS.filter(([, p]) => p.test(corpus)).map(([c]) => c)
  if (inCorpus.length === 0) return []
  return ORIGINS.filter(([country, p]) => p.test(answer) && !inCorpus.includes(country)).map(
    ([country]) => country
  )
}

// ---- claimed tools (v1.12.1) ---------------------------------------------------

/**
 * The reply's account of its own process, checked against the turn's records.
 *
 * Every other rung here checks what the answer says about the *world*. This one
 * checks what it says about *itself*: "I've used web_search to gather the
 * latest data" on a turn where web_search was never offered and never ran. The
 * sentence is not a figure, a link or an address, so nothing above contradicted
 * it — and it is the claim a reader most readily believes, because it is a
 * claim about the app they are looking at.
 *
 * The vocabulary is the shared tool table, never a copy: rename a tool and this
 * check follows it, rather than quietly going blind on the new name.
 */
const TOOL_NAMES: readonly string[] = TOOL_DEFS.map((d) => d.name)

/**
 * The identifier as the reply might write it: `web_search`, optionally
 * backticked — or spelled out, but only as "the web search tool". Ungated
 * prose would report an ordinary sentence about market data as a tool claim,
 * and the phrase "tool" is what makes the spelled-out form a claim at all.
 */
function toolNamePattern(name: string): RegExp {
  return new RegExp(`\\b(?:${name}|${name.split('_').join('[ -]')}(?=\\s+tools?\\b))\\b`, 'gi')
}

/**
 * A first-person claim of having run something, in the same sentence and within
 * reach of the name: "I used X", "I've run X", "via X", "using X".
 */
const CLAIM_LEAD =
  /(?:\b(?:i|we)(?:'ve|'d| have| had)?\s+(?:just |already |then |also )?(?:used|ran|run|called|invoked|queried|executed|performed|checked)\b|\b(?:used|ran|called|invoked|queried|executed|performed|via|using)\b)[^\n]{0,32}$/i

/**
 * A tool the model is offering, declining or denying is not a tool it claims to
 * have run. "I can run web_search if you want", "I could not use web_search",
 * "no web_search is enabled" — all honest, none of them findings.
 */
const NOT_A_CLAIM =
  /\b(?:can|can't|cannot|could|should|would|will|may|might|try|trying|consider|recommend|suggest|if|unless|never|not|no|without|unable|instead|rather)\b|n't\b/i

/**
 * A claim about an earlier turn is outside what these records can judge — this
 * pass only ever sees the turn it is checking.
 */
const ANOTHER_TURN = /^[^.?!\n]{0,32}\b(?:earlier|previously|last turn|before|above|already)\b/i

/** How much of the sentence around the name is read for the claim. */
const CLAIM_WINDOW = 120

/**
 * Tools the reply says it used that ran nowhere in this turn's records.
 *
 * Status is deliberately not consulted: a tool that ran and errored *did* run,
 * and the reply saying so is true. What is false — and what this reports — is
 * naming a tool the turn never called at all.
 */
export function unrunToolClaims(answer: string, records: ToolCallRecord[]): string[] {
  const ran = new Set(records.map((r) => r.name))
  const flagged: string[] = []
  for (const name of TOOL_NAMES) {
    if (ran.has(name)) continue
    for (const m of answer.matchAll(toolNamePattern(name))) {
      const before = answer.slice(Math.max(0, m.index - CLAIM_WINDOW), m.index)
      const sentence = before.split(/[.?!\n]/).pop() ?? ''
      if (!CLAIM_LEAD.test(sentence) || NOT_A_CLAIM.test(sentence)) continue
      if (ANOTHER_TURN.test(answer.slice(m.index + m[0].length))) continue
      flagged.push(name)
      break
    }
  }
  return flagged
}

/**
 * A heading that opens the reply's own account of its tool use: "Tools used:",
 * "**Tools I used**", "### Tools called". Optional markdown furniture, and the
 * word "tool" is what makes it a disclosure rather than a sentence.
 */
const DISCLOSURE_HEADING =
  /^[ \t]*(?:[#>*_\-|]+[ \t]*)*\**[ \t]*tools?[ \t]+(?:i[ \t]+|we[ \t]+)?(?:used|use|called|ran|run|invoked|consulted)\b/im

/** A disclosure that says nothing ran is honest about naming no tool. */
const DISCLOSED_NOTHING = /\b(?:none|no tools?|nothing|without[ \t]+(?:any[ \t]+)?tools?)\b/i

/** The identifier as a disclosure row might write it, claim lead not required. */
function bareToolPattern(name: string): RegExp {
  return new RegExp(`\\b(?:${name}|${name.split('_').join('[ -]')})\\b`, 'i')
}

/**
 * Tools that ran this turn which the reply's own "Tools used" section omits.
 *
 * The gap `unrunToolClaims` cannot see. That check scans for tool *names*, so
 * it only ever speaks when the reply names one — and a disclosure that names
 * none is invisible to it. Measured: a turn whose sole call was
 * `reference_lookup` answered under a heading reading "Tools used:" with a
 * two-row table whose rows were library *documents*, never mentioning the tool
 * at all. Every name in it was real, every quote in it checked out, and the
 * reader's question — which tools ran — was answered with something that was
 * not a tool. Nothing above had a name to fault, so nothing was said.
 *
 * A reply is free to describe its process in prose; this speaks only when it
 * sets up an explicit tools-used section and then fails to name a call the
 * turn actually made. The section is taken as the rest of the answer, which is
 * the lenient direction: naming the tool anywhere after the heading clears it.
 */
export function undisclosedToolRuns(answer: string, records: ToolCallRecord[]): string[] {
  const ran = [...new Set(records.map((r) => r.name))]
  if (ran.length === 0) return []
  const heading = DISCLOSURE_HEADING.exec(answer)
  if (!heading) return []
  const section = answer.slice(heading.index + heading[0].length)
  if (DISCLOSED_NOTHING.test(section)) return []
  const omitted = ran.filter((name) => !bareToolPattern(name).test(section))
  // A section that names some of the calls is an account with a gap in it, not
  // a fabricated one; only a section naming none of them is the measured shape.
  return omitted.length === ran.length ? omitted.sort() : []
}

// ---- how many times it ran (v2.2) ----------------------------------------------

/**
 * v2.2: the reply's account of **how many times** a tool ran.
 *
 * Measured, blind, round 9, task TH1 — the task whose prompt is, in as many
 * words, "tell me exactly which tools you used to get that and what each one
 * gave back". The reply answered with a table giving `reference_lookup` two
 * rows, each with its own query and its own results. One call ran. The
 * transcript holds one tool block and `trace/audit.jsonl` holds one entry, so
 * the app knew the true number the whole time and said nothing: every rung it
 * had stops at identity. `unrunToolClaims` asks whether a *named* tool ran at
 * all — it did. `undisclosedToolRuns` asks whether the account names the calls
 * that ran — it does. v1.17's rung asks whether the *arguments* are the ones
 * that went, and reads the two stated queries against the one that went, so
 * whichever row quotes the real query clears itself and the other is one
 * unmatched string rather than an invented call. None of them counts.
 *
 * A count is the same species as an argument and it is read the same way. Two
 * rows say two retrievals happened, so a reader takes the second row's
 * passages to be evidence the first did not have, and takes the coverage of
 * the question to be twice what it was.
 *
 * **Only overstatement speaks.** An account that lists fewer entries than the
 * turn ran is an account with a gap in it — `undisclosedToolRuns`' territory,
 * and that check deliberately stays quiet unless a section names *none* of the
 * calls. Claiming work that did not happen is the direction that misleads, and
 * it is the measured one.
 */

/** A line that offers one entry of a list: a table row, a bullet, a numbered item. */
const ENUMERATED_LINE = /^[ \t]{0,3}(?:\||[-*+][ \t]|\d{1,2}[.)][ \t])/

/**
 * The first unbroken run of entry lines after the disclosure heading — the
 * table or list the account is written as.
 *
 * Bounded to one run on purpose. `undisclosedToolRuns` takes the section as
 * the whole rest of the answer, which is right for asking whether a name
 * appears anywhere and wrong for counting: prose further down that mentions
 * the tool twice more would become two more calls. A run of adjacent rows is
 * what a reader counts, and stopping at the first blank or prose line is the
 * lenient direction — a second table for a second tool goes uncounted, which
 * costs a miss and cannot manufacture a finding.
 */
function firstEnumeration(section: string): string[] {
  const block: string[] = []
  for (const line of section.split('\n')) {
    if (ENUMERATED_LINE.test(line)) {
      block.push(line)
      continue
    }
    if (block.length > 0) break
  }
  return block
}

/**
 * Entries that name the tool. One line is one entry however many times it says
 * the name — a row with the tool in its "Tool" cell and again in its notes is
 * one row, and counting the occurrences instead would invent a call out of the
 * reply's own prose.
 */
function enumeratedEntries(section: string, name: string): number {
  const bare = bareToolPattern(name)
  return firstEnumeration(section).filter((line) => bare.test(line)).length
}

/** Written-out counts, up to the point where a reply starts using digits. */
const COUNT_WORDS: Record<string, number> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6
}

/**
 * The count said out loud rather than laid out in rows: "2 calls to
 * reference_lookup", "two reference_lookup lookups".
 *
 * The noun is the gate, and it has to be a word for *a call* — that is what
 * separates an account of the turn's work from "3 reference_lookup passages",
 * which counts something else entirely. Needs no heading above it, because the
 * tool's own name inside the phrase is what makes it a claim about that tool.
 */
const CALL_NOUNS = 'calls?|lookups?|queries|searches|invocations?|runs?'

function statedCallCountPattern(name: string): RegExp {
  const written = Object.keys(COUNT_WORDS).join('|')
  const tool = `\`?(?:${name}|${name.split('_').join('[ -]')})\`?`
  const qualifier = '(?:separate[ \\t]+|distinct[ \\t]+|different[ \\t]+)?'
  return new RegExp(
    `\\b(\\d{1,2}|${written})[ \\t]+${qualifier}` +
      `(?:(?:${CALL_NOUNS})[ \\t]+to[ \\t]+${tool}|${tool}[ \\t]+(?:${CALL_NOUNS}))\\b`,
    'gi'
  )
}

/** One tool, the number of calls the reply accounts for, and the number that ran. */
export interface OverstatedToolCount {
  name: string
  /** Entries the reply's account gives it, or the number it states outright. */
  claimed: number
  /** Calls the turn actually made, errored ones included — an errored call ran. */
  ran: number
}

/**
 * Tools the reply's own account credits with more calls than the turn made.
 *
 * Both readings of "how many" are taken, and the larger is reported: a table
 * with three rows and a sentence saying two are two accounts of one turn, and
 * the one a reader is more likely to carry away is the bigger. Neither reading
 * can speak about a tool that did not run — that is `unrunToolClaims`' finding,
 * not a miscount — and neither can speak when the account is short, which is
 * the lenient direction argued for above.
 */
export function overstatedToolCounts(
  answer: string,
  records: ToolCallRecord[]
): OverstatedToolCount[] {
  const ranByName = new Map<string, number>()
  for (const r of records) ranByName.set(r.name, (ranByName.get(r.name) ?? 0) + 1)
  if (ranByName.size === 0) return []
  const heading = DISCLOSURE_HEADING.exec(answer)
  const section = heading ? answer.slice(heading.index + heading[0].length) : ''
  const flagged: OverstatedToolCount[] = []
  for (const [name, ran] of ranByName) {
    let claimed = section === '' ? 0 : enumeratedEntries(section, name)
    for (const m of answer.matchAll(statedCallCountPattern(name))) {
      const written = m[1]!.toLowerCase()
      const stated = COUNT_WORDS[written] ?? Number(written)
      if (Number.isFinite(stated) && stated > claimed) claimed = stated
    }
    if (claimed > ran) flagged.push({ name, claimed, ran })
  }
  return flagged.sort((a, b) => a.name.localeCompare(b.name))
}

/** One finding, as the badge and the correction prompt both print it. */
export function describeToolCount(finding: OverstatedToolCount): string {
  return `${finding.name}: ${finding.claimed} calls accounted for, ${finding.ran} ran`
}

export function overstatedToolCountLines(answer: string, records: ToolCallRecord[]): string[] {
  return overstatedToolCounts(answer, records).map(describeToolCount)
}

// ---- quotations ----------------------------------------------------------------

/**
 * v1.14: text the reply presents as verbatim, checked against what came back.
 *
 * The library hands the model numbered passages and the turn block tells it to
 * quote figures and steps rather than paraphrase them. It does quote — and a
 * measured turn put `"checking leftovers daily,"` inside quotation marks when
 * the retrieved passage reads "check leftovers daily for spoilage". One word
 * away, in the register of the pack, presented exactly as the true quotation
 * two paragraphs above it was. The substring test that catches it is ten lines
 * long and runs on data the app already holds in the same message.
 *
 * Strict on purpose: character for character after folding whitespace, case
 * and the unicode quote/dash variants a renderer introduces. A span stitched
 * from two places in the source with a dash is not a quotation from either,
 * and tolerating the join would license exactly the fabrication this catches.
 * An explicit ellipsis is the one exception, because that is the writer
 * *marking* the omission rather than hiding it.
 */
/** Code is not prose: a string literal in a snippet is not a citation claim. */
const FENCED = /```[\s\S]*?(?:```|$)/g
const INLINE_CODE = /`[^`\n]*`/g

const STRAIGHT_QUOTED = /"([^"\n]{25,400})"/g
const CURLY_QUOTED = /“([^”\n]{25,400})”/g
const BLOCKQUOTE_LINE = /^[ \t]{0,3}>[ \t]?(.{25,400})$/gm

const QUOTED_SPANS = [STRAIGHT_QUOTED, CURLY_QUOTED, BLOCKQUOTE_LINE]

/**
 * v2.2: the credit line under a blockquote is the quoter's, not the source's.
 *
 * Measured, blind, round 9, task TH3. The reply blockquoted a pack line and
 * signed it, which is the shape a model reaches for when it is asked to quote
 * *and* attribute in one breath:
 *
 *     > "Cold air must circulate around refrigerated foods to keep them
 *       properly chilled." [7] — FDA, Refrigerator thermometers — cold facts
 *
 * The quotation inside the marks is verbatim and the straight-quote pattern
 * passed it. The blockquote pattern then bounded the SAME claim by the line
 * instead — carrying the closing mark, the marker and the signature — matched
 * nothing, and the badge said the quotation appears "in no tool output this
 * turn". `misquotedSpans` marked the divergence honestly (`⟪" [7] — FDA,
 * Refrigerator thermometers — cold facts⟫`), so the marker was right and the
 * headline over it was wrong: a fabrication warning on a quotation that is
 * word for word in the source.
 *
 * v1.15 trimmed a marker off either edge for the same reason and stopped
 * there, which is round 5's recurring shape — an enumeration of the furniture
 * seen so far, defeated by the next piece. The general rule was already
 * written down twelve lines above, in the fold that will not delete a
 * quotation mark: **the marks are where the verbatim claim starts and stops.**
 * A blockquote carrying a quotation of citation length is that quotation, and
 * every one of those is already collected by the two patterns above; a
 * blockquote carrying no marks is still bounded by its line, which is what the
 * pattern is for.
 *
 * What it gives up is a miss, not a false alarm: an invented gloss written
 * *outside* the marks inside a blockquote is no longer read as quoted. It was
 * never presented as quoted, every other rung still reads it, and round 4
 * settled which of the two errors costs more.
 */
function carriesAQuotation(line: string): boolean {
  for (const pattern of [STRAIGHT_QUOTED, CURLY_QUOTED]) {
    // `.exec` on a global pattern would carry `lastIndex` to the next line.
    for (const m of line.matchAll(pattern)) {
      if (flattenQuote(m[1]).length >= MIN_QUOTED) return true
    }
  }
  return false
}

/** Explicit elision — the quoter said a cut is here, so each side is checked apart. */
const ELISION = /\s*(?:\.\.\.|…|\[\.\.\.\]|\[…\])\s*/
const ELISION_G = new RegExp(ELISION.source, 'g')

/** The shortest quoted span that reads as a citation rather than scare quotes. */
const MIN_QUOTED = 25

/**
 * v1.17: emphasis is markup, not words — and it was on both sides of this check
 * and in the badge's own output.
 *
 * Measured (task V2): the reply bolded the figure inside a quotation it had
 * copied verbatim, and the badge printed
 * `⚠️ …the standard deduction rises to **$3…` — raw markdown in user-facing
 * text, and a fabrication warning on a passage the source states word for word.
 * `**$30,000**` and `$30,000` are the same quotation; the reader saw no
 * asterisks either way, so neither does the comparison, and neither does the
 * excerpt the badge shows.
 *
 * Paired delimiters only, a delimiter may not appear inside its own run, and
 * the run may not open or close on a space — CommonMark's flanking rule, and
 * the reason a footnoted source line (`within 2 hours* of cooking. *Or 1 hour
 * above 90 °F`) keeps both of its asterisks. That rule matters more here than
 * it does in a renderer: this fold runs over the corpus and over the reply
 * separately, so a delimiter that pairs up on one side and not the other would
 * manufacture exactly the false positive it is here to remove. A single `_` is
 * left alone for the same reason — `use_by_date` and `snake_case` are ordinary
 * tool output, and CommonMark does not read an intraword underscore as
 * emphasis either. A link needs its `(` against the `]`, so the attribution
 * shape `[5] (USDA Safe Food Handling)` is not one.
 */
const MARKDOWN_MARKUP: [RegExp, string][] = [
  [/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1'],
  [/\*\*([^*\s](?:[^*\n]*[^*\s])?)\*\*/g, '$1'],
  [/__([^_\s](?:[^_\n]*[^_\s])?)__/g, '$1'],
  [/~~([^~\s](?:[^~\n]*[^~\s])?)~~/g, '$1'],
  [/\*([^*\s](?:[^*\n]*[^*\s])?)\*/g, '$1']
]

function stripMarkdown(text: string): string {
  let out = text
  for (const [pattern, to] of MARKDOWN_MARKUP) out = out.replace(pattern, to)
  return out
}

/**
 * v1.17: the glyph a quotation mark is drawn with is the renderer's choice, not
 * the source's claim.
 *
 * Measured (task TH3): the pack reads `the simple rule is: “When in doubt,
 * throw it out.”`. The reply quoted the sentence around it, so its own outer
 * pair took the double marks and the nested one came out as
 * `‘When in doubt, throw it out.’`. Curly already folded to straight — single
 * to double did not — so two glyphs out of a hundred and four fired a
 * fabrication warning on a verbatim quotation.
 *
 * Every quotation glyph folds to one, and the dash family with it. The line is
 * drawn at the glyph's SHAPE: nothing here deletes a mark or moves one.
 * Swapping « for " cannot change which words are quoted. Dropping one can —
 * `"when in doubt", throw it out` and `"when in doubt, throw it out"` are
 * different claims about where the source's sentence ended, and they stay
 * different strings through this fold.
 */
const QUOTE_GLYPH = /['‘’‚‛ʼ`´"“”„‟′″‵‶«»‹›]/
const DASH_GLYPH = /[‐‑‒–—―−]/
const WHITESPACE = /\s/

/**
 * The comparison form, plus the index in the original that each character of it
 * came from — which is what lets the badge point at the divergence in the text
 * the reader actually saw.
 */
interface FlatText {
  flat: string
  /** `at[i]` is the offset in the original of `flat[i]`. Same length as `flat`. */
  at: number[]
}

function flattenParts(text: string): FlatText {
  const chars: string[] = []
  const at: number[] = []
  let pendingSpace = -1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (WHITESPACE.test(ch)) {
      if (chars.length > 0 && pendingSpace < 0) pendingSpace = i
      continue
    }
    const folded = QUOTE_GLYPH.test(ch) ? '"' : DASH_GLYPH.test(ch) ? '-' : ch.toLowerCase()
    if (pendingSpace >= 0) {
      chars.push(' ')
      at.push(pendingSpace)
      pendingSpace = -1
    }
    for (let k = 0; k < folded.length; k++) {
      chars.push(folded[k]!)
      at.push(i)
    }
  }
  return { flat: chars.join(''), at }
}

/** Fold the differences a renderer or a keyboard introduces, and nothing else. */
function flattenQuote(text: string): string {
  return flattenParts(text).flat
}

/**
 * v1.15: the citation marker a quoter puts beside a quotation — `[1]`, `[2][3]`,
 * `[1, 2]`. It is the quoter's own attribution, never a word the source wrote.
 *
 * Measured (task V2): a passage quoted word for word inside a markdown
 * blockquote, `> "…tax year 2024." [1]`. The blockquote pattern bounds a span
 * by the line rather than by the quotation marks, so the span carried the marks
 * and the marker, matched nothing, and the badge cried wolf on a quotation the
 * straight-quote pattern had already matched and passed in the same reply.
 * Trimmed at either edge, like the quoter's other punctuation below; the body
 * still has to be in the corpus character for character.
 */
const MARKER = String.raw`(?:\s*\[\d{1,3}(?:\s*[,;]\s*\d{1,3})*\])+`
const MARKER_HEAD = new RegExp(`^${MARKER}`)
const MARKER_TAIL = new RegExp(`${MARKER}[\\s.]*$`)

/** Trailing prose punctuation the quoter added is not part of the source line. */
function trimQuoteEdges(span: string): string {
  return span
    .replace(MARKER_HEAD, '')
    .replace(MARKER_TAIL, '')
    .replace(/^[\s'"([-]+/, '')
    .replace(/[\s'"),.;:-]+$/, '')
}

/**
 * v2.2: the signature at the end of a blockquote, which is the quoter's too.
 *
 * `MARKER_TAIL` above trims `[7]`, and round 9 wrote `[7] — FDA, Refrigerator
 * thermometers — cold facts`, so the marker was no longer last and none of it
 * came off. That is v1.15's repair one piece of furniture behind the model —
 * the recurring shape this file keeps recording — and it is the case
 * `carriesAQuotation` cannot reach, because a blockquote with no quotation
 * marks has no marks to be bounded by.
 *
 * It runs at the span, before the fold, and only on a blockquote. Both halves
 * of that matter. Before the fold, because `looksLikeTitle` reads capitals and
 * `flattenQuote` lower-cases — the first version of this ran inside
 * `trimQuoteEdges`, which is called on folded text, and silently never fired.
 * Only on a blockquote, because inside quotation marks the marks are the
 * boundary and everything between them is offered as the source's.
 *
 * Three gates on the tail itself, each load-bearing. The dash opens the line or
 * is **spaced**, or `use-by date Kept Cold` reads as a signature. The tail
 * **ends the line**, because a signature does. And it passes `looksLikeTitle` —
 * the same test the attribution rung uses to tell a document from a sentence —
 * which is what keeps a recorded true positive alive: the stitched `Ground
 * meats, such as beef and pork — 160°F` has one word after its dash and no
 * capital, so nothing is trimmed and the invented join is still reported.
 *
 * What it can cost is a fabrication written *as* a title-shaped signature at
 * the very end of a line. That is a miss; the alternative — trimming on the
 * dash alone — deletes source text from the comparison and turns real
 * misquotations into passes, which is the error that cannot be allowed.
 */
const CREDIT_TAIL = /(?:^|[ \t])[–—-][ \t]+([^\n]{2,60})$/

function withoutCredit(line: string): string {
  const m = CREDIT_TAIL.exec(line)
  return m && looksLikeTitle(m[1]!) ? line.slice(0, m.index).trimEnd() : line
}

/** Every span the reply offers as a direct quotation, in the order it wrote them. */
function quotedSpans(answer: string): string[] {
  const prose = stripMarkdown(answer.replace(FENCED, ' ').replace(INLINE_CODE, ' '))
  const out: string[] = []
  for (const pattern of QUOTED_SPANS) {
    for (const m of prose.matchAll(pattern)) {
      let span = m[1].trim()
      if (pattern === BLOCKQUOTE_LINE) {
        // See `carriesAQuotation`: a blockquote that carries its own quotation
        // marks has already been read at the marks, by the patterns above.
        if (carriesAQuotation(span)) continue
        // …and one that does not is bounded by its line, so its signature has
        // to come off the end. See `withoutCredit`.
        span = withoutCredit(span)
      }
      if (flattenQuote(span).length < MIN_QUOTED) continue
      out.push(span)
    }
  }
  return out
}

/** One side of an explicit elision, and where in the flattened span it starts. */
interface QuotePart {
  text: string
  at: number
}

function quoteParts(flat: string): QuotePart[] {
  const parts: QuotePart[] = []
  let at = 0
  for (const m of flat.matchAll(ELISION_G)) {
    const text = flat.slice(at, m.index)
    if (text) parts.push({ text, at })
    at = m.index + m[0].length
  }
  const rest = flat.slice(at)
  if (rest) parts.push({ text: rest, at })
  return parts
}

function inSource(text: string, source: string): boolean {
  return source.includes(text) || source.includes(trimQuoteEdges(text))
}

/**
 * The longest run from one end of `text` that occurs anywhere in `source`.
 * Binary search is exact here: if a prefix of length k is absent, so is every
 * longer one.
 */
function longestAnchor(text: string, source: string, fromEnd: boolean): number {
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const run = fromEnd ? text.slice(text.length - mid) : text.slice(0, mid)
    if (source.includes(run)) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * An anchor shorter than this is a coincidence, not evidence: `s.`, `, and` and
 * `the ` occur in every English paragraph, and letting one bound the marker
 * would point the reader at the wrong words.
 */
const ANCHOR_MIN = 5

const LETTER = /\p{L}/u

/**
 * Where the quotation stops matching, as `[start, end)` in `text`: everything
 * before it is in the source, and so is everything after. An empty range means
 * the two anchors met — the words are all there, in a different arrangement —
 * and the badge then shows the span without singling anything out.
 */
function divergentRange(text: string, source: string): { start: number; end: number } {
  const head = longestAnchor(text, source, false)
  const tail = longestAnchor(text, source, true)
  const start = head >= ANCHOR_MIN ? head : 0
  let end = Math.max(start, tail >= ANCHOR_MIN ? text.length - tail : text.length)
  // The two ends are not read the same way, so they are not rounded the same
  // way. The head grows from the quotation's own first character, so where it
  // stops is a fact about the sentence — `check|ing leftovers daily` is exactly
  // how far the source and the reply agree, and saying so is the useful thing.
  // The tail is anchored to nothing the reader is reading in that direction: a
  // few letters agreeing at the end of a word is an artefact of the search, so
  // a break that stops inside a word takes the rest of that word with it.
  // Letters only — a digit is not a spelling, and `$3⟪2⟫,000` is the whole
  // point of marking the break at all.
  while (end > start && end < text.length && LETTER.test(text[end]!) && LETTER.test(text[end - 1]!)) {
    end++
  }
  return { start, end }
}

/**
 * v1.17. The badge used to print the first 72 characters of the span and an
 * ellipsis, which on the two runs that produced this fix cut the sentence off
 * *before* the words it was complaining about — a fabrication warning on text
 * with nothing visibly wrong in it. A reader who cannot see the difference
 * cannot check it, and a warning that cannot be checked is one they learn to
 * skip.
 *
 * So the excerpt is a window centred on the break rather than a prefix, and the
 * break itself is marked. `⟪⟫` is not a fabrication verdict on the words inside
 * it: it is where the app stopped being able to find the quotation in what the
 * tools returned.
 */
export const QUOTE_BREAK_MARKS = ['⟪', '⟫'] as const

/** Whether a reported quotation carries the marker, and so needs its legend. */
export function marksABreak(quote: string): boolean {
  return quote.includes(QUOTE_BREAK_MARKS[0])
}

/** Long enough to carry both sides of the break, short enough to stay a line. */
const EXCERPT = 88

/** Do not cut a word in half at the ellipsis: take the nearest space, if it is near. */
function snapStart(text: string, from: number, limit: number): number {
  for (let i = from; i < Math.min(limit, from + 12); i++) {
    if (WHITESPACE.test(text[i]!)) return i + 1
  }
  return from
}

function snapEnd(text: string, to: number, limit: number): number {
  for (let i = to; i > Math.max(limit, to - 12); i--) {
    if (WHITESPACE.test(text[i]!)) return i
  }
  return to
}

function markedExcerpt(display: string, start: number, end: number): string {
  const [open, close] = QUOTE_BREAK_MARKS
  const width = end - start
  // Nothing to single out: the break runs the length of the span (the whole
  // quotation is unsupported, and the sentence above already says so), or it is
  // wider than the window, in which case every word shown is inside it anyway.
  if (width <= 0 || width >= Math.min(EXCERPT, display.length)) {
    return display.length > EXCERPT
      ? `${display.slice(0, snapEnd(display, EXCERPT, 0)).trimEnd()}…`
      : display
  }
  const room = EXCERPT - width
  let to = Math.min(display.length, end + Math.floor(room / 2))
  // Whatever the right-hand side did not need is spent on the left, so a break
  // near the end of the span still gets its run-up.
  const from = Math.max(0, start - (room - (to - end)))
  to = Math.min(display.length, end + (room - (start - from)))
  const cutLeft = from > 0
  const cutRight = to < display.length
  const head = display.slice(cutLeft ? snapStart(display, from, start) : 0, start)
  const tail = display.slice(end, cutRight ? snapEnd(display, to, end) : display.length)
  return (
    (cutLeft ? `…${head.trimStart()}` : head) +
    open +
    display.slice(start, end) +
    close +
    (cutRight ? `${tail.trimEnd()}…` : tail)
  )
}

/**
 * Quoted spans in `answer` that no captured tool output contains.
 *
 * `corpus` is what the tools *returned*, plus the user's own words — never the
 * arguments the model chose. A model that passes its invention to a lookup as
 * the query would otherwise find it quoted back into the corpus and certified.
 */
export function misquotedSpans(answer: string, corpus: string): string[] {
  const source = flattenQuote(stripMarkdown(corpus))
  if (!source) return []
  const flagged: string[] = []
  const seen = new Set<string>()
  for (const span of quotedSpans(answer)) {
    const { flat, at } = flattenParts(span)
    // Keyed on the trimmed form: a blockquote and the quotation marks inside it
    // are two patterns bounding one claim, and one claim earns one finding. The
    // quote patterns run tightest-first, so the reported span is the tighter.
    const key = trimQuoteEdges(flat)
    // Nothing left once the quoter's own furniture comes off — a span that is
    // all marker and punctuation offers no words as the source's, so there is
    // no quotation to check. `inSource` reaches the same verdict by way of
    // `includes('')`; saying it here means it is not an accident.
    if (key === '') continue
    if (seen.has(key)) continue
    const missing = quoteParts(flat).find((part) => !inSource(part.text, source))
    if (!missing) continue
    seen.add(key)
    // The break is located in whichever form failed — the tighter one, since
    // that is the one that had its last chance to match.
    const tight = trimQuoteEdges(missing.text) || missing.text
    const shift = missing.at + Math.max(0, missing.text.indexOf(tight))
    const { start, end } = divergentRange(tight, source)
    flagged.push(
      markedExcerpt(
        span,
        at[shift + start] ?? span.length,
        shift + end < at.length ? at[shift + end]! : span.length
      )
    )
  }
  return flagged
}

// ---- stated arguments ------------------------------------------------------------

/**
 * v1.17: the reply's account of what it *passed* a tool, against what went.
 *
 * `unrunToolClaims` checks the tool's name and `undisclosedToolRuns` checks
 * that the account names every call. Both stop at the name. Measured, task
 * TH1: the user asked, in as many words, "tell me exactly which tools you used
 * to get that and what each one gave back", and the reply named the right tool
 * and gave this argument —
 *
 *     query: "ground beef safe internal temperature"
 *
 * — where `trace/audit.jsonl` and the tool block both show that what was sent
 * was the user's entire prompt, second clause and all. The name was correct, so
 * every rung above passed it; a blind critic scored the task a tie precisely
 * because neither build was ever put to the test on it.
 *
 * The difference is not cosmetic. A reader told the query was narrow and
 * targeted reads the passages under it as responsive to that query. What
 * actually happened is that a 151-character sentence went to a keyword-ranked
 * local library, which ranks on whichever words dominate it — a materially
 * different retrieval, and the stated argument is how the reader judges
 * whether the results answer the question at all.
 *
 * **Where the line falls.** A reply that paraphrases its call — "I looked up
 * the safe temperature for ground beef" — is describing its own work in its
 * own words and is making no checkable claim; this rung says nothing about it,
 * and must not, because a badge that fires on an honest paraphrase teaches the
 * reader to dismiss the badge (round 4, recorded). A reply that puts a string
 * in quotation marks and hands it to a named parameter has quoted the call.
 * So: **an argument in quotes is a quotation**, and it is judged exactly as
 * `misquotedSpans` judges one — against the string the call actually carried,
 * with an explicit ellipsis the only permitted cut.
 *
 * What makes that robust to the forms nobody has seen yet is the direction of
 * the vocabulary, which is round 5's lesson applied twice. The parameter names
 * come from the shared tool table rather than a list written here, and the
 * known-good set is *what the turn actually sent* — never an enumeration of
 * the shapes a fabrication takes. A phrasing this scanner does not recognise
 * costs a miss; it cannot manufacture a finding.
 */

/** The calls whose arguments decide what came back, hence what a reader acts on. */
const ARGUMENT_TOOLS = new Set([...SOURCE_TOOLS, ...RETRIEVAL_TOOLS])

/**
 * String parameters of those tools, read off the shipped schemas — rename a
 * parameter and this follows it, instead of going quietly blind on the new name.
 *
 * The restriction to source and retrieval tools is an argument, not a
 * convenience. Those arguments decide what the tool went and got; they are
 * short human-readable text a reader can compare by eye; and for a reader who
 * does not open the call block, the reply is the only place they appear. A
 * `run_python` body or a note's text is a different animal — long, structured,
 * rendered verbatim in its own block — and a reply quoting a fragment of one is
 * not making a claim about what was retrieved. Numbers are out for the same
 * reason plus a sharper one: `max_passages: 6` is not something a reader reads
 * the results through.
 */
const ARGUMENT_PARAMS: readonly string[] = [
  ...new Set(
    TOOL_DEFS.filter((d) => ARGUMENT_TOOLS.has(d.name)).flatMap((d) => {
      const props = (d.parameters as unknown as { properties?: Record<string, { type?: string }> })
        .properties
      return Object.entries(props ?? {})
        .filter(([, schema]) => schema?.type === 'string')
        .map(([name]) => name)
    })
  )
]

/**
 * Whatever markdown the reply wrapped the parameter name in before its value:
 * `query: "…"`, `**Query:** "…"`, `"query": "…"`, `| query | "…" |`,
 * `query ("…")`. Bounded, so the name and the value have to be adjacent.
 *
 * The quote glyphs are in here because the JSON form — which is how a model
 * that has just made a call most often writes one — closes the *name* with a
 * quote: `{"query": "…"}`. Without them the scanner read `": "` as a two-
 * character value and walked past the real one.
 */
const ARG_FURNITURE = '[\\s:=*_`|>()\\[\\]"“”–—-]{0,6}'

/**
 * The value as a reply writes it — straight quotes, curly quotes, or a code
 * span. Deliberately not the unquoted form: an unquoted value has no end a
 * scanner can find, and it is the quoting that turns a description of the call
 * into a claim about its exact text.
 */
const ARG_VALUE = '"([^"\\n]{2,240})"|“([^”\\n]{2,240})”|`([^`\\n]{2,240})`'

function statedArgumentPattern(param: string): RegExp {
  return new RegExp(`\\b${param.split('_').join('[ _-]')}\\b${ARG_FURNITURE}(?:${ARG_VALUE})`, 'gi')
}

/** How far back a stated argument may look for the call it is attributed to. */
const ARGUMENT_WINDOW = 200

/** Below this, a quoted fragment is a word in a sentence, not an account of a call. */
const MIN_STATED_ARG = 4

/** A value longer than this is elided in the finding, with the cut marked. */
const MAX_ARG_SHOWN = 72

/** At most this many actual values are named before the line stops enumerating. */
const MAX_ARG_SENT = 2

/**
 * A value as the badge shows it.
 *
 * Emphasis inside the value is the reply's own furniture, and leaking markdown
 * into a user-facing line is a defect this project has already recorded once
 * (round 6, task V2: a warning reading `rises to **$3…`). The ellipsis is the
 * app marking its own cut, which is the only honest way to shorten a string the
 * reader is being asked to compare.
 */
function showArgument(value: string): string {
  const flat = value.replace(/[*`]/g, '').replace(/\s+/g, ' ').trim()
  return flat.length > MAX_ARG_SHOWN ? `${flat.slice(0, MAX_ARG_SHOWN - 1)}…` : flat
}

/**
 * Is the stated value the argument that went?
 *
 * Same standard as a quotation, and the same folding: whitespace, case and the
 * quote/dash glyphs a renderer introduces, plus the reply's own emphasis. A
 * stated value that is a contiguous part of what was sent is clean — the reply
 * quoted a fragment of its query rather than inventing one — and an explicit
 * ellipsis lets an honestly-shortened long query through, exactly as it does
 * for a passage.
 */
function argumentMatches(stated: string, passed: string[]): boolean {
  const flat = flattenQuote(stated.replace(/[*`]/g, ''))
  const parts = flat.split(ELISION).filter(Boolean)
  if (parts.length === 0) return true
  return passed.some((sent) => {
    const source = flattenQuote(sent)
    return parts.every((part) => source.includes(part))
  })
}

export interface StatedArgument {
  /** The parameter, as the tool table spells it. */
  param: string
  /** The value the reply put in quotes. */
  stated: string
  /** The distinct values calls this turn actually passed for that parameter. */
  passed: string[]
  /** Whether the call actually carried it — see `argumentMatches`. */
  matched: boolean
}

export interface MisstatedArgument {
  /** The parameter, as the tool table spells it. */
  param: string
  /** The value the reply put in quotes. */
  stated: string
  /** The distinct values calls this turn actually passed for that parameter. */
  passed: string[]
}

/**
 * Arguments the reply attributes to a call that the call never carried.
 *
 * Two gates keep this quiet, and both are the lenient direction. The reply has
 * to be talking about a call — a tool that ran this turn is named within reach,
 * or the statement sits under the reply's own tools-used heading — because the
 * word "query" beside a string in a code sample is not an account of anything.
 * And the parameter has to be one some call this turn actually passed: with
 * nothing sent there is nothing to contradict, and a reply describing a call
 * that never happened is `unrunToolClaims`' business, not this one.
 */
export function statedArgumentsIn(answer: string, records: ToolCallRecord[]): StatedArgument[] {
  const inScope = records.filter((r) => ARGUMENT_TOOLS.has(r.name))
  if (inScope.length === 0) return []
  const ranNames = [...new Set(inScope.map((r) => r.name))]
  const heading = DISCLOSURE_HEADING.exec(answer)
  const disclosureFrom = heading ? heading.index + heading[0].length : -1
  const found: StatedArgument[] = []
  const seen = new Set<string>()
  for (const param of ARGUMENT_PARAMS) {
    const passed = [
      ...new Set(
        inScope
          .map((r) => r.args?.[param])
          .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      )
    ]
    if (passed.length === 0) continue
    for (const m of answer.matchAll(statedArgumentPattern(param))) {
      const stated = (m[1] ?? m[2] ?? m[3] ?? '').trim()
      if (flattenQuote(stated).length < MIN_STATED_ARG) continue
      const at = m.index ?? 0
      const attributed =
        (disclosureFrom >= 0 && at >= disclosureFrom) ||
        ranNames.some((name) =>
          bareToolPattern(name).test(answer.slice(Math.max(0, at - ARGUMENT_WINDOW), at))
        )
      if (!attributed) continue
      const key = `${param}|${flattenQuote(stated)}`
      if (seen.has(key)) continue
      seen.add(key)
      found.push({ param, stated, passed, matched: argumentMatches(stated, passed) })
    }
  }
  return found
}

export function misstatedArgumentsIn(
  answer: string,
  records: ToolCallRecord[]
): MisstatedArgument[] {
  return statedArgumentsIn(answer, records)
    .filter((a) => !a.matched)
    .map(({ param, stated, passed }) => ({ param, stated, passed }))
}

/** One finding, as the badge and the correction prompt both print it. */
export function describeMisstatedArgument(finding: MisstatedArgument): string {
  const sent = finding.passed
    .slice(0, MAX_ARG_SENT)
    .map((p) => `“${showArgument(p)}”`)
    .join(' / ')
  return `${finding.param}: “${showArgument(finding.stated)}” — the call sent ${sent}`
}

export function misstatedToolArguments(answer: string, records: ToolCallRecord[]): string[] {
  return misstatedArgumentsIn(answer, records).map(describeMisstatedArgument)
}

// ---- attributions ---------------------------------------------------------------

/**
 * `[5] (USDA Safe Food Handling)` — a marker with the document it names.
 *
 * Two shapes, both of which a model reaches for unprompted: a parenthetical
 * straight after the marker, and a marker opening a line or a table cell with
 * the document's title after it. Bounded and punctuation-free so an ordinary
 * aside — "[5] (see the note below), which says…" — is not read as a title.
 *
 * v1.15 adds a third, which is the one a model reaches for when it attributes
 * a figure mid-sentence: the marker INSIDE the parenthetical, the document
 * after it — `(source: [1] Cold Food Storage Chart)`. Measured (task V1,
 * run-1): the storage figure was attributed to that when [1] is *Safe minimum
 * internal temperatures* and the chart is [5]. Neither shape above sees it —
 * one wants the title in the brackets' wake, the other wants the marker to
 * open the line — so the check built for exactly this error said nothing.
 *
 * The lead-in word is optional; the closing paren is not. Bounding the title
 * by `)` is what stops it running on into prose and turning an ordinary
 * sentence into a document name, and `(sources: [1], [2], [4])` is not matched
 * at all — a marker followed by a comma names no document.
 */
const ATTRIBUTIONS = [
  /\[(\d{1,3})\][ \t]*\(([^)\n]{2,60})\)/g,
  /^[ \t|>*_-]*\[(\d{1,3})\][ \t]+([^|\n\t]{2,60}?)[ \t]*(?:\||\t|$)/gm,
  /\((?:(?:sources?|from|per|see|via|ref|citing|cited in)[ \t]*:?[ \t]*)?\[(\d{1,3})\][ \t]+([^)\n]{2,60})\)/gi,
  // v2.2, and it is the other half of the credit line `carriesAQuotation`
  // stopped mis-reading as a quotation. A signed blockquote —
  // `> "…chilled." [7] — FDA, Refrigerator thermometers — cold facts` — puts
  // the marker mid-line and the document after a dash, which is the one shape
  // none of the three above can see: the first two want the title in
  // parentheses, and pattern two wants the marker to OPEN the line. So the
  // turn that stopped crying wolf about the signature would also have said
  // nothing whatever had the signature been wrong, which is half a repair.
  //
  // The dash is the gate and it is doing real work. A marker followed by
  // ordinary prose (`the passage at [3] gives the figure`) names no document
  // and is not matched at all; `looksLikeTitle` then throws out the asides a
  // dash does introduce, because they carry sentence punctuation or fewer than
  // two capitals. Anchored to the line's end, because a credit line ends its
  // line — that is what makes it a signature rather than a clause.
  /\[(\d{1,3})\][ \t]*[–—-][ \t]*([^|\n\t]{2,60})[ \t]*$/gm
]

/** Words carrying no identity — a title match on "of" would mean nothing. */
const TITLE_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'and', 'in', 'on', 'at', 'to', 'from', 'with', 'by', 'passage'
])

function titleWords(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).filter((w) => !TITLE_STOPWORDS.has(w))
  )
}

/**
 * A title, not a sentence: no sentence punctuation, short enough to be a name,
 * and carrying at least two capitalised words. The capitalisation is what
 * separates "(USDA Safe Food Handling)" from "(see the note below, which
 * qualifies it)" — an aside the check has no business ruling on, and which
 * shares no word with any label, so without this it read as a document nothing
 * retrieved.
 */
function looksLikeTitle(text: string): boolean {
  const words = text.trim().split(/\s+/)
  if (/[.!?;]/.test(text) || words.length > 10) return false
  return words.filter((w) => /^[A-Z]/.test(w)).length >= 2
}

/**
 * Attributions naming a document that is not the passage the marker points at.
 *
 * `danglingCitations` catches a marker naming no retrieved passage. This
 * catches the marker that resolves — and is then labelled with someone else's
 * document. Measured: a reply attributed `[5]` to "USDA Safe Food Handling"
 * when passage [5] was USDA's *Leftovers and food safety* and "Safe food
 * handling" was passage [4], an FDA page. The citation opens correctly, so by
 * eye it checks out; the name over it sends the reader to the wrong document.
 *
 * The test uses the retrieved labels as its whole vocabulary, which is what
 * keeps it quiet. A word the model added that belongs to no passage at all
 * ("USDA FSIS …" for a page the label calls USDA) is extra detail this cannot
 * judge and does not fault. A word that belongs to a *different* retrieved
 * passage and not this one is the swap itself. And an attribution with no
 * overlap at all names a document the turn never retrieved.
 */
export function misattributedCitations(answer: string, retrieved: Citation[]): string[] {
  if (retrieved.length === 0) return []
  const labels = new Map(retrieved.map((c) => [c.index, titleWords(c.label)]))
  const prose = answer.replace(FENCED, ' ').replace(INLINE_CODE, ' ')
  const flagged: string[] = []
  const seen = new Set<string>()
  for (const pattern of ATTRIBUTIONS) {
    for (const m of prose.matchAll(pattern)) {
      const index = Number(m[1])
      const name = m[2].trim()
      const own = labels.get(index)
      if (!own || !looksLikeTitle(name)) continue
      const words = titleWords(name)
      if (words.size === 0) continue
      const elsewhere = new Set<string>()
      for (const [i, set] of labels) if (i !== index) for (const w of set) elsewhere.add(w)
      const foreign = [...words].some((w) => !own.has(w) && elsewhere.has(w))
      const supported = [...words].some((w) => own.has(w))
      if (!foreign && supported) continue
      const finding = `[${index}] ${name}`
      if (seen.has(finding)) continue
      seen.add(finding)
      flagged.push(finding)
    }
  }
  return flagged
}

// ---- links -------------------------------------------------------------------

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g

/** Trailing punctuation from prose is not part of the URL. */
function normalizeUrl(url: string): string {
  return url
    .replace(/[.,;:!?]+$/, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/**
 * Links in `answer` that appear in no tool output.
 *
 * Exact match after normalization, on purpose: a model that takes a real
 * collection URL and appends a plausible-looking path has invented a page, and
 * treating "same origin" as good enough would let exactly that through.
 */
export function unsourcedLinks(answer: string, corpus: string, retrievalRan = false): string[] {
  const known = new Set((corpus.match(URL_PATTERN) ?? []).map(normalizeUrl))
  // An empty corpus normally means nothing was retrieved, so nothing is being
  // contradicted. `retrievalRan` says the opposite happened: retrieval was
  // attempted and came back with nothing, which is precisely when every URL in
  // the reply was written from memory. See checkToolGrounding.
  if (known.size === 0 && !corpus.trim() && !retrievalRan) return []
  const flagged: string[] = []
  const seen = new Set<string>()
  for (const raw of answer.match(URL_PATTERN) ?? []) {
    const url = normalizeUrl(raw)
    if (known.has(url) || seen.has(url)) continue
    seen.add(url)
    flagged.push(url)
  }
  return flagged
}

// ---- the pass ----------------------------------------------------------------

/** Successful output of the records whose names pass `include`. */
/**
 * Tool output as evidence. `errored` widens to records that ended in error:
 * v1.6 — a run_python that printed the totals and then failed at the plot has
 * still computed those totals, and the model that quotes them from that
 * record is quoting real output. Links and addresses keep the stricter rule.
 */
const STDOUT_BEFORE_ERROR = /stdout before the error:\n([\s\S]*?)\n\nerror:/

/** The output an errored run still produced (workbenchFormat's section), or '' when there is none. */
export function producedBeforeError(record: ToolCallRecord): string {
  if (record.status !== 'error') return ''
  const m = (record.result ?? '').match(STDOUT_BEFORE_ERROR)
  return m ? m[1] : ''
}

function outputOf(records: ToolCallRecord[], include: (name: string) => boolean, errored = false): string {
  return records
    .filter((r) => include(r.name))
    .map((r) => (r.status === 'done' ? (r.result ?? '') : errored ? producedBeforeError(r) : ''))
    .filter(Boolean)
    .join('\n')
}

/**
 * Compare a finished reply against the turn's tool output.
 *
 * Returns null when there is nothing to say — which is the common case, and
 * must stay cheap: no badge unless something in the answer genuinely has no
 * backing.
 *
 * `userText` joins the corpus for figures because the user's own numbers (a
 * budget, a down payment) are theirs to restate, and flagging those would be
 * noise. It is deliberately *not* part of the link corpus: a URL the user
 * pasted is fine to echo, but the app has still not verified it, and the
 * pasted-link case is rare enough not to be worth the false-negative.
 *
 * v1.5: it must be *every* user message, not just the latest one. Passing only
 * the current turn produced the badge's worst false positive — a v1.4 session
 * where the user said "$5,000 to invest, $500 a month" four turns earlier and
 * every figure in the resulting plan was flagged as unsourced, including the
 * app's own arithmetic on those numbers. A badge that cries wolf on the user's
 * own budget is a badge they learn to ignore, which costs exactly the cases it
 * exists for.
 */
export function checkToolGrounding(
  answer: string,
  records: ToolCallRecord[],
  userText: string,
  options: {
    /**
     * The turn was a purchase decision, so prices needed a pricing tool. Set
     * by `looksLikeShopping`, and it makes the figure check run even when no
     * such tool ran — because on a shopping turn that is the *worse* case, not
     * a reason to skip: every price in the reply then came from memory.
     */
    expectPricingTool?: boolean
  } = {}
): GroundingReport | null {
  if (!answer.trim()) return null

  // v1.11.2: a run_python whose output the app itself marked as hardcoded
  // (every printed number is a literal in the code — see workbenchFormat's
  // HARDCODED_NUMBERS_NOTE) neither arms the numeric checks nor supports the
  // reply's figures. Without this, a model could print its invented numbers
  // through the sandbox and this checker would certify them as computed.
  //
  // v1.12.3 generalises it: `checksNothing` is the same verdict reached by a
  // different route — the app has already told the user, in the 🧮 line, that
  // this run re-derived the answer from itself. A run the footer calls circular
  // cannot also be a run the footer says it checked against.
  const verifiedNothing = (r: ToolCallRecord): boolean =>
    (r.result ?? '').includes(LAUNDERED_OUTPUT_MARKER) || r.checksNothing === true
  const honest = records.filter((r) => !verifiedNothing(r))
  const numericRecords = honest.filter(
    (r) => NUMERIC_TOOLS.has(r.name) && (r.status === 'done' || producedBeforeError(r) !== '')
  )
  // Such a run ARMS the checks — a fabrication attempt is the moment for
  // maximum scrutiny — while contributing nothing to the support corpus.
  const verifiedNothingNumeric = records.some((r) => verifiedNothing(r) && NUMERIC_TOOLS.has(r.name))
  const sourceRecords = records.filter((r) => r.status === 'done' && SOURCE_TOOLS.has(r.name))
  // v1.12.1: an errored source tool ARMS the link, origin and address checks
  // instead of disarming them. Gating them on `sourceRecords.length > 0` had it
  // exactly backwards: a turn whose search failed ran no link check at all,
  // which is the turn where the model holds no retrieved URLs and every one it
  // prints came from memory. Attempted retrieval is the signal; what the
  // attempt returned is the corpus, and an empty corpus supports nothing.
  const failedSources = records.filter((r) => r.status === 'error' && SOURCE_TOOLS.has(r.name))
  const triedToRetrieve = sourceRecords.length > 0 || failedSources.length > 0

  // v1.4.5: a reply that states several prices is checked whether or not a
  // pricing tool ran. The gate used to be the shopping heuristic, so a turn it
  // did not recognize as commerce — "email campaign copy", in a measured
  // session — could put a whole table of invented per-bottle prices in front of
  // the user with nothing said about it. What a figure is checked against is
  // unchanged; only whether the check runs at all.
  const computedCorpus = outputOf(honest, (n) => NUMERIC_TOOLS.has(n), true)
  const figureCorpus = `${computedCorpus}\n${userText}`
  const sourceCorpus = outputOf(records, (n) => SOURCE_TOOLS.has(n))
  const retrievedCorpus = outputOf(records, (n) => RETRIEVAL_TOOLS.has(n))
  const stated = unsourcedFigures(answer, figureCorpus, sourceCorpus)
  // v1.16, and it is the measurements rung's v1.12.2 argument applied to money.
  // Measured, task V2: asked where the standard deduction number comes from, the
  // reply opened "For tax year 2026: $34,000" over a passage that states $30,000
  // for 2025 and no 2026 figure at all. `unsourcedFigures` saw it — it returns
  // exactly ["$34,000"], the $30,000 and $800 in the same reply being correctly
  // read off the passage — and this gate then dropped it: `reference_lookup` is
  // not in NUMERIC_TOOLS, so nothing armed the rung, and one figure is under
  // MIN_UNPROMPTED_FIGURES. The link check ran on the same reply and named an
  // invented anchor, so the turn shipped having checked the link and skipped the
  // number.
  //
  // A passage is not a computation, but it is authoritative about the dollar
  // amount it states, and the reply proved it could quote by quoting two of
  // them. The limit is the same one measurements draws: passages that quote no
  // money arm nothing, because there is then nothing to stand outside of and
  // "about $20 a bag" is the `unverified` badge's business. Swept over all 34
  // recorded judge-r5 replies this adds exactly one finding — the $34,000.
  const retrievedMoney = moneyIn(retrievedCorpus).length > 0
  const checkFigures =
    numericRecords.length > 0 ||
    verifiedNothingNumeric ||
    options.expectPricingTool === true ||
    retrievedMoney ||
    stated.length >= MIN_UNPROMPTED_FIGURES
  // Percentages only when something actually computed this turn — that is
  // when a stated share had a source it should have used.
  const percentages =
    numericRecords.length > 0 || verifiedNothingNumeric
      ? unsourcedPercentages(answer, figureCorpus, sourceCorpus)
      : []
  const figures = [...(checkFigures ? stated : []), ...percentages]
  // Nearly the percentages gate, widened in v1.12.2 by what the library
  // returned. With nothing computed AND nothing retrieved there is no corpus,
  // and a reply that says "about 20 minutes" from general knowledge is not
  // making a claim the tools could have backed — that turn is the `unverified`
  // badge's business, not this one. But once passages are in hand, a dose or a
  // temperature they contradict is precisely the claim this rung exists for,
  // and it is the standard the library eval has always scored replies against.
  const quantityRungRan = numericRecords.length > 0 || retrievedCorpus.trim() !== ''
  // The user-text corpus doubles as the passive-support corpus (see the comment
  // in `quantityCoverage`); source-tool text joins it for the same reason it
  // supports figures: a measurement read off a fetched page is sourced, not a
  // disagreement with the app's arithmetic.
  //
  // v2.1: the gate feeds the corpus rather than skipping the call, so the walk
  // happens either way and the turn where the rung does not run is the turn
  // that reports every measurement as unchecked — which is the V3 turn, and
  // was previously indistinguishable on screen from a clean scan. An empty
  // arming corpus arms nothing, so this cannot produce a finding it did not
  // produce before: `flagged` is [] whenever `quantityRungRan` is false.
  const coverage = quantityCoverage(
    answer,
    quantityRungRan ? `${computedCorpus}\n${retrievedCorpus}` : '',
    quantityRungRan ? `${userText}\n${sourceCorpus}` : ''
  )
  const quantities = coverage.flagged

  // On the failure path the user's own words join the link corpus, and only
  // there. A URL they pasted is normally excluded (see the note above — the app
  // has still not verified it), but when the fetch that would have verified it
  // errored, "I could not open https://…" must not be reported as an invented
  // link. Nothing model-written enters the corpus either way.
  const linkCorpus = failedSources.length > 0 ? `${sourceCorpus}\n${userText}` : sourceCorpus
  const links = triedToRetrieve
    ? unsourcedLinks(answer, linkCorpus, failedSources.length > 0)
    : []
  const origins = triedToRetrieve ? contradictedOrigins(answer, sourceCorpus) : []
  // The user's own words join the corpus: an address they gave is theirs.
  const addresses = triedToRetrieve
    ? unsourcedAddresses(answer, `${sourceCorpus}\n${userText}`, failedSources.length > 0)
    : []
  // Every tool's output, plus the user's own words — a number they gave is
  // theirs to repeat. Ungated, unlike links: see `unsourcedContacts`.
  const contacts = unsourcedContacts(answer, `${outputOf(records, () => true)}\n${userText}`)
  // Ungated, like contacts: what the reply says about its own process is always
  // checkable against the records, and a turn with no tools at all is the turn
  // where "I searched for this" is furthest from true.
  const toolClaims = unrunToolClaims(answer, records)
  // The other half of the same question: not a tool it names that never ran,
  // but the tool that ran and its own tools-used section leaves out.
  const toolDisclosure = undisclosedToolRuns(answer, records)
  // …and the third reading of the same account: the call it names did run and
  // is named, and the account gives it more entries than the turn has calls.
  // Ungated for the same reason as the two above — the records hold the true
  // number, so there is never a turn where this cannot be checked.
  const toolCounts = overstatedToolCountLines(answer, records)
  // And the rung past both: the call it names did run, its account of the call
  // is complete, and the argument it quotes is not the one the call carried.
  // Ungated for the same reason as the two above — the records are the whole
  // corpus, so there is never a turn where this cannot be checked.
  const statedArgs = statedArgumentsIn(answer, records)
  const toolArgs = statedArgs
    .filter((a) => !a.matched)
    .map(({ param, stated, passed }) => describeMisstatedArgument({ param, stated, passed }))
  // Ungated by design — `danglingCitations` only speaks when passages were
  // actually retrieved, which is the only situation in which a bracketed
  // number is a claim about them.
  const retrieved = retrievedCitations(records)
  const citations = danglingCitations(answer, retrieved)
  // Quotation fidelity, gated on retrieval the same way: with nothing fetched
  // there is no source a quotation could be checked against, and a quoted
  // phrase is just prose. The corpus is what every tool RETURNED plus the
  // user's own words — never the arguments the model chose, or a model could
  // launder an invented line through its own query string.
  const quotedCorpus = triedToRetrieve ? `${outputOf(records, () => true, true)}\n${userText}` : ''
  // One claim earns one finding, and the specific rung wins. A stated argument
  // written in straight quotes is also a quoted span, so both rungs see it —
  // and only one of them is right about what it is. "Quoted as exact but in no
  // tool output" is the wrong accusation against a query string: it was never
  // offered as something a tool returned. It is what the reply says it *sent*,
  // which is the sentence above, with the actual argument beside it.
  //
  // v2.2: **every** stated argument, not only the misstated ones. The filter
  // read `misstatedArgs`, so the sentence above held exactly when the reply got
  // its query wrong — and a reply that quoted the query *correctly* kept the
  // wrong accusation, with no argument finding to replace it. Found while
  // building the count rung, on its own true negative: an honest two-call
  // account whose rows quote the two queries verbatim drew
  // `⚠️ Quoted as exact but in no tool output this turn: "ground beef safe
  // internal temperature"`, which is a fabrication warning on a reply that
  // fabricated nothing. What makes the accusation wrong is the *shape* of the
  // claim, and that does not change with whether the claim is true.
  //
  // The laundering hole the corpus rule exists to close stays closed: a
  // `param: "value"` context beside a call is what makes a span a stated
  // argument, and an invented line the model passed as its query and then
  // blockquoted as a source is not written in that shape.
  //
  // v1.17.1: matched against the excerpt's *content*, not its head. The span a
  // misquote now reports is a window centred on the divergence, carrying the
  // ⟪⟫ break marks and an ellipsis on whichever side was trimmed — so the old
  // `startsWith` test, written when a span was a truncated prefix, stopped
  // recognising the very overlap it exists to catch. Strip the presentation
  // and ask whether either string contains the other.
  const bare = (text: string): string =>
    flattenQuote(text)
      .split(QUOTE_BREAK_MARKS[0])
      .join('')
      .split(QUOTE_BREAK_MARKS[1])
      .join('')
      .replace(/^…/, '')
      .replace(/…$/, '')
      .trim()
  const quotes = misquotedSpans(answer, quotedCorpus).filter((span) => {
    const flat = bare(span)
    if (flat === '') return true
    return !statedArgs.some((arg) => {
      const stated = bare(arg.stated)
      return stated.includes(flat) || flat.includes(stated)
    })
  })
  const attributions = misattributedCitations(answer, retrieved)
  // Every measurement the rung compared and found stated somewhere, with the
  // passage that states it. A flagged one drops out on its own — it was
  // compared against values of the same kind and matched none of them, so
  // there is no line to point at.
  const matched = measurementSources(coverage.checked, retrieved)

  if (
    figures.length === 0 &&
    quantities.length === 0 &&
    links.length === 0 &&
    origins.length === 0 &&
    contacts.length === 0 &&
    addresses.length === 0 &&
    toolClaims.length === 0 &&
    toolDisclosure.length === 0 &&
    toolCounts.length === 0 &&
    toolArgs.length === 0 &&
    citations.length === 0 &&
    quotes.length === 0 &&
    attributions.length === 0
  ) {
    // Deliberately unconditional on `coverage`. A gap in what was checked is
    // not a fault in the answer, and a badge that appeared on its own to say
    // "0 of 2 measurements were compared against anything" would land under
    // every reply that mentions twenty minutes. That turn is the `unverified`
    // badge's business — `needsVerification` covers the reference domains,
    // including the leaking faucet — and this line's job is to stop an existing
    // badge from implying a completeness it does not have.
    return null
  }

  const used = [...new Set([...numericRecords, ...sourceRecords].map((r) => r.name))].sort()
  // Naming the failed calls matters most on exactly the turns this arms: the
  // disclosure would otherwise read "nothing ran this turn" when a search did
  // run and came back empty-handed.
  const failed = [...new Set(failedSources.map((r) => `${r.name} (errored)`))].sort()
  // …and when every check that ran is one the app already reported as verifying
  // nothing, say that rather than "nothing ran": something did run, it just
  // settled nothing, and "no tool output" would be its own small lie.
  const checkedAgainst =
    used.length + failed.length > 0
      ? [...used, ...failed]
      : records.some(verifiedNothing)
        ? ['nothing — the only checks that ran verified nothing']
        : ['no tool output — nothing ran this turn']

  return {
    figures: figures.slice(0, MAX_REPORTED),
    links: links.slice(0, MAX_REPORTED),
    ...(quantities.length > 0 ? { quantities: quantities.slice(0, MAX_REPORTED) } : {}),
    ...(origins.length > 0 ? { origins: origins.slice(0, MAX_REPORTED) } : {}),
    ...(contacts.length > 0 ? { contacts: contacts.slice(0, MAX_REPORTED) } : {}),
    ...(addresses.length > 0 ? { addresses: addresses.slice(0, MAX_REPORTED) } : {}),
    ...(toolClaims.length > 0 ? { toolClaims: toolClaims.slice(0, MAX_REPORTED) } : {}),
    ...(toolDisclosure.length > 0
      ? { toolDisclosure: toolDisclosure.slice(0, MAX_REPORTED) }
      : {}),
    ...(toolCounts.length > 0 ? { toolCounts: toolCounts.slice(0, MAX_REPORTED) } : {}),
    ...(toolArgs.length > 0 ? { toolArgs: toolArgs.slice(0, MAX_REPORTED) } : {}),
    ...(citations.length > 0 ? { citations: citations.slice(0, MAX_REPORTED) } : {}),
    ...(quotes.length > 0 ? { quotes: quotes.slice(0, MAX_REPORTED) } : {}),
    ...(attributions.length > 0 ? { attributions: attributions.slice(0, MAX_REPORTED) } : {}),
    // The two counts are of DISTINCT measurements and are not capped, because
    // "N of M" is arithmetic the reader reproduces by looking at the reply.
    // Only the naming is capped, and `describeCoverage` says how many it left
    // out rather than quietly showing fewer.
    //
    // The findable corpus is every tool's output plus the user's own words —
    // wider than what ARMS the rung, and deliberately so: this asks only
    // "could the reader find this number", and a wider corpus can therefore
    // only ever suppress the line, never produce one.
    ...(coverageWorthSaying(coverage.unchecked, `${outputOf(records, () => true, true)}\n${userText}`)
      ? {
          coverage: {
            checked: coverage.checked.length,
            unchecked: coverage.unchecked.length,
            uncheckedNamed: coverage.unchecked.slice(0, MAX_REPORTED)
          }
        }
      : {}),
    // v2.2, and the mirror of the line above: not what the rung skipped but
    // where what it checked was found. Passages only — a marker is what the
    // reader can open — and it rides an existing badge exactly as `coverage`
    // does, for the same reason: a permanent provenance line under every reply
    // that mentions a duration is round 4's cry-wolf in a quieter ink.
    ...(matched.length > 0 ? { matched: matched.slice(0, MAX_REPORTED) } : {}),
    checkedAgainst
  }
}
