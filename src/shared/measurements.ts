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
 */

/**
 * The units themselves, as alternation source. Deliberately finite: time,
 * distance, mass, volume, temperature, speed and energy — the things that are
 * measured. Not currency (money has its own check, with its own rules about
 * derivation) and not bare counts, which are usually a list length rather than
 * a claim about the world.
 */
export const MEASUREMENT_UNITS =
  '°\\s?[cf]\\b|degrees?\\b|' +
  'minutes?\\b|mins?\\b|hours?\\b|hrs?\\b|days?\\b|weeks?\\b|months?\\b|years?\\b|' +
  'seconds?\\b|secs?\\b|' +
  'mg\\b|mcg\\b|µg\\b|ml\\b|grams?\\b|g\\b|kg\\b|litres?\\b|liters?\\b|l\\b|gallons?\\b|' +
  'ounces?\\b|oz\\b|pounds?\\b|lbs?\\b|' +
  'cm\\b|mm\\b|metres?\\b|meters?\\b|m\\b|inches?\\b|feet\\b|ft\\b|miles?\\b|km\\b|' +
  'mph\\b|km\\/h\\b|kwh\\b|watts?\\b|volts?\\b|amps?\\b|calories\\b|kcal\\b'

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
export function measurementPattern(): RegExp {
  // Horizontal space only, never a line break. A number ending one line and a
  // word beginning the next are not a measurement: tool output reading
  // "Total time: 3:47\nMiles run: 26.2" would otherwise yield "47 Miles" and
  // put a distance into the corpus that nothing ever computed. Caught by test,
  // and the same trap the address check documents.
  return new RegExp(
    `(?<![\\w.])(\\d[\\d,]*(?:\\.\\d+)?)[ \\t]*(${MEASUREMENT_UNITS})([ \\t]*(?:per|/)[ \\t]*[a-z]+\\b)?`,
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

/**
 * Canonical name for a unit as written, so `miles`, `Mile` and `mi` are one
 * kind of thing and `minutes per mile` is a different kind from `minutes`.
 * Deliberately shallow: it folds case, plurals and spacing, and does NOT
 * convert between units — a check that silently equates kilometres and miles
 * would hide exactly the disagreement it is looking for.
 */
export function normaliseUnit(unit: string, suffix?: string): string {
  const base = unit.trim().toLowerCase().replace(/\s+/g, ' ').replace(/s$/, '')
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
  const m = /^°\s?([cf])$/.exec(unit.trim().toLowerCase())
  return m ? (m[1] as 'c' | 'f') : null
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
export function measurementsIn(text: string): Measurement[] {
  const out: Measurement[] = []
  for (const m of text.matchAll(measurementPattern())) {
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
 * - `degrees` — a temperature whose scale is unstated.
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

/** The spec for a unit's base, tolerating the `° C` spacing the matcher permits. */
function unitSpec(base: string): UnitSpec | undefined {
  return UNITS[base.trim().replace(/^°\s+/, '°')]
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
