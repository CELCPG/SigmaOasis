/**
 * What counts as a measurement, shared by both rungs that check one.
 *
 * A quantity with a unit is the dangerous class of number. A wrong price is
 * embarrassing; a wrong dose, distance, duration or temperature is the kind of
 * thing this app exists to not do — and it is exactly the class a model will
 * state most confidently, because a unit makes any number sound measured.
 *
 * This lives in `shared/` because two separate checks need the same answer to
 * "is this a measurement?": `researchGrounding` vetting a brief against the
 * passages it was written from, and `toolGrounding` vetting a reply against
 * what the tools returned. Two copies would drift, and the drift would be
 * silent — one rung quietly stops recognising a unit the other still checks.
 *
 * v2.1: there were **three**. `answerEval.ts` — the library suite's scorer, the
 * one place that has scored "stated a measurement the passages do not support"
 * since v1.6 — carried its own hand-rolled alternation, and the drift this file
 * warns about had already happened in silence. That copy did not know about
 * `mcg`, `µg`, `mph`, `km/h`, `kwh`, `watt`, `volt`, `amp`, `calorie` or
 * `kcal`; it matched across a line break, so a number ending one line and a
 * word beginning the next became a measurement; and it had no rate suffix, so
 * `8.66 minutes per mile` scored as a duration. It also carried one unit this
 * file does not — see `percent` below, which is why the reconciliation is an
 * option rather than a deletion.
 */

/**
 * Horizontal space, and never a line break.
 *
 * `[ \t]` was the whole of this until v2.4, and it is the wrong half of the
 * rule. The reason a line break must not be crossed is that a number ending one
 * line and a word beginning the next are two claims, not one — nothing to do
 * with which *horizontal* space separates a number from its unit. A
 * no-break space is the one a typesetter, a markdown renderer and a model
 * writing `165 °F` all reach for precisely because the unit must stay with its
 * number, and `[ \t]` read it as a separator and returned no measurement at
 * all. The corpus then armed nothing, and a figure stated on the page was
 * reported as never compared.
 *
 * U+00A0 no-break, U+202F narrow no-break, U+2009 thin. `\s` would have been
 * shorter and would have swallowed `\n`, which is the bug this class exists to
 * keep out.
 */
const H = '[ \\t\\u00a0\\u202f\\u2009]'

/**
 * The units themselves, as alternation source. Deliberately finite: time,
 * distance, mass, volume, temperature, speed and energy — the things that are
 * measured. Not currency (money has its own check, with its own rules about
 * derivation) and not bare counts, which are usually a list length rather than
 * a claim about the world.
 *
 * v2.4: the degree family reads its **scale**, wherever the scale is spelled
 * out. `°\s?[cf]` recognised `165°F` and `165° F` and stopped there, so
 * `165 degrees F` matched the bare `degrees?` branch and arrived as a
 * temperature whose scale had been thrown away. Measured on the pack this app
 * ships: `packs/food-safety/` writes one temperature four ways — `165°F` (9
 * times), `165 degrees F` (5), `165° F` (4) and `165oF` (2) — and the second
 * of those armed nothing and supported nothing. See `canonicalTemperature`
 * for what that cost, in both directions.
 *
 * The bare `degrees?` branch stays, and stays last: a scale that is genuinely
 * unstated is still not a temperature this file will convert. Alternation is
 * leftmost-wins, so `degrees F` is claimed by the branch that can see the `F`
 * and `90 degrees clockwise` falls through to the bare one exactly as before —
 * `[cf]\b` cannot match the `c` of a longer word.
 */
export const MEASUREMENT_UNITS =
  `(?:°|degrees?)${H}*(?:celsius\\b|centigrade\\b|fahrenheit\\b|[cf]\\b)|degrees?\\b|` +
  'minutes?\\b|mins?\\b|hours?\\b|hrs?\\b|days?\\b|weeks?\\b|months?\\b|years?\\b|' +
  'seconds?\\b|secs?\\b|' +
  'mg\\b|mcg\\b|µg\\b|ml\\b|grams?\\b|g\\b|kg\\b|litres?\\b|liters?\\b|l\\b|gallons?\\b|' +
  'ounces?\\b|oz\\b|pounds?\\b|lbs?\\b|' +
  'cm\\b|mm\\b|metres?\\b|meters?\\b|m\\b|inches?\\b|feet\\b|ft\\b|miles?\\b|km\\b|' +
  'mph\\b|km\\/h\\b|kwh\\b|watts?\\b|volts?\\b|amps?\\b|calories\\b|kcal\\b'

