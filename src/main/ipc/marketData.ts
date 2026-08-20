import { auditedFetch } from './net'

/**
 * v1.12 market data: daily OHLCV series for stocks, ETFs, indices, futures and
 * crypto pairs, fetched keylessly and summarized mechanically.
 *
 * Provider: Yahoo Finance's public chart endpoint (query1.finance.yahoo.com).
 * Chosen by testing, not preference — the plan was a Stooq-style CSV host, and
 * probing it found a JavaScript proof-of-work wall in front of every response;
 * solving that programmatically is bot-detection circumvention, which this app
 * does not do. Yahoo's endpoint answers plain requests with structured JSON,
 * serves futures (`ES=F`, `GC=F`) and indices (`^GSPC`) natively, and returns
 * a clean machine-readable error for an unknown symbol. It is unofficial: it
 * can change or rate-limit at any time, and when it does this tool degrades to
 * a clear error, never to guessed numbers.
 *
 * Privacy: the request necessarily carries the ticker — that is the entire
 * disclosure, stated in the tool's Settings description. One pinned host on
 * its own egress purpose ('market'), every request in the activity log, ships
 * OFF by default like the shopping tools.
 *
 * Every figure this module emits is computed here, in this file, from the
 * fetched series — the same "computed, not recalled" contract the Workbench
 * banner enforces. The full series is handed to the sandbox as a CSV so
 * indicators are computed with run_python rather than recalled from weights.
 */

export const MARKET_DATA_HOST = 'query1.finance.yahoo.com'
export const MARKET_RANGES = ['1mo', '3mo', '6mo', '1y', '2y', '5y', 'max'] as const
export type MarketRange = (typeof MARKET_RANGES)[number]

/** Uppercase tickers with the punctuation real symbols use: BRK-B, ^GSPC, ES=F, BTC-USD, 7203.T. */
const SYMBOL_SHAPE = /^[A-Z0-9^.=-]{1,12}$/

export interface MarketBar {
  /** ISO date (UTC) of the trading day. */
  date: string
  open: number
  high: number
  low: number
  close: number
  adjClose: number | null
  volume: number | null
}

export interface MarketSeries {
  symbol: string
  currency: string
  exchange: string
  /** Yahoo's instrument class — EQUITY, ETF, INDEX, FUTURE, CRYPTOCURRENCY, … */
  instrumentType: string
  bars: MarketBar[]
}

export interface MarketSummary {
  rows: number
  firstDate: string
  lastDate: string
  firstClose: number
  lastClose: number
  /** Simple close-to-close return over the window, percent. */
  periodReturnPct: number
  high: number
  low: number
  /** Deepest peak-to-trough close decline in the window, percent (≤ 0). */
  maxDrawdownPct: number
  /** Annualized stdev of daily log returns, percent; null under 20 rows. */
  annualizedVolPct: number | null
}

export function normalizeSymbol(raw: unknown): string | null {
  const s = String(raw ?? '').trim().toUpperCase()
  return SYMBOL_SHAPE.test(s) ? s : null
}

export function normalizeRange(raw: unknown): MarketRange {
  const s = String(raw ?? '').trim().toLowerCase()
  return (MARKET_RANGES as readonly string[]).includes(s) ? (s as MarketRange) : '1y'
}

/** The slice of Yahoo's chart JSON this module reads. */
interface ChartPayload {
  chart?: {
    result?: Array<{
      meta?: { currency?: string; symbol?: string; exchangeName?: string; instrumentType?: string }
      timestamp?: number[]
      indicators?: {
        quote?: Array<{ open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }>
        adjclose?: Array<{ adjclose?: (number | null)[] }>
      }
    }> | null
    error?: { code?: string; description?: string } | null
  }
}

/**
 * Parse the chart payload into dated bars. Rows with a null close are dropped
 * (Yahoo emits them for halts and partial days); a payload with an `error`
 * object throws with the provider's own description, so "PLTR2 is not a
 * symbol" reaches the model as exactly that.
 */
export function parseChart(json: unknown): MarketSeries {
  const payload = json as ChartPayload
  const error = payload.chart?.error
  if (error) throw new Error(`${error.code ?? 'Provider error'}: ${error.description ?? 'no detail given'}`)
  const result = payload.chart?.result?.[0]
  const quote = result?.indicators?.quote?.[0]
  const stamps = result?.timestamp
  if (!result || !quote || !Array.isArray(stamps) || stamps.length === 0) {
    throw new Error('The provider returned no series for this symbol and range.')
  }
  const adj = result.indicators?.adjclose?.[0]?.adjclose
  const bars: MarketBar[] = []
  for (let i = 0; i < stamps.length; i++) {
    const close = quote.close?.[i]
    if (typeof close !== 'number' || !Number.isFinite(close)) continue
    const at = (n: (number | null)[] | undefined): number | null =>
      typeof n?.[i] === 'number' && Number.isFinite(n[i] as number) ? (n[i] as number) : null
    bars.push({
      date: new Date(stamps[i]! * 1000).toISOString().slice(0, 10),
      open: at(quote.open) ?? close,
      high: at(quote.high) ?? close,
      low: at(quote.low) ?? close,
      close,
      adjClose: at(adj),
      volume: at(quote.volume)
    })
  }
  if (bars.length === 0) throw new Error('The provider returned a series with no usable closes.')
  return {
    symbol: result.meta?.symbol ?? '',
    currency: result.meta?.currency ?? '',
    exchange: result.meta?.exchangeName ?? '',
    instrumentType: result.meta?.instrumentType ?? '',
    bars
  }
}

