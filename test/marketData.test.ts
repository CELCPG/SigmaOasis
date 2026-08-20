import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { load, resetState, state } from './harness'

/**
 * v1.12 market_data: keyless daily OHLCV with app-computed summaries. The
 * parsing and arithmetic are pure and pinned here against hand-computed
 * values; the handler is exercised through the harness's audited-fetch stub,
 * so the egress purpose and the degradation notes are pinned too.
 */

const md = load<typeof import('../src/main/ipc/marketData')>('marketData')
const { marketHandlers } = load<typeof import('../src/main/ipc/toolHandlers/market')>('toolHandlers/market')

function chartJson(closes: number[], opts: { nullAt?: number[]; symbol?: string } = {}): unknown {
  const day = 86_400
  const t0 = Date.UTC(2026, 0, 5) / 1000
  const stamps = closes.map((_, i) => t0 + i * day)
  const series = closes.map((c, i) => (opts.nullAt?.includes(i) ? null : c))
  return {
    chart: {
      result: [
        {
          meta: { currency: 'USD', symbol: opts.symbol ?? 'TEST', exchangeName: 'NMS', instrumentType: 'EQUITY' },
          timestamp: stamps,
          indicators: {
            quote: [{ open: series, high: series, low: series, close: series, volume: series.map(() => 1000) }],
            adjclose: [{ adjclose: series }]
          }
        }
      ],
      error: null
    }
  }
}

beforeEach(() => resetState())

describe('parseChart', () => {
  test('parses bars and drops null-close rows', () => {
    const s = md.parseChart(chartJson([100, 110, 99, 121], { nullAt: [1] }))
    assert.equal(s.symbol, 'TEST')
    assert.deepEqual(s.bars.map((b) => b.close), [100, 99, 121])
    assert.equal(s.bars[0]!.date, '2026-01-05')
  })

  test("a provider error surfaces in the provider's own words", () => {
    assert.throws(
      () => md.parseChart({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } }),
      /Not Found: No data found/
    )
  })

  test('an empty or malformed payload throws rather than returning nothing', () => {
    assert.throws(() => md.parseChart({ chart: { result: [] } }), /no series/)
    assert.throws(() => md.parseChart({}), /no series/)
  })
})

describe('summarize — every number hand-computed', () => {
  test('return, high/low, and max drawdown', () => {
    const s = md.summarize(md.parseChart(chartJson([100, 110, 99, 121])).bars)
    assert.equal(s.rows, 4)
    assert.ok(Math.abs(s.periodReturnPct - 21) < 1e-9) // 100 → 121
    assert.equal(s.high, 121)
    assert.equal(s.low, 99)
    assert.ok(Math.abs(s.maxDrawdownPct - -10) < 1e-9, `99 from a 110 peak is -10%, got ${s.maxDrawdownPct}`)
    assert.equal(s.annualizedVolPct, null, 'under 20 rows volatility must be refused, not extrapolated')
  })

  test('volatility appears with 20+ rows and is a plausible annualized figure', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 * (1 + 0.01) ** i * (i % 2 ? 1.005 : 0.995))
    const s = md.summarize(md.parseChart(chartJson(closes)).bars)
    assert.ok(s.annualizedVolPct !== null && s.annualizedVolPct > 0 && s.annualizedVolPct < 100)
  })
})

describe('symbol handling', () => {
  test('normalizeSymbol uppercases and rejects junk', () => {
    assert.equal(md.normalizeSymbol(' aapl '), 'AAPL')
    assert.equal(md.normalizeSymbol('btc-usd'), 'BTC-USD')
    assert.equal(md.normalizeSymbol('^gspc'), '^GSPC')
    assert.equal(md.normalizeSymbol('es=f'), 'ES=F')
    assert.equal(md.normalizeSymbol('not a ticker'), null)
    assert.equal(md.normalizeSymbol(''), null)
    assert.equal(md.normalizeSymbol('ABCDEFGHIJKLM'), null)
  })

  test('csv names are /work-safe', () => {
    assert.equal(md.csvNameFor('AAPL'), 'AAPL.csv')
    assert.equal(md.csvNameFor('^GSPC'), 'GSPC.csv')
    assert.equal(md.csvNameFor('ES=F'), 'ES_F.csv')
    assert.equal(md.csvNameFor('BRK-B'), 'BRK-B.csv')
  })

  test('toCsv round-trips the columns run_python is told about', () => {
    const csv = md.toCsv(md.parseChart(chartJson([100, 110])).bars)
    assert.match(csv, /^date,open,high,low,close,adj_close,volume\n/)
    assert.match(csv, /2026-01-05,100,100,100,100,100,1000\n/)
  })
})

