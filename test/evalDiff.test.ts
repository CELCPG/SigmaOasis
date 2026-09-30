import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { detectSuite, diffResults, formatDiff, trimForBaseline } from '../src/main/agent/evalDiff'
import type { CaseRun } from '../src/main/agent/evalHarness'
import type { EvalFixtureRun } from '../src/renderer/src/lib/evalRunner'

/**
 * v4.1 (M2): the baseline gate, on synthetic results files in the runners'
 * own schemas. Every rule in evalDiff.ts's header has a case here.
 */

const run = (c: string, solved: boolean, extra: Partial<CaseRun> = {}): CaseRun =>
  ({ case: c, kind: 'fix', model: 'm', end: 'done', solved, claimedPass: false, falseClaim: false, lastTest: null, changed: [], collateral: [], undo: 'n/a', undoLeft: [], declined: [], mentionsMissing: [], rounds: 4, toolCalls: 3, ms: 60_000, completionTokens: 100, longestRound: 50, elisions: 0, elidedResults: 0, finalText: 'report', ...extra }) as CaseRun

const agentFile = (passes: CaseRun[][], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  suite: 'agent',
  model: 'm',
  experiments: {},
  baseUrl: 'http://127.0.0.1:1234/v1',
  shell: 'sh',
  startedAt: '2026-09-30T00-00-00',
  passes: passes.length,
  cases: [...new Set(passes.flat().map((r) => r.case))],
  runs: passes,
  ...extra
})

/** a, b stable-pass; c stable-fail; d flaky — three passes. */
const BASELINE = agentFile([
  [run('a', true), run('b', true), run('c', false), run('d', true)],
  [run('a', true), run('b', true), run('c', false), run('d', false)],
  [run('a', true), run('b', true), run('c', false), run('d', true)]
])

const row = (d: ReturnType<typeof diffResults>, metric: RegExp) => {
  const r = d.rows.find((x) => metric.test(x.metric))
  assert.ok(r, `no row ${metric}`)
  return r
}

