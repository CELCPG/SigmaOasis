import {
  MARKET_DATA_HOST,
  csvNameFor,
  fetchMarketSeries,
  normalizeRange,
  normalizeSymbol,
  summarize,
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

/** Recent closes shown inline, so eyeballing the tape needs no python. */
const TAIL_ROWS = 10

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
  const s = summarize(series.bars)
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

  const money = (n: number): string =>
    n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(Math.round(n * 10000) / 10000)
  const tail = series.bars.slice(-TAIL_ROWS)
  const lines = [
    `${series.symbol || symbol} · ${series.instrumentType || 'instrument'} · ${series.exchange || 'exchange n/a'} · ${series.currency || 'currency n/a'}`,
    `Daily bars from ${MARKET_DATA_HOST}, ${s.firstDate} → ${s.lastDate} (${s.rows} trading days). As of ${s.lastDate} — data may lag by a day; this is an unofficial public endpoint.`,
    '',
    'Computed by the app from the fetched series (state these exactly as shown):',
    `- last close: ${money(s.lastClose)}`,
    `- period return (${range}): ${s.periodReturnPct.toFixed(2)}%  (${money(s.firstClose)} → ${money(s.lastClose)})`,
    `- range high/low: ${money(s.high)} / ${money(s.low)}`,
    `- max drawdown (close-to-close): ${s.maxDrawdownPct.toFixed(2)}%`,
    s.annualizedVolPct !== null
      ? `- realized volatility (annualized, daily log returns): ${s.annualizedVolPct.toFixed(1)}%`
      : '- realized volatility: not computed (under 20 trading days in range)',
    '',
    `Last ${tail.length} closes: ${tail.map((b) => `${b.date} ${money(b.close)}`).join(' · ')}`,
    '',
    staged
      ? `Full series staged at /work/${csvName} (columns: date,open,high,low,close,adj_close,volume). ` +
        'Compute indicators from it with run_python — pandas/numpy for SMA/EMA, RSI, ATR, beta vs an index series — ' +
        'and chart with matplotlib saved to /work/chart.png (shown to the user). Never state an indicator value you did not compute this conversation.'
      : stageNote,
    'These are historical prices, not advice or a prediction. Do not extrapolate them into a forecast.'
  ]
  return { ok: true, output: truncate(lines.filter(Boolean).join('\n')) }
}

export const marketHandlers = {
  market_data: marketData
}
