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

const getCurrentDatetime: ToolHandler = async () => {
  const now = new Date()
  return { ok: true, output: `${now.toLocaleString()} (ISO: ${now.toISOString()})` }
}

export const calculatorHandlers = {
  finance_calculator: financeCalculator,
  geo_locate: geoLocate,
  date_calculator: dateCalculator,
  get_current_datetime: getCurrentDatetime
} satisfies Record<string, ToolHandler>