/**
 * What a caller may ask for beyond the units above.
 *
 * Exactly one thing, and it is a divergence recorded rather than removed. The
 * library eval scorer counts a percentage as a measurement; every rung that
 * ships deliberately does not, because `unsourcedPercentages` already checks
 * them with a better rule (a percentage is supported by the *ratio* of two
 * corpus numbers, not only by its own presence) and a `%` in this alternation
 * would produce two findings for one claim. Worse, it would change what
 * `amountsIn` treats as money support, since that function drops every number a
 * unit has already claimed.
 *
 * So the vocabulary is single-sourced and the one difference is a named flag
 * instead of a second regex nobody diffs.
 */
export interface MeasurementOptions {
  /** Count `25%` as a measurement. Eval scoring only — no shipped rung sets it. */
  percent?: boolean
}

/**
 * A fresh matcher for "number followed by a unit".
 *
 * Returned rather than exported as a constant because a `/g` regex carries
 * `lastIndex`, and a module-level one shared between two checks in the same
 * turn is a bug waiting for the day someone reaches for `.test()`.
 *
 * Group 1 is the number, group 2 the unit, group 3 the rate suffix if there is
 * one. The suffix matters: "8.66 minutes per mile" is not a duration, and a
 * check that treats it as one will compare a pace against a running time and
 * report a disagreement between two things that were never the same quantity.
 */
export function measurementPattern(options: MeasurementOptions = {}): RegExp {
  const units = options.percent ? `${MEASUREMENT_UNITS}|%` : MEASUREMENT_UNITS
  // Horizontal space only, never a line break — see `H`. A number ending one
  // line and a word beginning the next are not a measurement: tool output
  // reading "Total time: 3:47\nMiles run: 26.2" would otherwise yield
  // "47 Miles" and put a distance into the corpus that nothing ever computed.
  // Caught by test, and the same trap the address check documents.
  return new RegExp(
    `(?<![\\w.])(\\d[\\d,]*(?:\\.\\d+)?)${H}*(${units})(${H}*(?:per|/)${H}*[a-z]+\\b)?`,
    'gi'
  )
}

/** One measurement found in text: its value, and the kind of thing it measures. */
export interface Measurement {
  value: number
  /** Lower-cased, singularised, rate suffix included: `mile`, `minute per mile`. */
  unit: string
  /** Exactly as written, for reporting. */
  raw: string
  /**
   * Offset of the *number* in the source text — the pattern opens with it, so
   * this is the match index.
   *
   * v1.17.2. It exists so another check can ask the inverse question: which of
   * the bare numbers in this text are already spoken for by a unit. The money
   * rung needs that (see `amountsIn` in toolGrounding) because a count with a
   * unit is a measurement, and a measurement is not an amount of money.
   */
  index: number
}

