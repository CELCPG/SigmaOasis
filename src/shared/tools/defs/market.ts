import type { ToolMeta } from '../types'

export const marketToolDefs = [
  {
    name: 'market_data',
    label: 'Market data (daily stock/index/futures prices — sends the ticker to query1.finance.yahoo.com)',
    description:
      'Fetch a DAILY price series (open/high/low/close/volume) for a stock, ETF, index, futures ' +
      'contract or crypto pair, with app-computed summary stats (period return, high/low, max ' +
      'drawdown, realized volatility). The full series is staged at /work/<SYMBOL>.csv for ' +
      'run_python — compute indicators (SMA/EMA, RSI, ATR, beta vs an index) from that file and ' +
      'chart them with matplotlib saved to /work/chart.png. Symbols: AAPL, BRK-B, ^GSPC (index), ' +
      'ES=F / GC=F (futures), BTC-USD (crypto).\n' +
      'Use when: the user asks about a price, performance, volatility, drawdowns, or wants a chart ' +
      'or technical analysis of a real instrument — fetch first, compute second, never quote a ' +
      'price or indicator from memory.\n' +
      'Do not use when: the question is conceptual (what IS a moving average — answer or use ' +
      'reference_lookup); or for intraday data, order books or live quotes — this is daily history ' +
      'and may lag by a day. State the as-of date with any figure. Historical data is not a ' +
      'forecast; never extrapolate it into a prediction or a recommendation.\n' +
      'Example: {"symbol": "NVDA", "range": "6mo"}',
    parameters: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Ticker: AAPL, BRK-B, ^GSPC, ES=F, GC=F, BTC-USD. One symbol per call.'
        },
        range: {
          type: 'string',
          enum: ['1mo', '3mo', '6mo', '1y', '2y', '5y', 'max'],
          description: 'How far back (daily bars). Default 1y.'
        }
      },
      required: ['symbol']
    },
    // v1.12: off by default — a ticker lookup discloses what you are researching.
    toggleDefault: false,
    // One request per symbol; comparing a handful of instruments is legitimate,
    // a screener loop over the whole market is not.
    turnBudget: 4,
    // v1.12: a fetched price series is a source. Measured the omission live on
    // the tool's first real run: market_data fetched 125 days of NVDA, the model
    // answered from the tool's own computed stats, and the reply was branded
    // "answered from model memory — no sources consulted".
    isSource: true
  }
] as const satisfies readonly ToolMeta[]