/** Mechanical summary of a series — every number here is computed from the bars. */
export function summarize(bars: MarketBar[]): MarketSummary {
  const first = bars[0]!
  const last = bars[bars.length - 1]!
  let high = -Infinity
  let low = Infinity
  let peak = -Infinity
  let maxDrawdown = 0
  const logReturns: number[] = []
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!
    if (b.high > high) high = b.high
    if (b.low < low) low = b.low
    if (b.close > peak) peak = b.close
    const dd = (b.close / peak - 1) * 100
    if (dd < maxDrawdown) maxDrawdown = dd
    if (i > 0 && bars[i - 1]!.close > 0) logReturns.push(Math.log(b.close / bars[i - 1]!.close))
  }
  let vol: number | null = null
  if (logReturns.length >= 20) {
    const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length
    const variance = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (logReturns.length - 1)
    vol = Math.sqrt(variance) * Math.sqrt(252) * 100
  }
  return {
    rows: bars.length,
    firstDate: first.date,
    lastDate: last.date,
    firstClose: first.close,
    lastClose: last.close,
    periodReturnPct: (last.close / first.close - 1) * 100,
    high,
    low,
    maxDrawdownPct: maxDrawdown,
    annualizedVolPct: vol
  }
}

/** The series as the CSV run_python reads at /work/<SYMBOL>.csv. */
export function toCsv(bars: MarketBar[]): string {
  const lines = ['date,open,high,low,close,adj_close,volume']
  for (const b of bars) {
    lines.push(
      `${b.date},${b.open},${b.high},${b.low},${b.close},${b.adjClose ?? ''},${b.volume ?? ''}`
    )
  }
  return lines.join('\n') + '\n'
}

/** /work-safe filename for a symbol: ^GSPC → GSPC.csv, ES=F → ES_F.csv, BRK-B → BRK-B.csv. */
export function csvNameFor(symbol: string): string {
  return `${symbol.replace(/[\^=]/g, (c) => (c === '^' ? '' : '_'))}.csv`
}

/** Recent closes shown inline, so eyeballing the tape needs no python. */
const TAIL_ROWS = 10

/**
 * The tool output, single-sourced: the handler formats real fetches with it
 * and the market eval formats fixture series with it, so what the eval grades
 * is byte-for-byte what the app says.
 */
export function formatMarketOutput(
  series: MarketSeries,
  range: MarketRange,
  staging: { staged: boolean; csvName: string; note?: string }
): string {
  const s = summarize(series.bars)
  const money = (n: number): string =>
    n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(Math.round(n * 10000) / 10000)
  const tail = series.bars.slice(-TAIL_ROWS)
  const lines = [
    `${series.symbol} · ${series.instrumentType || 'instrument'} · ${series.exchange || 'exchange n/a'} · ${series.currency || 'currency n/a'}`,
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
    staging.staged
      ? `Full series staged at /work/${staging.csvName} (columns: date,open,high,low,close,adj_close,volume). ` +
        'Compute indicators from it with run_python — pandas/numpy for SMA/EMA, RSI, ATR, beta vs an index series — ' +
        'and chart with matplotlib saved to /work/chart.png (shown to the user). Never state an indicator value you did not compute this conversation.'
      : staging.note ?? '',
    'These are historical prices, not advice or a prediction. Do not extrapolate them into a forecast.'
  ]
  return lines.filter(Boolean).join('\n')
}

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const TIMEOUT_MS = 20_000

export async function fetchMarketSeries(symbol: string, range: MarketRange): Promise<MarketSeries> {
  const url = `https://${MARKET_DATA_HOST}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`
  const res = await auditedFetch(url, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES }, 'market')
  if (!res.ok) {
    // Yahoo puts symbol errors in a JSON body on 404 — surface its own words.
    const body = await res.text().catch(() => '')
    try {
      return parseChart(JSON.parse(body))
    } catch (err) {
      if (err instanceof Error && /^(Not Found|Provider error)/.test(err.message)) throw err
    }
    throw new Error(`Market data provider answered HTTP ${res.status}.`)
  }
  return parseChart(await res.json())
}
