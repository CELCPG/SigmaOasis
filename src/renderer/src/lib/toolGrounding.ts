import type { ToolCallRecord } from '../types'
import { measurementsIn } from '../../../shared/measurements'
import { TOOL_DEFS } from '../../../shared/tools'
import { LAUNDERED_OUTPUT_MARKER } from './workbenchChecks'
import { danglingCitations, retrievedCitations } from './citations'

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
  /** v1.6: the reply's Python failed when run in the sandbox (finding lines). */
  code?: string[]
  /**
   * v1.13: bracketed markers — "[3]" — naming a passage the library lookup
   * never returned. A citation index is a claim of the same kind as a figure
   * or a link, and until now it was the one kind nothing checked.
   */
  citations?: string[]
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
    (report.code?.length ?? 0) +
    (report.citations?.length ?? 0)
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

export function describeGroundingFindings(report: GroundingReport): string {
  const lines: string[] = []
  if (report.code?.length) lines.push(...report.code)
  if (report.toolClaims?.length) {
    lines.push(
      `- Your answer says you used ${report.toolClaims.join(', ')}; no such call ran this turn. ` +
        'Either make the call, or say what you actually did instead.'
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
    'A mechanical check compared your answer against what the tools actually returned this ' +
    `turn (${report.checkedAgainst.join(', ')}). It found specifics nothing supports:\n\n` +
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
  const flagged: string[] = []
  const seen = new Set<string>()
  for (const m of measurementsIn(answer)) {
    if (!armed.has(m.unit)) continue
    const known = byUnit.get(m.unit)
    if (!known || known.length === 0) continue
    const decimals = precisionOf(String(m.value))
    if (known.some((k) => roundTo(k, decimals) === m.value)) continue
    if (isDerivable(m.value, decimals, known.slice(0, MAX_DERIVATION_BASES))) continue
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
 * Contact details the reply states that appear in no tool output and in
 * nothing the user said.
 *
 * Unlike links this is not gated on a source tool having run. A link with no
 * search behind it is often just the model recalling a homepage, but a support
 * line quoted to a customer is a specific, dialable claim, and there is no
 * version of inventing one that is acceptable.
 */
export function unsourcedContacts(answer: string, corpus: string): string[] {
  const known = new Set(
    [...(corpus.match(PHONE) ?? []), ...(corpus.match(EMAIL) ?? [])].map(normalizeContact)
  )
  const flagged: string[] = []
  const seen = new Set<string>()
  for (const raw of [...(answer.match(PHONE) ?? []), ...(answer.match(EMAIL) ?? [])]) {
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
  const checkFigures =
    numericRecords.length > 0 ||
    verifiedNothingNumeric ||
    options.expectPricingTool === true ||
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
  // Ungated by design — `danglingCitations` only speaks when passages were
  // actually retrieved, which is the only situation in which a bracketed
  // number is a claim about them.
  const citations = danglingCitations(answer, retrievedCitations(records))

  if (
    figures.length === 0 &&
    quantities.length === 0 &&
    links.length === 0 &&
    origins.length === 0 &&
    contacts.length === 0 &&
    addresses.length === 0 &&
    toolClaims.length === 0 &&
    citations.length === 0
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
    ...(citations.length > 0 ? { citations: citations.slice(0, MAX_REPORTED) } : {}),
    checkedAgainst
  }
}
