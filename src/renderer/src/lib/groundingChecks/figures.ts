// Split out of lib/toolGrounding.ts (v2.4): the "figures" section. Behaviour-neutral —
// every declaration is the one that lived there, moved. lib/toolGrounding.ts re-exports
// all of them, so callers and tests are unchanged.

import {
  convertUnit,
  isRatioScale,
  measurementGroup,
  measurementsIn,
  unreadableQuantitiesIn,
  type Measurement
} from '../../../../shared/measurements'



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

export /**
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

export /** Every number in a blob of text, as numeric values. */
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

export /** Decimal places written in the source text, so rounding is judged at its precision. */
function precisionOf(raw: string): number {
  const dot = raw.indexOf('.')
  return dot === -1 ? 0 : raw.length - dot - 1
}

export function roundTo(value: number, decimals: number): number {
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
  /**
   * v2.5: distinct quantity-shaped spans that are in **none** of the three
   * above, because the unit vocabulary cannot read them.
   *
   * `checked + unchecked` is every measurement the walk saw; this is what the
   * walk could not see, and it is here so that a caller reporting the first
   * two cannot describe them as the reply. It arms nothing, supports nothing
   * and can never become a finding — it is only ever disclosure, which is the
   * reason a scan this loose is safe at all. See `unreadableQuantitiesIn`.
   */
  unread: string[]
}

/** The findings only, which is what every caller before v2.1 wanted. */
export function unsourcedQuantities(answer: string, toolOutput: string, userText = ''): string[] {
  return quantityCoverage(answer, toolOutput, userText).flagged
}

export /**
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
  // v2.5. Deliberately outside the loop and deliberately over `answer` alone:
  // this is not a fourth verdict on a measurement, it is the answer to "what
  // did that loop never get to look at". Distinct by the span as written, like
  // every bucket above it, for the same reason — a count the reader cannot
  // reproduce from the screen is the defect round 4 recorded.
  const unread: string[] = []
  const seenUnread = new Set<string>()
  for (const q of unreadableQuantitiesIn(answer)) record(unread, seenUnread, q.raw)
  return { checked, unchecked, flagged, unread }
}

export /**
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

export function agreesAfterConversion(
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
