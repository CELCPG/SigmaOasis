import type { ToolCallRecord } from '../types'
import { inScale, measurementsIn, temperatureScale } from '../../../shared/measurements'
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
  /** Tools whose output was used as the corpus, for the disclosure text. */
  checkedAgainst: string[]
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
 * spans thirteen categories; a line that says "3 unsupported items" and then
 * names two is worse than one that names none, so this walks the same thirteen
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
 */
const CURRENCY = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g

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
  const known = numbersIn(corpus)
  const bases = [...new Set(moneyIn(corpus))].slice(0, MAX_DERIVATION_BASES)
  // v1.11.2: a figure that appears verbatim in a page or search result the
  // model was handed is SOURCED, not invented — that is the whole point of the
  // source. Presence only, never derivation: a fetched page full of numbers
  // must not become a derivation base that certifies arbitrary arithmetic.
  const inSources = numbersIn(sourceText)
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
 */
export function unsourcedQuantities(answer: string, toolOutput: string, userText = ''): string[] {
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
  const armed = new Set(measurementsIn(toolOutput).map((m) => m.unit))
  const byUnit = new Map<string, number[]>()
  for (const m of [...measurementsIn(toolOutput), ...measurementsIn(userText)]) {
    const list = byUnit.get(m.unit)
    if (list) list.push(m.value)
    else byUnit.set(m.unit, [m.value])
  }
  // v1.15: one dimension, two scales. A corpus that states any temperature
  // arms BOTH — see temperatureScale for the measured turn where it did not,
  // and half an invented "165°F / 74°C" went unnamed because the passages
  // happened to be written in Fahrenheit. Support crosses the scales, never
  // the dimensions: a reply restating a retrieved 165 °F as 74 °C has quoted
  // its source and must stay clean, while 74 °C over a corpus whose only
  // temperature is a fridge's 40 °F is the invention this rung exists for.
  const corpusTemps: { value: number; scale: 'c' | 'f' }[] = []
  for (const [unit, values] of byUnit) {
    const scale = temperatureScale(unit)
    if (scale) for (const value of values) corpusTemps.push({ value, scale })
  }
  const armedTemperature = [...armed].some((u) => temperatureScale(u) !== null)
  const flagged: string[] = []
  const seen = new Set<string>()
  for (const m of measurementsIn(answer)) {
    const scale = temperatureScale(m.unit)
    if (!armed.has(m.unit) && !(scale && armedTemperature)) continue
    const known = scale
      ? corpusTemps.map((t) => inScale(t.value, t.scale, scale))
      : byUnit.get(m.unit)
    if (!known || known.length === 0) continue
    const decimals = precisionOf(String(m.value))
    if (known.some((k) => roundTo(k, decimals) === m.value)) continue
    // Temperatures are not derivable. Multiplying one by a pack size is
    // meaningless — a fridge held at 40 °F does not license 80 °F, and the
    // integer-multiple rule that keeps per-case pricing quiet was certifying
    // exactly that. It also keeps the conversion above honest: a converted
    // value is a fraction, and fractions multiply into almost anything.
    if (!scale && isDerivable(m.value, decimals, known.slice(0, MAX_DERIVATION_BASES))) continue
    if (seen.has(m.raw)) continue
    seen.add(m.raw)
    flagged.push(m.raw)
  }
  return flagged
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

const QUOTED_SPANS = [
  /"([^"\n]{25,400})"/g,
  /“([^”\n]{25,400})”/g,
  /^[ \t]{0,3}>[ \t]?(.{25,400})$/gm
]

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

/** Every span the reply offers as a direct quotation, in the order it wrote them. */
function quotedSpans(answer: string): string[] {
  const prose = stripMarkdown(answer.replace(FENCED, ' ').replace(INLINE_CODE, ' '))
  const out: string[] = []
  for (const pattern of QUOTED_SPANS) {
    for (const m of prose.matchAll(pattern)) {
      const span = m[1].trim()
      if (flattenQuote(span).length >= MIN_QUOTED) out.push(span)
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
export function misstatedArgumentsIn(
  answer: string,
  records: ToolCallRecord[]
): MisstatedArgument[] {
  const inScope = records.filter((r) => ARGUMENT_TOOLS.has(r.name))
  if (inScope.length === 0) return []
  const ranNames = [...new Set(inScope.map((r) => r.name))]
  const heading = DISCLOSURE_HEADING.exec(answer)
  const disclosureFrom = heading ? heading.index + heading[0].length : -1
  const flagged: MisstatedArgument[] = []
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
      if (argumentMatches(stated, passed)) continue
      const key = `${param}|${flattenQuote(stated)}`
      if (seen.has(key)) continue
      seen.add(key)
      flagged.push({ param, stated, passed })
    }
  }
  return flagged
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
  /\((?:(?:sources?|from|per|see|via|ref|citing|cited in)[ \t]*:?[ \t]*)?\[(\d{1,3})\][ \t]+([^)\n]{2,60})\)/gi
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
  const quantities =
    numericRecords.length > 0 || retrievedCorpus.trim() !== ''
      ? // The user-text corpus doubles as the passive-support corpus (see the
        // comment in unsourcedQuantities); source-tool text joins it for the
        // same reason it supports figures: a measurement read off a fetched
        // page is sourced, not a disagreement with the app's arithmetic.
        unsourcedQuantities(
          answer,
          `${computedCorpus}\n${retrievedCorpus}`,
          `${userText}\n${sourceCorpus}`
        )
      : []

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
  // And the rung past both: the call it names did run, its account of the call
  // is complete, and the argument it quotes is not the one the call carried.
  // Ungated for the same reason as the two above — the records are the whole
  // corpus, so there is never a turn where this cannot be checked.
  const misstatedArgs = misstatedArgumentsIn(answer, records)
  const toolArgs = misstatedArgs.map(describeMisstatedArgument)
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
    return !misstatedArgs.some((arg) => {
      const stated = bare(arg.stated)
      return stated.includes(flat) || flat.includes(stated)
    })
  })
  const attributions = misattributedCitations(answer, retrieved)

  if (
    figures.length === 0 &&
    quantities.length === 0 &&
    links.length === 0 &&
    origins.length === 0 &&
    contacts.length === 0 &&
    addresses.length === 0 &&
    toolClaims.length === 0 &&
    toolDisclosure.length === 0 &&
    toolArgs.length === 0 &&
    citations.length === 0 &&
    quotes.length === 0 &&
    attributions.length === 0
  ) {
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
    ...(toolArgs.length > 0 ? { toolArgs: toolArgs.slice(0, MAX_REPORTED) } : {}),
    ...(citations.length > 0 ? { citations: citations.slice(0, MAX_REPORTED) } : {}),
    ...(quotes.length > 0 ? { quotes: quotes.slice(0, MAX_REPORTED) } : {}),
    ...(attributions.length > 0 ? { attributions: attributions.slice(0, MAX_REPORTED) } : {}),
    checkedAgainst
  }
}
