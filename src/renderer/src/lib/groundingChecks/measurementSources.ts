// Split out of lib/toolGrounding.ts (v2.4): the "measurementSources" section. Behaviour-neutral —
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
import {
  citedIndices,
  danglingCitations,
  retrievedCitations,
  turnLookups,
  type Citation,
  type Lookup
} from '../citations'
import { agreesAfterConversion, comparableMagnitude, numbersIn, precisionOf, roundTo } from './figures'



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

export /** Beyond this many passages, the line stops naming them and counts the rest. */
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