describe('eval:diff on agent results', () => {
  test('a run identical to its baseline holds, every gated line "held"', () => {
    const d = diffResults(BASELINE, BASELINE)
    assert.deepEqual(d.regressions, [])
    assert.equal(row(d, /^solved, stable set \(3 cases\)$/).baseline, '6/9 (66.7%)')
    for (const m of [/^solved, stable/, /^false claims$/, /^collateral$/, /^undo left files$/]) assert.equal(row(d, m).verdict, 'held')
    assert.match(formatDiff(d), /held: no gated line got worse/)
  })

  test('a stable-pass case failing is a drop in the stable set, and is named', () => {
    const d = diffResults(BASELINE, agentFile([[run('a', true), run('b', false), run('c', false), run('d', true)]]))
    assert.equal(d.regressions.length, 1)
    assert.match(d.regressions[0]!, /stable set's solved rate fell from 6\/9 \(66\.7%\) to 1\/3 \(33\.3%\)/)
    assert.deepEqual(d.lost, ['b'])
    assert.match(formatDiff(d), /\*\*WORSE\*\*/)
    assert.match(formatDiff(d), /REGRESSION:/)
  })

  test('a flaky case failing is the noise floor: shown, not gated', () => {
    const d = diffResults(BASELINE, agentFile([[run('a', true), run('b', true), run('c', false), run('d', false)]]))
    assert.deepEqual(d.regressions, [])
    assert.equal(row(d, /flaky in the baseline \(1; not gated\)/).run, '0/1 (0.0%)')
  })

  test('false claims, collateral and a dirty Undo may not rise — on any case, flaky ones included', () => {
    const d = diffResults(
      BASELINE,
      agentFile([[run('a', true), run('b', true, { collateral: ['NOTES.md'] }), run('c', false, { undo: 'dirty', undoLeft: ['x'] }), run('d', true, { falseClaim: true })]])
    )
    assert.deepEqual(
      d.regressions.map((r) => r.split(' rose')[0]),
      ['false claims', 'collateral', 'undo left files']
    )
    assert.match(d.regressions[0]!, /from 0\/12 \(0\.0%\) to 1\/4 \(25\.0%\)/)
  })

  test('fewer false claims and a stable-fail case solved read "better", and the case is named', () => {
    const base = agentFile([[run('a', true, { falseClaim: true }), run('b', false)], [run('a', true, { falseClaim: true }), run('b', false)]])
    const d = diffResults(base, agentFile([[run('a', true), run('b', true)]]))
    assert.deepEqual(d.regressions, [])
    assert.equal(row(d, /^false claims$/).verdict, 'better')
    assert.equal(row(d, /^solved, stable/).verdict, 'better')
    assert.deepEqual(d.gained, ['b'])
  })

  test('only the cases both ran are compared, and the rest are named', () => {
    const d = diffResults(BASELINE, agentFile([[run('a', true), run('e', false)]]))
    assert.deepEqual(d.regressions, [])
    assert.equal(row(d, /^solved, stable set \(1 case\)$/).run, '1/1 (100.0%)')
    assert.ok(d.notes.includes('not in the run, not compared: b, c, d'))
    assert.ok(d.notes.includes('not in the baseline, not compared: e'))
  })

  test('an excluded run measured the server: not a failure, counted apart', () => {
    const d = diffResults(BASELINE, agentFile([[run('a', true), run('b', false, { end: 'error', excluded: 'fetch failed' }), run('c', false), run('d', true)]]))
    assert.deepEqual(d.regressions, [])
    assert.equal(row(d, /^runs excluded/).run, '1')
  })

  test('a tolerance lets a small solved drop hold; the default is none', () => {
    const many = (n: number, failing: number): CaseRun[][] => [Array.from({ length: n }, (_, i) => run(`c${String(i).padStart(2, '0')}`, i >= failing))]
    assert.equal(diffResults(agentFile(many(20, 0)), agentFile(many(20, 1))).regressions.length, 1)
    assert.deepEqual(diffResults(agentFile(many(20, 0)), agentFile(many(20, 1)), { tolerance: 0.05 }).regressions, [])
    assert.equal(diffResults(agentFile(many(20, 0)), agentFile(many(20, 2)), { tolerance: 0.05 }).regressions.length, 1)
  })

  test('a one-pass baseline, another model, another arm: compared, and said so', () => {
    const d = diffResults(agentFile([[run('a', true)]]), agentFile([[run('a', true)]], { model: 'n', experiments: { verifyRound: true } }))
    assert.deepEqual(d.notes, [
      'different models: m (baseline) vs n (run)',
      'different arms: default (baseline) vs experiments: verifyRound (run)',
      'the baseline has one pass, so no noise floor was measured: every case counts as stable'
    ])
  })

  test('timing is printed and never gated: a slower run still holds', () => {
    const timed = (ms: number, ttft: number): Partial<CaseRun> => ({
      ms,
      latencySummary: { rounds: 4, ttftMedianMs: ttft, ttftMaxMs: ttft, prefillMedianMs: ttft, prefillMaxMs: ttft, prefillFrom: 'ttft', decodeTokPerSecMedian: 40, promptTokensMax: 9000, cachedShare: null }
    })
    const d = diffResults(agentFile([[run('a', true, timed(60_000, 1000))]]), agentFile([[run('a', true, timed(120_000, 3000))]]))
    assert.deepEqual(d.regressions, [])
    assert.deepEqual(
      [row(d, /^median time, solved/).delta, row(d, /^TTFT/).baseline, row(d, /^TTFT/).run, row(d, /^TTFT/).delta],
      ['+100%', '1.0 s', '3.0 s', '+200%']
    )
  })

  test('files that cannot be compared are refused with the reason', () => {
    assert.throws(() => detectSuite({ model: 'm' }), /no "runs" array/)
    assert.throws(() => diffResults(BASELINE, { model: 'm', runs: [{ file: '01.json', expect: 'no_tool' }] }), /agent results and the run is toolchoice/)
    assert.throws(() => diffResults(BASELINE, agentFile([[run('z', true)]])), /share no scored case/)
  })
})

// ---- eval:tools results ----------------------------------------------------------

const fx = (file: string, ok: boolean, extra: Partial<EvalFixtureRun> = {}): EvalFixtureRun => ({
  file,
  prompt: file,
  expect: { tool: 'web_search' },
  round1Calls: ok ? ['web_search'] : [],
  allCalls: ok ? [{ name: 'web_search', valid: true, errors: [] }] : [],
  stopReason: 'done',
  correct: ok,
  spurious: null,
  looped: false,
  ...extra
})
const noTool = (file: string, spurious: boolean): EvalFixtureRun =>
  fx(file, !spurious, { expect: 'no_tool', correct: null, spurious, round1Calls: spurious ? ['web_search'] : [], allCalls: spurious ? [{ name: 'web_search', valid: true, errors: [] }] : [] })
const toolsFile = (runs: EvalFixtureRun[]): Record<string, unknown> => ({ model: 'm', baseUrl: 'x', ranAt: 'now', arm: 'full', caveats: [], scores: {}, runs })

describe('eval:diff on eval:tools results', () => {
  // Two passes, flattened as the runner writes them: 01, 02, 03, then 01, 02, 03 again. 02 flips.
  const base = toolsFile([fx('01', true), fx('02', true), noTool('03', false), fx('01', true), fx('02', false), noTool('03', false)])

  test('passes are read back from the repeating fixture order; the flip is the noise floor', () => {
    const d = diffResults(base, toolsFile([fx('01', true), fx('02', false), noTool('03', false)]))
    assert.equal(d.suite, 'toolchoice')
    assert.equal(d.baseline.passes, 2)
    assert.deepEqual(d.regressions, [])
    assert.equal(row(d, /^clean, stable set \(2 cases\)$/).baseline, '4/4 (100.0%)')
  })

  test('a spurious call on a no-tool fixture, and a lost stable fixture, are regressions; a server error is excluded', () => {
    const d = diffResults(base, toolsFile([fx('01', false, { error: 'HTTP 500' }), fx('02', true), noTool('03', true)]))
    assert.equal(row(d, /^runs excluded/).run, '1')
    assert.deepEqual(d.lost, ['03'])
    assert.equal(d.regressions.length, 2)
    assert.match(d.regressions.join('\n'), /clean rate fell/)
    assert.match(d.regressions.join('\n'), /spurious calls \(no-tool fixtures\) rose from 0\/2 \(0\.0%\) to 1\/1 \(100\.0%\)/)
  })

  test('invalid arguments and loops may not rise', () => {
    const d = diffResults(base, toolsFile([fx('01', true, { allCalls: [{ name: 'web_search', valid: false, errors: ['query: required'] }] }), fx('02', true, { looped: true }), noTool('03', false)]))
    // 02 looping is not clean, but 02 is flaky in the baseline: only the loop line gates it.
    assert.deepEqual(
      d.regressions.map((r) => r.split(' rose')[0]),
      ['loops', 'runs with invalid arguments']
    )
  })
})

// ---- the committed copy --------------------------------------------------------------

test('--save trims a results file to a baseline of the same schema, which diffs clean against the original', () => {
  const full = agentFile([
    [run('a', true, { finalText: 'x'.repeat(4000), check: { exitCode: 0, tail: 'ok '.repeat(500) }, latency: [{ ok: true, ttftMs: 10, prefillMs: 10, prefillFrom: 'ttft', totalMs: 20 }] })]
  ])
  const trimmed = trimForBaseline(full, 'agent-m-2026-09-30T00-00-00.json', new Date('2026-09-30T12:00:00Z'))
  assert.deepEqual(trimmed.baseline, { from: 'agent-m-2026-09-30T00-00-00.json', savedAt: '2026-09-30T12:00:00.000Z' })
  const r = (trimmed.runs as CaseRun[][])[0]![0]!
  assert.equal(r.finalText, '')
  assert.equal(r.latency, undefined)
  assert.deepEqual(r.check, { exitCode: 0, tail: '' })
  assert.equal(r.solved, true)
  assert.ok(JSON.stringify(trimmed).length < JSON.stringify(full).length / 4)
  assert.deepEqual(diffResults(trimmed, full).regressions, [])
  assert.equal(detectSuite(trimForBaseline(toolsFile([fx('01', true)]), 'f')), 'toolchoice')
})
