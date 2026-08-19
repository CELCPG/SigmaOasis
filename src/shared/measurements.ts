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
 * Group 1 is the number, group 2 the unit.
 */
export function measurementPattern(): RegExp {
  return new RegExp(`(?<![\\w.])(\\d[\\d,]*(?:\\.\\d+)?)\\s*(${MEASUREMENT_UNITS})`, 'gi')
}