/** Case, plurals and runs of any whitespace folded away. */
function collapse(unit: string): string {
  return unit.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * The one unit in this vocabulary that a corpus writes four different ways.
 *
 * v2.4, and it is the fix for a false `unverified` on a poultry cooking
 * temperature — the most damaging shape this app ships, and the second time it
 * has been recorded. `°f` and `° f` were two keys, `degrees f` was a third and
 * carried no scale at all, and every comparison in `toolGrounding` keys off the
 * unit *string*: `armed.has(m.unit)`, `c.unit === m.unit`,
 * `found.unit === stated.unit`. So how the passage happened to space its degree
 * sign decided whether a figure was backed.
 *
 * Measured against the shipped pack, corpus = `refrigerator-thermometers.md` +
 * `safe-temperature-chart.md`, a reply stating the poultry temperature and the
 * fridge temperature:
 *
 * ```
 * before   ⚠️ 1 measurement (165°F) in this reply is not backed by the tool output.
 * after    (no finding)
 * ```
 *
 * The chart states `165 degrees F` on five lines. `40 °F` and `40° F` from the
 * fridge doc armed the temperature dimension, so the rung ran; `165 degrees F`
 * parsed as a dimensionless `degree` and put nothing into the temperature
 * corpus, so the only value it could compare 165 against was 40. Every
 * spelling of the answer that used a degree sign flagged, and the one that
 * spelled `degrees` out did not — the reader's choice of arm was a coin toss
 * on a space.
 *
 * **And the same fold is a tightening, which is why it is safe.** Dropping the
 * scale letter made `degrees f` and `degrees c` the *same* key, so a reply's
 * `165 degrees C` was certified by a passage's `165 degrees F` — a temperature
 * off by 130 °F, silently backed. `165 °C` was flagged and `165 degrees C` was
 * not. Both are findings now. The loosening and the tightening are one line of
 * code because they were one defect: the unit was never read.
 *
 * Bare `degrees` is deliberately still nothing — a temperature whose scale is
 * unstated cannot be converted, and `90 degrees clockwise` is not a
 * temperature at all. This function returns null for it, and the caller keeps
 * the pre-v2.4 behaviour: armed by its own spelling, supported by its own
 * spelling, nothing crossed.
 *
 * Not folded, deliberately: `165oF`, the OCR artefact in
 * `packs/food-safety/docs/safe-food-handling.md` where a letter `o` stands in
 * for the degree sign. Reading `o` as `°` would make the `5 of` in "5 of the 10
 * rows" a temperature, and a silent false positive over prose is a worse trade
 * than eight unarmed values in one document. Recorded in docs/evals.md.
 */
export function canonicalTemperature(unit: string): '°c' | '°f' | null {
  const m = /^(?:°|degrees?) ?(celsius|centigrade|fahrenheit|c|f)$/.exec(collapse(unit))
  return m ? (m[1].startsWith('c') ? '°c' : '°f') : null
}

/**
 * Canonical name for a unit as written, so `miles`, `Mile` and `mi` are one
 * kind of thing and `minutes per mile` is a different kind from `minutes`.
 * Deliberately shallow: it folds case, plurals, spacing and the degree family's
 * spellings, and does NOT convert between units — a check that silently equated
 * kilometres and miles would hide exactly the disagreement it is looking for.
 * °C and °F stay two different names here; that they are one dimension is the
 * business of `UNITS`, below, where the conversion is exact and stated.
 */
export function normaliseUnit(unit: string, suffix?: string): string {
  const written = collapse(unit)
  const base = canonicalTemperature(written) ?? written.replace(/s$/, '')
  const rate = (suffix ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/^\//, 'per ')
  return rate ? `${base} ${rate.replace(/s$/, '')}` : base
}

/**
 * The scale a temperature unit names, or null when it measures something else.
 *
 * v1.15. Temperature is the one quantity here that is routinely written in two
 * scales in the same breath, and treating those scales as two unrelated units
 * is how a whole invented claim went unnamed. Measured (task V1, run-1): the
 * reply stated "165°F / 74°C" over passages containing neither string. Only
 * the Fahrenheit half was reported, and only because one passage happens to
 * mention "40 °F" about a refrigerator; nothing in them is written in Celsius,
 * so `°c` was never armed and the Celsius half of the same sentence was
 * skipped in silence.
 *
 * `° F` as well as `°F`: the matcher permits a space, and a unit that survives
 * one renderer's spacing must not become a different kind of thing.
 */
export function temperatureScale(unit: string): 'c' | 'f' | null {
  // v2.4: one parser for the degree family, not a second copy of its spellings.
  // This function was that second copy — it knew `°F` and `° F` and not
  // `degrees F`, which is the drift the header of this file warns about,
  // happening inside the file itself.
  const canonical = canonicalTemperature(unit)
  return canonical ? (canonical[1] as 'c' | 'f') : null
}

/**
 * The same temperature on the other scale.
 *
 * Exact arithmetic, no tolerance of its own — the caller rounds to whatever
 * precision the text it is checking was written at. This is the ONE conversion
 * this file performs, and it is safe where converting miles to kilometres
 * would not be: F and C are the same physical quantity written two ways, so a
 * reply restating a retrieved 165 °F as 74 °C has quoted its source, not
 * disagreed with it.
 */
export function inScale(value: number, from: 'c' | 'f', to: 'c' | 'f'): number {
  if (from === to) return value
  return to === 'c' ? ((value - 32) * 5) / 9 : (value * 9) / 5 + 32
}

/** Every measurement in a body of text. */
export function measurementsIn(text: string, options: MeasurementOptions = {}): Measurement[] {
  const out: Measurement[] = []
  for (const m of text.matchAll(measurementPattern(options))) {
    const value = Number(m[1].replace(/,/g, ''))
    if (!Number.isFinite(value)) continue
    out.push({
      value,
      unit: normaliseUnit(m[2], m[3]),
      raw: m[0].trim().replace(/\s+/g, ' '),
      index: m.index ?? 0
    })
  }
  return out
}

// ---- what the vocabulary cannot read (v2.2) ----------------------------------

/**
 * A quantity written as a **rate**, whose unit is not one this file knows.
 *
 * v2.5, and it is the inverse of everything above it. `MEASUREMENT_UNITS` is a
 * list of what is known-good, deliberately finite and deliberately closed. Its
 * complement — every quantity a reply states that this vocabulary is silent
 * about — was not a set anything could name, so a caller counting measurements
 * had no way to say "and there were others I cannot read". It reported its own
 * scan and called it the reply.
 *
 * Measured, round 12, task V3 (`verdicts/round-12.json`): a reply about a
 * dripping faucet states `1,450 gallons`, `2.2 gallons per drop`, `30 days`,
 * `60 minutes` — and `~876 drops per day`. Four of those five are in the
 * vocabulary. The near-miss is the whole lesson: `2.2 gallons per drop` is
 * recognised because `gallon` is a known unit, `876 drops per day` is not
 * because `drop` is not, and the reply's own arithmetic chains the two
 * together. A line reading "the 4 measurements in this reply" was a claim
 * about the reply made from a scan narrower than the reply.
 *
 * **Why a rate and not any noun.** The obvious widening is "a number followed
 * by a word" — a quantity is a value and a dimension, and `drops` is a
 * dimension. Measured over the documents this app actually ships (every
 * `packs/**\/*.md`, minus what the unit vocabulary already reads), that scan
 * returns **578 spans, 293 distinct**, and the top of the list is `3 to`,
 * `1 to`, `72, index`, `529 plans`, `111 if`, `2025, the`, `2 diabetes`,
 * `31 March`. Ranges, phone numbers, IRS form names, dates, disease
 * classifications — and over this repo's own prose, `4 steps`,
 * `1 measurement`, `3 lookups`: the app's own chrome. There is no noun list that
 * separates `529 plans` from `876 drops`; they are the same shape, and every
 * exclusion written for the ones seen so far is the enumeration this codebase
 * has recorded being defeated twice (`carriesAQuotation`, `ARGUMENT_PARAMS` in
 * toolGrounding.ts).
 *
 * The rate is the discriminator, and it is not a list — it is the sentence's
 * own syntax. `X per Y` and `X/Y` are how English writes a dimension out loud;
 * a phone number, a date, a form name and a list length cannot wear one. The
 * same scan restricted to rates returns **27 spans, 15 distinct** over those
 * same packs, and every one of them is a real measurement this file cannot
 * read: `4 pCi/L` and `50 Bq/m` (radon), `5 parts per million` (carbon
 * monoxide), `500 milligrams per liter` (disinfection),
 * `40,000 cases per year`, `3 colds per year`, `1 quart/liter`. 578 down to
 * 27, with zero identifiers, zero dates, zero list lengths, zero chrome.
 *
 * **So this is a floor, never a census.** `876 drops` written without its rate
 * is missed here, and that is the direction this project has settled on twice:
 * a miss costs a disclosure, a false name on a warning banner costs the badge
 * itself (round 4). A caller must therefore never phrase what this returns as
 * "the quantities in the reply" — that is the very sentence being repaired.
 *
 * Three shape rules, each one about the writing rather than about the word:
 *
 * - The digit group **ends in a digit**, so `72, index` is not a quantity
 *   called `index`. Exactly the fix `CURRENCY` records for `$30,000,`.
 * - A **space** stands between the number and the word, because without one
 *   there is no second word: `1st`, `3pm`, `2x` and `1080p` are one token, and
 *   a scan that splits tokens invents the dimension it then reports.
 * - `per` is a **word** and `/` is **tight**. Greedy backtracking otherwise
 *   reads `10023 Upper West` as *10023 "Up" per "West"* — measured, on this
 *   repo's own address fixture — and ` /` picks up file paths.
 */
function rateQuantityPattern(): RegExp {
  // Fresh each call, for the reason `measurementPattern` states: a module-level
  // `/g` regex carries `lastIndex` into whatever reaches for it next.
  return new RegExp(
    `(?<![\\w.])(\\d(?:[\\d,]*\\d)?(?:\\.\\d+)?)${H}+[a-z]+(?:${H}+per${H}+[a-z]+|/[a-z]+)\\b`,
    'gi'
  )
}

/** A quantity-shaped span with no unit this file can read. */
export interface UnreadQuantity {
  /** Exactly as written, for reporting — the only thing a caller may do with it. */
  raw: string
  /** Offset of the number, so a caller can tell it from a span it did read. */
  index: number
}

/**
 * Every rate in `text` that `measurementsIn` did not already claim.
 *
 * The subtraction is by **offset**, which is what makes this the inverse of the
 * vocabulary rather than a second opinion about it: `2.2 gallons per drop` is
 * read by `measurementsIn`, so it is not here; `876 drops per day` is not, so
 * it is. Whatever the unit list learns tomorrow, this shrinks to match without
 * being edited, and the two can never both claim the same span.
 *
 * Currency is dropped for the reason the header of this file gives for keeping
 * it out of `MEASUREMENT_UNITS`: money has its own check with its own rules,
 * and `$15 per month` reported here would be one claim counted by two rungs.
 * By glyph rather than by word, because `pounds` is already a mass.
 */
export function unreadableQuantitiesIn(text: string): UnreadQuantity[] {
  // `H` and not `\s`, for the reason `H` exists: a `$` ending one line does not
  // price a number beginning the next.
  const priced = new RegExp(`[$£€¥]${H}?$`)
  const read = new Set(measurementsIn(text).map((m) => m.index))
  const out: UnreadQuantity[] = []
  for (const m of text.matchAll(rateQuantityPattern())) {
    const index = m.index ?? 0
    if (read.has(index)) continue
    if (priced.test(text.slice(Math.max(0, index - 2), index))) continue
    out.push({ raw: m[0].trim().replace(/\s+/g, ' '), index })
  }
  return out
}

// ---- dimensions (v1.17.2) ----------------------------------------------------

/**
 * The physical quantity a unit measures, as opposed to the string it is
 * written with.
 *
 * v1.15 made temperature "one dimension in two scales" because arming per
 * normalised unit string let half an invented `165°F / 74°C` go unnamed: the
 * passages were written in Fahrenheit, so `°c` was never armed. That repair
 * was correct and it was also **an instance**. Every other quantity here has
 * the same shape and did not get it — a corpus stating gallons armed nothing
 * about litres, a corpus stating days armed nothing about hours — so a reply
 * was free to restate a retrieved volume in the other unit, right or wrong,
 * and no rung looked at it.
 *
 * The generalisation is the point: a check that enumerates the unit strings it
 * has seen is defeated by the one the model happened to write. A dimension is
 * the class; the unit is the spelling.
 */
export type Dimension = 'temperature' | 'duration' | 'length' | 'mass' | 'volume'

/**
 * How a unit maps onto its dimension's canonical unit, as an affine map:
 * `canonical = value × factor + offset`.
 *
 * Affine rather than a bare factor so temperature is not a special case bolted
 * onto the side. °C and °F are the same dimension as each other with different
 * zeros, and writing that as an offset means one conversion path serves every
 * dimension — which is what stops the two paths drifting apart the way two
 * copies of `measurementsIn` would.
 */
interface UnitSpec {
  dimension: Dimension
  factor: number
  offset: number
}

/**
 * Whether a dimension has a true zero, so a value may be multiplied.
 *
 * v1.15 wrote this as "temperatures are not derivable", which is true and is
 * the instance. The reason is that °C/°F is an **interval** scale: 80 °F is
 * not twice 40 °F, so the integer-multiple rule that keeps per-case pricing
 * quiet was certifying an invented temperature from a fridge's. Every other
 * dimension here is a ratio scale, where two of something genuinely is twice
 * one of it, and multiplying is the derivation a pack size performs.
 */
const INTERVAL_SCALES: ReadonlySet<Dimension> = new Set<Dimension>(['temperature'])

/**
 * Units with an **exact and unambiguous** conversion to their dimension's
 * canonical unit. That qualification is the whole of the safety argument, and
 * a unit that fails it is deliberately absent rather than approximated:
 *
 * - `month` and `year` — a month is not a fixed number of days, so converting
 *   one manufactures a disagreement out of the calendar.
 * - `ounce` / `oz` — mass or fluid depending on a word the matcher does not
 *   capture ("16 fl oz" normalises to `oz` exactly as "16 oz" does).
 * - `m` — metres, minutes or million, and the reader cannot tell which from
 *   the character. Measured the moment dimensions were switched on: the
 *   recorded marathon answer writes "the total time of 227 minutes (3h 47m)",
 *   and against a corpus stating `42.195 km` the length dimension armed `m`
 *   and named **`47m`** — a duration reported as an unsupported distance, on
 *   an answer scored correct. `metre`, `meter`, `km`, `cm` and `mm` are
 *   unambiguous and stay.
 * - `degrees` — a temperature whose scale is unstated, and often not a
 *   temperature at all ("rotate 90 degrees"). `degrees F` and `degrees
 *   Celsius` are not this case and never were: they normalise to `°f` and `°c`
 *   before they reach here. See `canonicalTemperature`.
 * - `calorie` / `kcal` — a food "calorie" is a kilocalorie, so the factor
 *   depends on which convention the source used.
 * - `mph`, `km/h`, `kwh`, `watt`, `volt`, `amp` — see the note in
 *   `unitSpec` about rates, and each other's dimensions.
 *
 * An absent unit keeps exactly the behaviour it had before dimensions existed:
 * armed by its own spelling, supported by its own spelling, nothing crossed.
 */
const UNITS: Readonly<Record<string, UnitSpec>> = {
  // temperature, canonical kelvin. 0 °C = 273.15 K; 32 °F = 273.15 K.
  '°c': { dimension: 'temperature', factor: 1, offset: 273.15 },
  '°f': { dimension: 'temperature', factor: 5 / 9, offset: 273.15 - (32 * 5) / 9 },
  // duration, canonical second.
  second: { dimension: 'duration', factor: 1, offset: 0 },
  sec: { dimension: 'duration', factor: 1, offset: 0 },
  minute: { dimension: 'duration', factor: 60, offset: 0 },
  min: { dimension: 'duration', factor: 60, offset: 0 },
  hour: { dimension: 'duration', factor: 3600, offset: 0 },
  hr: { dimension: 'duration', factor: 3600, offset: 0 },
  day: { dimension: 'duration', factor: 86400, offset: 0 },
  week: { dimension: 'duration', factor: 604800, offset: 0 },
  // length, canonical metre.
  mm: { dimension: 'length', factor: 0.001, offset: 0 },
  cm: { dimension: 'length', factor: 0.01, offset: 0 },
  metre: { dimension: 'length', factor: 1, offset: 0 },
  meter: { dimension: 'length', factor: 1, offset: 0 },
  km: { dimension: 'length', factor: 1000, offset: 0 },
  // `inches` singularises to `inche`, so both spellings are keys.
  inch: { dimension: 'length', factor: 0.0254, offset: 0 },
  inche: { dimension: 'length', factor: 0.0254, offset: 0 },
  feet: { dimension: 'length', factor: 0.3048, offset: 0 },
  ft: { dimension: 'length', factor: 0.3048, offset: 0 },
  mile: { dimension: 'length', factor: 1609.344, offset: 0 },
  // mass, canonical gram.
  mcg: { dimension: 'mass', factor: 1e-6, offset: 0 },
  'µg': { dimension: 'mass', factor: 1e-6, offset: 0 },
  mg: { dimension: 'mass', factor: 0.001, offset: 0 },
  g: { dimension: 'mass', factor: 1, offset: 0 },
  gram: { dimension: 'mass', factor: 1, offset: 0 },
  kg: { dimension: 'mass', factor: 1000, offset: 0 },
  lb: { dimension: 'mass', factor: 453.59237, offset: 0 },
  pound: { dimension: 'mass', factor: 453.59237, offset: 0 },
  // volume, canonical litre. `gallon` is the US liquid gallon — exact by
  // definition, and the one the app's corpora are written in. An imperial
  // gallon is 20% larger; see the limits recorded in docs/evals.md.
  ml: { dimension: 'volume', factor: 0.001, offset: 0 },
  l: { dimension: 'volume', factor: 1, offset: 0 },
  litre: { dimension: 'volume', factor: 1, offset: 0 },
  liter: { dimension: 'volume', factor: 1, offset: 0 },
  gallon: { dimension: 'volume', factor: 3.785411784, offset: 0 }
}

/**
 * Split a normalised unit into the thing measured and the thing it is measured
 * per, because they are not the same kind of claim. "8.66 minutes per mile" is
 * a pace, not a duration, and comparing it against a running time reports a
 * disagreement between two quantities that were never the same.
 */
function splitRate(unit: string): { base: string; rate: string } {
  const at = unit.indexOf(' per ')
  return at === -1 ? { base: unit, rate: '' } : { base: unit.slice(0, at), rate: unit.slice(at) }
}

/**
 * The spec for a unit's base.
 *
 * v2.4: the degree family goes through `canonicalTemperature`, the same
 * function `normaliseUnit` uses. It used to carry `replace(/^°\s+/, '°')` —
 * a third place that knew how a temperature may be spelled, and one that knew
 * less than the other two. A caller reaching this with a raw `degrees F`, or
 * with `° F` from an older record, now gets the same answer `normaliseUnit`
 * would have given it.
 */
function unitSpec(base: string): UnitSpec | undefined {
  return UNITS[canonicalTemperature(base) ?? collapse(base)]
}

/**
 * The class two measurements must share before either can say anything about
 * the other: the same dimension, measured per the same thing.
 *
 * Returns null for a unit with no exact conversion, and that null is what
 * preserves the pre-dimension behaviour for it — the caller falls back to
 * matching the unit string, exactly as it always did.
 */
export function measurementGroup(unit: string): string | null {
  const { base, rate } = splitRate(unit)
  const spec = unitSpec(base)
  return spec ? `${spec.dimension}${rate}` : null
}

/**
 * `value` written in `to` instead of `from`, or null when the two units are
 * not the same quantity.
 *
 * This is the one place the file converts anything, and it converts only
 * within a dimension. Equating kilometres with miles would hide the
 * disagreement the check is looking for; equating 165 °F with 74 °C, or 2,000
 * gallons with 7,570 litres, is recognising that the reply quoted its source
 * and wrote it the other way round.
 */
export function convertUnit(value: number, from: string, to: string): number | null {
  if (from === to) return value
  const a = splitRate(from)
  const b = splitRate(to)
  if (a.rate !== b.rate) return null
  const fromSpec = unitSpec(a.base)
  const toSpec = unitSpec(b.base)
  if (!fromSpec || !toSpec || fromSpec.dimension !== toSpec.dimension) return null
  return (value * fromSpec.factor + fromSpec.offset - toSpec.offset) / toSpec.factor
}

/**
 * May a value in this unit be multiplied by a count?
 *
 * True for a unit this file does not know, which is the pre-dimension
 * behaviour: a bare count of widgets multiplies fine. False only for an
 * interval scale — see INTERVAL_SCALES.
 */
export function isRatioScale(unit: string): boolean {
  const spec = unitSpec(splitRate(unit).base)
  return !spec || !INTERVAL_SCALES.has(spec.dimension)
}
