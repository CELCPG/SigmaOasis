// Split out of lib/toolGrounding.ts (v2.4): the "report" section. Behaviour-neutral —
// every declaration is the one that lived there, moved. lib/toolGrounding.ts re-exports
// all of them, so callers and tests are unchanged.

import { MeasurementSource } from './measurementSources'



export /**
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

export /**
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

export /** Tools whose output is the authoritative source for links in a reply. */
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

export /** Beyond this many findings the badge stops enumerating and just counts. */
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
  /**
   * v2.3: the same account read the other way — a tool that DID run which the
   * reply says did not, or whose finished work it offers to begin. See
   * `contradictedToolAccounts` for why this direction is the worse one.
   */
  toolDenials?: string[]
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
  /**
   * v2.5: the same account read one rung further in — not what the call was
   * sent but what it brought back. Which pack, how many passages, what
   * relevance. See `misdescribedRetrieval`.
   */
  toolRetrieval?: string[]
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
  /**
   * v2.4: how many findings the banner's three counted categories actually had,
   * where the arrays above name fewer.
   *
   * Every array in this report is capped at `MAX_REPORTED`, and the banner
   * derives its count from the array — so a reply with nine unbacked prices
   * shipped `⚠️ 6 figures ($1, $2, $3, $4, $5, $6) in this reply are not backed
   * by the tool output.` A reader has no way to see the cap: six named, six
   * counted, and three more of exactly the same kind left unsaid. The count
   * reads as a census and is a ceiling.
   *
   * The sibling line on the same screen has always got this right — `Not
   * compared against anything: 700 gallons per month, 60 seconds/min, 60
   * min/hr, 24 hr/day **and 2 more**` — because `coverage` carries its totals
   * uncapped and caps only `uncheckedNamed`. This is that shape, for the
   * categories `describeUnbackedItems` speaks about. Present only when
   * something really was dropped, so a report that names every finding cannot
   * claim a truncation it did not make.
   *
   * Naming is what is capped; the count is not. Raising `MAX_REPORTED` instead
   * would have moved the silence one figure along and left the same reader with
   * the same unreadable ceiling.
   */
  found?: { figures?: number; links?: number; quantities?: number }
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
  /**
   * v2.5: quantity-shaped spans the measurement vocabulary cannot read, and
   * which are therefore in neither number above.
   *
   * A floor and never a census — see `unreadableQuantitiesIn`. That is why
   * `describeCoverage` names these and never counts them as a total of what
   * the reply contains: the sentence being repaired is exactly the one that
   * mistook a scan for a reply.
   */
  unread?: number
  /** The first few of those, in the order the reply states them. */
  unreadNamed?: string[]
}

export /**
 * Below this many money figures, a reply is mentioning a number, not building a
 * pricing table out of thin air. The distinction is what lets the figure check
 * run on turns where no pricing tool fired without commenting on every passing
 * "about $20" in ordinary conversation.
 */
const MIN_UNPROMPTED_FIGURES = 2
