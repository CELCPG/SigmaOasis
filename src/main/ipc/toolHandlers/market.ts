import {
  csvNameFor,
  fetchMarketSeries,
  formatMarketOutput,
  normalizeRange,
  normalizeSymbol,
  toCsv
} from '../marketData'
import { runPython, workbenchRuntimePresent } from '../workbench'
import { truncate } from './types'
import type { ToolHandler } from './types'

/**
 * market_data (v1.12): fetch a daily OHLCV series, summarize it mechanically,
 * and stage the full CSV into the conversation's Workbench session so
 * indicators are COMPUTED with run_python, never recalled from weights. See
 * marketData.ts for the provider decision and the privacy posture.
 */

const marketData: ToolHandler = async (args, context) => {
  const symbol = normalizeSymbol(args.symbol)
  if (!symbol) {
    return {
      ok: false,
      error:
        'A symbol is required — a ticker like AAPL, an index like ^GSPC, a future like ES=F or GC=F, or a pair like BTC-USD.'
    }
  }
  const range = normalizeRange(args.range)

  const series = await fetchMarketSeries(symbol, range)
  const csv = toCsv(series.bars)
  const csvName = csvNameFor(symbol)

  // Stage the series into the conversation's sandbox session. A session keeps
  // /work between run_python calls, so the file is simply *there* for the
  // indicator computation that should follow. Best effort: without a runtime
  // or a conversation the summary still stands, and the note says what is
  // missing rather than pretending.
  let staged = false
  let stageNote = ''
  if (!workbenchRuntimePresent()) {
    stageNote = 'The Workbench runtime is not installed, so the series was not staged for run_python.'
  } else if (!context.conversationId) {
    stageNote = 'No conversation session, so the series was not staged for run_python.'
  } else {
    try {
      const out = await runPython({
        code: 'pass',
        files: [{ name: csvName, data: Buffer.from(csv, 'utf-8') }],
        session: context.conversationId,
        timeoutMs: 60_000
      })
      staged = out.ok
      if (!out.ok) stageNote = `Staging into the sandbox failed: ${out.error ?? 'unknown error'}.`
    } catch (err) {
      stageNote = `Staging into the sandbox failed: ${err instanceof Error ? err.message : String(err)}.`
    }
  }

  return { ok: true, output: truncate(formatMarketOutput(series, range, { staged, csvName, note: stageNote })) }
}

export const marketHandlers = {
  market_data: marketData
}
