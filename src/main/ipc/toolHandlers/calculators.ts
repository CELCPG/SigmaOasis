import { runFinanceCalculation } from '../finance'
import { runDateCalculation } from '../dates'
import { runGeoQuery } from '../geo'
import { fromOutcome } from './types'
import type { ToolHandler } from './types'

/**
 * Deterministic tools: exact math instead of mental arithmetic. finance and
 * dates do no I/O at all; geo_locate geocodes through OpenStreetMap Nominatim.
 */

const financeCalculator: ToolHandler = async (args) => runFinanceCalculation(args)

const geoLocate: ToolHandler = async (args) =>
  fromOutcome(await runGeoQuery(args as Parameters<typeof runGeoQuery>[0]))

const dateCalculator: ToolHandler = async (args) =>
  fromOutcome(runDateCalculation(args as Parameters<typeof runDateCalculation>[0]))

// v3.0: the weekday and the zone are spelled out. `toLocaleString()` gave
// "9/28/2026, 12:13:00 PM", and a 9B model reading it named the day wrong —
// "Sunday" for a Monday — because the weekday was left for it to compute.
const getCurrentDatetime: ToolHandler = async () => {
  const now = new Date()
  const local = now.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  })
  return { ok: true, output: `${local} (ISO: ${now.toISOString()})` }
}

export const calculatorHandlers = {
  finance_calculator: financeCalculator,
  geo_locate: geoLocate,
  date_calculator: dateCalculator,
  get_current_datetime: getCurrentDatetime
} satisfies Record<string, ToolHandler>