describe('market_data handler', () => {
  test('fetches under the market purpose and reports computed stats', async () => {
    state.responses.push({
      match: 'query1.finance.yahoo.com/v8/finance/chart/AAPL',
      contentType: 'application/json',
      body: JSON.stringify(chartJson([100, 110, 99, 121], { symbol: 'AAPL' }))
    })
    const out = await marketHandlers.market_data({ symbol: 'aapl', range: '3mo' }, {} as never)
    assert.equal(out.ok, true, out.error)
    assert.match(out.output!, /period return \(3mo\): 21\.00%/)
    assert.match(out.output!, /max drawdown \(close-to-close\): -10\.00%/)
    assert.match(out.output!, /not advice or a prediction/)
    // No conversation in context → the degradation note, never silence.
    assert.match(out.output!, /was not staged/)
    const hit = state.fetchLog.find((f) => f.url.includes('query1.finance.yahoo.com'))
    assert.ok(hit, 'fetch must go through auditedFetch')
    assert.equal(hit!.purpose, 'market')
  })

  test('a junk symbol is refused before any request', async () => {
    const out = await marketHandlers.market_data({ symbol: 'not a ticker' }, {} as never)
    assert.equal(out.ok, false)
    assert.equal(state.fetchLog.length, 0, 'nothing may leave the machine for an invalid symbol')
  })

  test("an unknown ticker surfaces the provider's message", async () => {
    state.responses.push({
      match: '/v8/finance/chart/ZZZZ',
      contentType: 'application/json',
      status: 404,
      body: JSON.stringify({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } })
    })
    await assert.rejects(
      () => marketHandlers.market_data({ symbol: 'ZZZZ' }, {} as never),
      /symbol may be delisted/
    )
  })
})

describe('market_data is wired into the honesty rails (v1.12)', () => {
  test('a done market_data call counts as consulting a source', () => {
    const { consultedSources } = require('../src/renderer/src/lib/grounding') as typeof import('../src/renderer/src/lib/grounding')
    assert.equal(
      consultedSources([{ id: '1', name: 'market_data', args: {}, status: 'done', result: 'NVDA …' } as never]),
      true,
      'a fetched price series must not leave the reply branded "answered from model memory"'
    )
  })

  test("market_data's own computed figures support the reply", () => {
    const { checkToolGrounding } = require('../src/renderer/src/lib/toolGrounding') as typeof import('../src/renderer/src/lib/toolGrounding')
    // Verbatim shape of the tool output whose numbers were flagged live.
    const records = [
      {
        id: '1', name: 'market_data', args: {}, status: 'done',
        result: 'Computed by the app from the fetched series:\n- range high/low: 236.54 / 164.27\n- max drawdown (close-to-close): -19.40%'
      }
    ] as never[]
    const report = checkToolGrounding(
      'NVDA ranged from $164.27 to $236.54 with a max drawdown of 19.40%.',
      records as never,
      'how volatile has NVDA been'
    )
    assert.equal(report, null, JSON.stringify(report))
  })
})

describe('market eval scaffolding (v1.12)', () => {
  test('the fixture series parse with the real parser and are big enough to score', () => {
    const { readFileSync, readdirSync } = require('fs') as typeof import('fs')
    const { join } = require('path') as typeof import('path')
    const dir = join(__dirname, '..', '..', 'test', 'fixtures', 'market')
    const files = readdirSync(dir).filter((f: string) => f.endsWith('.chart.json'))
    assert.ok(files.length >= 2)
    for (const f of files) {
      const s = md.parseChart(JSON.parse(readFileSync(join(dir, f), 'utf-8')))
      assert.ok(s.symbol, `${f}: needs a symbol`)
      assert.ok(s.bars.length >= 40, `${f}: needs 40+ bars (20-day SMA plus history), has ${s.bars.length}`)
      const sum = md.summarize(s.bars)
      assert.ok(sum.annualizedVolPct !== null, `${f}: must be long enough for a volatility figure`)
    }
  })

  test('summarizeMarket splits arms and reads the honesty signals', () => {
    const { summarizeMarket } = require('../src/renderer/src/lib/answerEval') as typeof import('../src/renderer/src/lib/answerEval')
    const q = (kind: 'figures' | 'chart', hit: boolean, extra: Partial<{ computed: boolean; chartProduced: boolean; statedFigures: boolean; error: string }> = {}) => ({
      prompt: 'p', kind, hit, missing: [], fetched: true,
      computed: extra.computed ?? false, chartProduced: extra.chartProduced ?? false,
      statedFigures: extra.statedFigures ?? false, ms: 8000,
      ...(extra.error ? { error: extra.error } : {})
    })
    const s = summarizeMarket([
      {
        file: 'a', symbol: 'TRND',
        tool: [q('figures', true, { computed: true, statedFigures: true }), q('figures', false), q('chart', true, { chartProduced: true, computed: true })],
        bare: [q('figures', false, { statedFigures: true }), q('figures', false)]
      }
    ])
    assert.deepEqual(s.tool.figures, { hit: 1, of: 2 })
    assert.deepEqual(s.tool.charts, { hit: 1, of: 1 })
    assert.deepEqual(s.tool.computed, { hit: 2, of: 3 })
    // Bare: one fabricated a figure, one declined.
    assert.deepEqual(s.bare.declined, { hit: 1, of: 2 })
  })

  test('errored questions are excluded, not failed', () => {
    const { summarizeMarket } = require('../src/renderer/src/lib/answerEval') as typeof import('../src/renderer/src/lib/answerEval')
    const s = summarizeMarket([
      {
        file: 'a', symbol: 'X',
        tool: [
          { prompt: 'p', kind: 'figures', hit: false, missing: [], fetched: false, computed: false, chartProduced: false, statedFigures: false, ms: 1, error: 'fetch failed' },
          { prompt: 'p', kind: 'figures', hit: true, missing: [], fetched: true, computed: true, chartProduced: false, statedFigures: true, ms: 1 }
        ],
        bare: []
      }
    ])
    assert.deepEqual(s.tool.figures, { hit: 1, of: 1 })
  })
})
