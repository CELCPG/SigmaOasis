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

/** Every measurement in a body of text. */
export function measurementsIn(text: string): Measurement[] {
  const out: Measurement[] = []
  for (const m of text.matchAll(measurementPattern())) {
    const value = Number(m[1].replace(/,/g, ''))
    if (!Number.isFinite(value)) continue
    out.push({ value, unit: normaliseUnit(m[2], m[3]), raw: m[0].trim().replace(/\s+/g, ' ') })
  }
  return out
}
