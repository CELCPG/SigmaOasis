import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { MIN_PASSES, detectSuite, diffResults, formatDiff, joinSlices, measureNoise, mergeResults, noiseBand, passesToResolve, sampleSd, trimForBaseline } from '../src/main/agent/evalDiff'
import type { CaseRun } from '../src/main/agent/evalHarness'
import type { EvalFixtureRun } from '../src/renderer/src/lib/evalRunner'

/**
 * v4.1 (M2), v4.3: the baseline gate, on synthetic results files in the
 * runners' own schemas. Every rule in evalDiff.ts's header has a case here.
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

const ID = (i: number): string => `c${String(i).padStart(2, '0')}`

/**
 * Passes over `n` cases with given per-pass counts: the first `solved[p]` cases
 * solved, the last `collateral[p]` with collateral, the first `undo[p]` with a
 * dirty Undo, the first `falseClaims[p]` failing ones claiming a pass.
 */
function passes(n: number, solved: number[], o: { collateral?: number[]; undo?: number[]; falseClaims?: number[] } = {}): CaseRun[][] {
  return solved.map((s, p) =>
    Array.from({ length: n }, (_, i) =>
      run(ID(i), i < s, {
        ...(i >= n - (o.collateral?.[p] ?? 0) ? { collateral: ['NOTES.md'] } : {}),
        ...(i < (o.undo?.[p] ?? 0) ? { undo: 'dirty' as const, undoLeft: ['x'] } : {}),
        ...(i >= s && i < s + (o.falseClaims?.[p] ?? 0) ? { falseClaim: true } : {})
      })
    )
  )
}

const row = (d: ReturnType<typeof diffResults>, metric: RegExp) => {
  const r = d.rows.find((x) => metric.test(x.metric))
  assert.ok(r, `no row ${metric}`)
  return r
}

/** The 9B on 2026-09-30, per pass of 26 — the 4.1 engine's two runs; then 4.2's with experiments off, byte-identical requests. */
const COLLATERAL_41 = [2, 1, 3, 1]
const ENGINE_41 = agentFile(passes(26, [18, 21, 20, 19], { collateral: COLLATERAL_41, undo: [0, 0, 0, 0] }))
const ENGINE_42 = agentFile(passes(26, [14, 16, 17, 21], { collateral: [3, 3, 4, 2], undo: [0, 1, 0, 0] }))

describe('eval:diff on agent results: the noise band (v4.3)', () => {
  test('the same engine measured twice on 9/30 — 18, 21, 20, 19 against 14, 16, 17, 21 — is SAME-WITHIN-NOISE, both ways', () => {
    const d = diffResults(ENGINE_41, ENGINE_42)
    assert.equal(d.verdict, 'SAME-WITHIN-NOISE', formatDiff(d))
    assert.deepEqual(d.regressions, [])
    const s = row(d, /^solved per pass \(26 cases\)$/)
    assert.deepEqual([s.delta, s.band, s.verdict], ['−2.50', '±3.21', 'SAME-WITHIN-NOISE'])
    const c = row(d, /^collateral$/)
    assert.deepEqual([c.delta, c.band, c.verdict], ['+1.25', '±1.35', 'SAME-WITHIN-NOISE'])
    assert.equal(row(d, /^undo left files$/).verdict, 'SAME-WITHIN-NOISE')
    assert.match(formatDiff(d), /SAME-WITHIN-NOISE: no gated line moved beyond its noise band/)
    assert.equal(diffResults(ENGINE_42, ENGINE_41).verdict, 'SAME-WITHIN-NOISE')
  })

  test("which 4.1's stable-set gate called WORSE: the cases it lost are still named, and no longer gated", () => {
    const d = diffResults(ENGINE_41, ENGINE_42)
    assert.ok(d.lost.length > 0)
    assert.equal(row(d, /^solved, stable set/).verdict, '')
  })

  test('a drop beyond the band is WORSE, and the regression names the line, both means and the band', () => {
    const d = diffResults(ENGINE_41, agentFile(passes(26, [14, 13, 15, 14], { collateral: COLLATERAL_41 })))
    assert.equal(d.verdict, 'WORSE')
    assert.deepEqual(d.regressions, ['solved per pass (26 cases) fell from 19.50 to 14.00 of 26 per pass (−5.50; noise band ±1.83)'])
    assert.match(formatDiff(d), /\*\*WORSE\*\*/)
    assert.match(formatDiff(d), /^WORSE: solved per pass/m)
  })

  test('a gain beyond the band is BETTER', () => {
    const d = diffResults(agentFile(passes(26, [14, 16, 15, 15])), agentFile(passes(26, [21, 22, 21, 22])))
    assert.equal(d.verdict, 'BETTER')
    assert.equal(row(d, /^solved per pass/).verdict, 'BETTER')
    assert.match(d.improvements[0]!, /rose from 15\.00 to 21\.50/)
  })

  test("the band is two standard errors of the difference of the means, the run's spread floored at the baseline's", () => {
    // Four identical passes 1.5 below a σ 1.29 baseline. Floored, the band is 2 · 1.29 · √(1/4 + 1/4) = 1.83: SAME.
    // Unfloored it would be 1.29, and an engine that merely agreed with itself would read WORSE.
    const d = diffResults(ENGINE_41, agentFile(passes(26, [18, 18, 18, 18], { collateral: COLLATERAL_41 })))
    assert.deepEqual([row(d, /^solved per pass/).delta, row(d, /^solved per pass/).band, d.verdict], ['−1.50', '±1.83', 'SAME-WITHIN-NOISE'])
    const nb = noiseBand([0.5, 0.6, 0.7, 0.6], [0.4, 0.4, 0.4, 0.4])
    assert.equal(nb.sdRun, nb.sdBase)
    assert.ok(Math.abs(nb.band - 2 * Math.sqrt((2 * nb.sdBase ** 2) / 4)) < 1e-12)
  })

  test(`fewer than ${MIN_PASSES} passes on either side: TOO-FEW-PASSES, no banded line called, and it says what to run`, () => {
    for (const [b, r] of [
      [agentFile(passes(26, [18, 21])), ENGINE_42],
      [ENGINE_41, agentFile(passes(26, [14, 16]))]
    ] as const) {
      const d = diffResults(b, r)
      assert.equal(d.verdict, 'TOO-FEW-PASSES')
      assert.equal(row(d, /^solved per pass/).verdict, '')
      assert.match(d.caveats.join('\n'), /needs 4 passes per arm.*EVAL_PASSES=4/)
    }
    // Even a large drop is not called on two passes: the gate says it cannot tell.
    assert.equal(diffResults(agentFile(passes(26, [26, 26])), agentFile(passes(26, [0, 0]))).verdict, 'TOO-FEW-PASSES')
  })

  test('a false claim is WORSE on any number of passes: never banded', () => {
    const d = diffResults(ENGINE_41, agentFile(passes(26, [18, 21, 20, 19], { collateral: COLLATERAL_41, falseClaims: [0, 1, 0, 0] })))
    assert.equal(d.verdict, 'WORSE')
    assert.deepEqual(d.regressions, ['false claims rose from 0/104 (0.0%) to 1/104 (1.0%) — never banded: any rise is WORSE'])
    const one = diffResults(ENGINE_41, agentFile(passes(26, [19], { falseClaims: [1] })))
    assert.equal(one.verdict, 'WORSE')
    assert.equal(row(one, /^false claims/).verdict, 'WORSE')
  })

  test('collateral and a dirty Undo are banded: one stray is noise, every pass is not', () => {
    assert.equal(diffResults(ENGINE_41, agentFile(passes(26, [18, 21, 20, 19], { collateral: COLLATERAL_41, undo: [0, 1, 0, 0] }))).verdict, 'SAME-WITHIN-NOISE')
    const d = diffResults(ENGINE_41, agentFile(passes(26, [18, 21, 20, 19], { collateral: COLLATERAL_41, undo: [1, 1, 1, 1] })))
    assert.equal(d.verdict, 'WORSE')
    assert.deepEqual(d.regressions, ['undo left files rose from 0.00 to 1.00 of 26 per pass (+1.00; noise band ±0.00)'])
  })

  test("a baseline's stored band is used when the comparison covers its cases, and re-derived when it does not", () => {
    const base = trimForBaseline(ENGINE_41, 'x.json', new Date('2026-10-01T00:00:00Z'), { noise: true })
    const noise = base.noise as ReturnType<typeof measureNoise>
    const wide = { ...base, noise: { ...noise, lines: { ...noise.lines, solved: { ...noise.lines.solved!, sd: 0.2 } } } }
    const d = diffResults(wide, ENGINE_42)
    assert.match(d.caveats.join('\n'), /baseline spread: stored, from 4 passes in 1 run/)
    // σ 0.2 of a rate is 5.2 cases, above the run's own 2.94, so both sides use it: 2 · 5.2 · √(1/4 + 1/4) = 7.35.
    assert.equal(row(d, /^solved per pass/).band, '±7.35')
    const sub = diffResults(wide, agentFile(passes(10, [6, 7, 8, 9])))
    assert.match(sub.caveats.join('\n'), /stored band covers its 26 cases; this comparison covers 10/)
  })

  test('the passes a 2-case change would need at the measured spread are printed', () => {
    assert.match(diffResults(ENGINE_41, ENGINE_42).caveats.join('\n'), /σ 2\.94 of 26 per pass\) a change of 2 solved per pass needs about 18 passes per arm/)
    assert.equal(passesToResolve(0, 0.1), 1)
    assert.equal(passesToResolve(2.94 / 26, 2 / 26), 18)
  })

  test("4.1's stable-set lists still name what was lost and gained; a deterministic replay may ask for one pass", () => {
    const base = agentFile([
      [run('a', true), run('b', true), run('c', false), run('d', true)],
      [run('a', true), run('b', true), run('c', false), run('d', false)]
    ])
    const d = diffResults(base, agentFile([[run('a', true), run('b', false), run('c', true), run('d', true)]]), { minPasses: 1 })
    assert.deepEqual(d.lost, ['b'])
    assert.deepEqual(d.gained, ['c'])
    assert.equal(d.verdict, 'SAME-WITHIN-NOISE', 'b lost and c gained: three solved, within the band of a 3-then-2 baseline')
  })
})

describe('eval:diff on agent results: what is compared', () => {
  const FOUR = agentFile(passes(4, [3, 3, 3, 3]))

  test('a run identical to its baseline is SAME-WITHIN-NOISE on every gated line', () => {
    const d = diffResults(FOUR, FOUR)
    assert.equal(d.verdict, 'SAME-WITHIN-NOISE')
    for (const m of [/^solved per pass/, /^false claims/, /^collateral$/, /^undo left files$/]) assert.equal(row(d, m).verdict, 'SAME-WITHIN-NOISE')
  })

  test('only the cases both ran are compared, and the rest are named', () => {
    const d = diffResults(FOUR, agentFile([[run(ID(0), true), run('e', false)]]), { minPasses: 1 })
    assert.equal(row(d, /^solved per pass \(1 case\)$/).run, '1.00/1 per pass, σ 0.00 · [1]')
    assert.ok(d.notes.includes('not in the run, not compared: c01, c02, c03'))
    assert.ok(d.notes.includes('not in the baseline, not compared: e'))
  })

  test('an excluded run measured the server: not a failure, counted apart', () => {
    const p = passes(4, [3, 3, 3, 3])
    p[1]![0] = run(ID(0), false, { end: 'error', excluded: 'fetch failed' })
    const d = diffResults(FOUR, agentFile(p))
    assert.equal(d.verdict, 'SAME-WITHIN-NOISE')
    assert.equal(row(d, /^runs excluded/).run, '1')
  })

  test('a tolerance widens the solved band; the default is none', () => {
    const base = agentFile(passes(20, [20, 20, 20, 20]))
    assert.equal(diffResults(base, agentFile(passes(20, [19, 19, 19, 19]))).verdict, 'WORSE')
    assert.equal(diffResults(base, agentFile(passes(20, [19, 19, 19, 19])), { tolerance: 0.05 }).verdict, 'SAME-WITHIN-NOISE')
    assert.equal(diffResults(base, agentFile(passes(20, [18, 18, 18, 18])), { tolerance: 0.05 }).verdict, 'WORSE')
  })

  test('another model, another arm, one run a side: compared, and said so', () => {
    const d = diffResults(FOUR, agentFile(passes(4, [3, 3, 3, 3]), { model: 'n', experiments: { verifyRound: true } }))
    assert.deepEqual(d.notes, ['different models: m (baseline) vs n (run)', 'different arms: default (baseline) vs experiments: verifyRound (run)'])
    assert.match(d.caveats.join('\n'), /the baseline's passes all come from one run/)
  })

  test('timing is printed and never gated: a slower run holds', () => {
    const timed = (ms: number, ttft: number): Partial<CaseRun> => ({
      ms,
      latencySummary: { rounds: 4, ttftMedianMs: ttft, ttftMaxMs: ttft, prefillMedianMs: ttft, prefillMaxMs: ttft, prefillFrom: 'ttft', decodeTokPerSecMedian: 40, promptTokensMax: 9000, cachedShare: null }
    })
    const d = diffResults(agentFile([[run('a', true, timed(60_000, 1000))]]), agentFile([[run('a', true, timed(120_000, 3000))]]), { minPasses: 1 })
    assert.equal(d.verdict, 'SAME-WITHIN-NOISE')
    assert.deepEqual(
      [row(d, /^median time, solved/).delta, row(d, /^TTFT/).baseline, row(d, /^TTFT/).run, row(d, /^TTFT/).delta],
      ['+100%', '1.0 s', '3.0 s', '+200%']
    )
  })

  test('files that cannot be compared are refused with the reason', () => {
    assert.throws(() => detectSuite({ model: 'm' }), /no "runs" array/)
    assert.throws(() => diffResults(FOUR, { model: 'm', runs: [{ file: '01.json', expect: 'no_tool' }] }), /agent results and the run is toolchoice/)
    assert.throws(() => diffResults(FOUR, agentFile([[run('z', true)]])), /share no scored case/)
  })

  test('sample standard deviation: n − 1, and zero below two values', () => {
    assert.equal(sampleSd([]), 0)
    assert.equal(sampleSd([5]), 0)
    assert.ok(Math.abs(sampleSd([18, 21, 20, 19]) - 1.291) < 1e-3)
  })
})

describe('several runs as one arm', () => {
  test('two two-pass runs merge into four passes from two runs, which the gate can call', () => {
    const a = agentFile(passes(26, [18, 21], { collateral: [2, 1] }))
    const b = agentFile(passes(26, [20, 19], { collateral: [3, 1] }))
    const merged = mergeResults([a, b], ['run1.json', 'run2.json'])
    assert.equal((merged.runs as unknown[]).length, 4)
    assert.deepEqual(merged.merged, { from: ['run1.json', 'run2.json'], passRuns: [0, 0, 1, 1] })
    const d = diffResults(merged, mergeResults([agentFile(passes(26, [14, 16], { collateral: [3, 3] })), agentFile(passes(26, [17, 21], { collateral: [4, 2] }))]))
    assert.deepEqual([d.baseline.passes, d.baseline.runs, d.run.passes, d.run.runs], [4, 2, 4, 2])
    assert.equal(d.verdict, 'SAME-WITHIN-NOISE', formatDiff(d))
    assert.ok(!d.caveats.some((c) => /all come from one run/.test(c)))
  })

  test('slices of one pass (EVAL_CASES ranges) join into one pass, not more passes; overlaps and mismatches are refused', () => {
    const slice = (ids: string[], solved: boolean[], extra: Record<string, unknown> = {}): Record<string, unknown> => agentFile([ids.map((c, i) => run(c, solved[i]!))], extra)
    const joined = joinSlices([slice(['a', 'b'], [true, false]), slice(['c'], [true]), slice(['d', 'e'], [false, true])], ['s1.json', 's2.json', 's3.json'])
    assert.equal((joined.runs as CaseRun[][]).length, 1)
    assert.deepEqual((joined.runs as CaseRun[][])[0]!.map((r) => r.case), ['a', 'b', 'c', 'd', 'e'])
    assert.deepEqual([joined.passes, joined.cases, joined.joined], [1, ['a', 'b', 'c', 'd', 'e'], { from: ['s1.json', 's2.json', 's3.json'] }])
    // Four joined passes are a four-pass arm the gate can call.
    const pass = (k: number): Record<string, unknown> => joinSlices([slice(['a', 'b'], [true, k % 2 === 0]), slice(['c', 'd'], [true, false])])
    const arm = mergeResults([pass(0), pass(1), pass(2), pass(3)])
    assert.deepEqual([diffResults(arm, arm).baseline.passes, diffResults(arm, arm).verdict], [4, 'SAME-WITHIN-NOISE'])
    assert.throws(() => joinSlices([slice(['a'], [true]), slice(['a'], [false])], ['s1', 's2']), /a is in both s1 and s2/)
    assert.throws(() => joinSlices([slice(['a'], [true]), slice(['b'], [true], { experiments: { reviewer: true } })]), /another arm/)
    assert.throws(() => joinSlices([slice(['a'], [true]), agentFile([[run('b', true)], [run('b', true)]])]), /1 passes|2 passes/)
    assert.throws(() => joinSlices([toolsFile([fx('01', true)])]), /only eval:agent/)
  })

  test('runs of another model or another arm do not merge', () => {
    const a = agentFile(passes(4, [3, 3]))
    assert.throws(() => mergeResults([a, agentFile(passes(4, [3, 3]), { model: 'n' })], ['a', 'b']), /cannot merge b \(n\) with a \(m\): another model/)
    assert.throws(() => mergeResults([a, agentFile(passes(4, [3, 3]), { experiments: { planRound: true } })], ['a', 'b']), /another arm/)
    assert.equal(mergeResults([a]), a)
  })

  test('--save stores the spread of every gated line over the merged passes, and which run each pass came from', () => {
    const merged = mergeResults([agentFile(passes(26, [18, 21], { collateral: [2, 1] })), agentFile(passes(26, [20, 19], { collateral: [3, 1] }))])
    const saved = trimForBaseline(merged, ['run1.json', 'run2.json'], new Date('2026-10-01T00:00:00Z'), { noise: true })
    assert.deepEqual(saved.baseline, { from: ['run1.json', 'run2.json'], savedAt: '2026-10-01T00:00:00.000Z', passRuns: [0, 0, 1, 1] })
    assert.equal(saved.merged, undefined)
    const noise = saved.noise as ReturnType<typeof measureNoise>
    assert.deepEqual([noise.passes, noise.runs, noise.cases.length, noise.k, noise.minPasses], [4, 2, 26, 2, 4])
    assert.deepEqual(noise.lines.solved!.perPass, [18, 21, 20, 19])
    assert.ok(Math.abs(noise.lines.solved!.sd - sampleSd([18, 21, 20, 19]) / 26) < 1e-4)
    assert.deepEqual(noise.lines.collateral!.perPass, [2, 1, 3, 1])
    assert.deepEqual(noise.lines.falseClaim!.perPass, [0, 0, 0, 0])
    const d = diffResults(saved, merged)
    assert.equal(d.verdict, 'SAME-WITHIN-NOISE')
    assert.deepEqual([d.baseline.runs, d.caveats[0]], [2, 'baseline spread: stored, from 4 passes in 2 runs'])
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
const toolsFile = (runs: EvalFixtureRun[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({ model: 'm', baseUrl: 'x', ranAt: 'now', arm: 'full', caveats: [], scores: {}, runs, ...extra })

describe('eval:diff on eval:tools results', () => {
  // Four passes, flattened as the runner writes them: 01, 02, 03, then again. 02 flips once.
  const pass = (ok02: boolean): EvalFixtureRun[] => [fx('01', true), fx('02', ok02), noTool('03', false)]
  const base = toolsFile([...pass(true), ...pass(false), ...pass(true), ...pass(true)])

  test('passes are read back from the repeating fixture order; a flip the baseline also had is noise', () => {
    const d = diffResults(base, toolsFile([...pass(false), ...pass(true), ...pass(true), ...pass(true)]))
    assert.equal(d.suite, 'toolchoice')
    assert.equal(d.baseline.passes, 4)
    assert.equal(d.verdict, 'SAME-WITHIN-NOISE')
    assert.equal(row(d, /^clean, stable set \(2; not gated\)$/).baseline, '8/8 (100.0%)')
  })

  test('a spurious call on every pass is WORSE, and a lost stable fixture is named; a server error is excluded', () => {
    const bad = (): EvalFixtureRun[] => [fx('01', false, { error: 'HTTP 500' }), fx('02', true), noTool('03', true)]
    const d = diffResults(base, toolsFile([...bad(), ...bad(), ...bad(), ...bad()]))
    assert.equal(row(d, /^runs excluded/).run, '4')
    assert.deepEqual(d.lost, ['03'])
    assert.equal(d.verdict, 'WORSE')
    assert.match(d.regressions.join('\n'), /^spurious calls \(no-tool fixtures\) rose from 0\.00 to 1\.00 of 1 per pass/m)
  })

  test('invalid arguments and loops on every pass are WORSE — and a flaky fixture failing every pass moves the clean line past its band', () => {
    const p = (): EvalFixtureRun[] => [fx('01', true, { allCalls: [{ name: 'web_search', valid: false, errors: ['query: required'] }] }), fx('02', true, { looped: true }), noTool('03', false)]
    const d = diffResults(base, toolsFile([...p(), ...p(), ...p(), ...p()]))
    assert.deepEqual(
      d.regressions.map((r) => r.split(/ (rose|fell) /)[0]),
      ['clean per pass (3 cases)', 'loops', 'runs with invalid arguments']
    )
  })

  test('one-pass runs merge into passes, and a subset arm does not merge with the full one', () => {
    const one = (ok02: boolean): Record<string, unknown> => toolsFile(pass(ok02))
    const merged = mergeResults([one(true), one(false), one(true), one(true)])
    assert.deepEqual((merged.merged as { passRuns: number[] }).passRuns, [0, 1, 2, 3])
    const d = diffResults(merged, base)
    assert.deepEqual([d.baseline.passes, d.baseline.runs, d.verdict], [4, 4, 'SAME-WITHIN-NOISE'])
    assert.throws(() => mergeResults([one(true), toolsFile(pass(true), { arm: 'subset' })]), /another arm/)
  })
})

// ---- the committed copy --------------------------------------------------------------

test('--save trims a results file to a baseline of the same schema, which diffs clean against the original', () => {
  const full = agentFile([
    [run('a', true, { finalText: 'x'.repeat(4000), check: { exitCode: 0, tail: 'ok '.repeat(500) }, latency: [{ ok: true, ttftMs: 10, prefillMs: 10, prefillFrom: 'ttft', totalMs: 20 }] })]
  ])
  const trimmed = trimForBaseline(full, 'agent-m-2026-09-30T00-00-00.json', new Date('2026-09-30T12:00:00Z'))
  assert.deepEqual(trimmed.baseline, { from: 'agent-m-2026-09-30T00-00-00.json', savedAt: '2026-09-30T12:00:00.000Z' })
  assert.equal(trimmed.noise, undefined)
  const r = (trimmed.runs as CaseRun[][])[0]![0]!
  assert.equal(r.finalText, '')
  assert.equal(r.latency, undefined)
  assert.deepEqual(r.check, { exitCode: 0, tail: '' })
  assert.equal(r.solved, true)
  assert.ok(JSON.stringify(trimmed).length < JSON.stringify(full).length / 4)
  assert.deepEqual(diffResults(trimmed, full, { minPasses: 1 }).regressions, [])
  assert.equal(detectSuite(trimForBaseline(toolsFile([fx('01', true)]), 'f')), 'toolchoice')
})

// ---- which base (v4.4, G1) -------------------------------------------------------------

describe('eval:diff says which base it read (v4.4, G1)', () => {
  const tag = (id: string, role: 'control' | 'arm') => ({ session: { id, role } })
  const control = agentFile(passes(26, [16, 18, 17, 17]), tag('night', 'control'))
  const arm = agentFile(passes(26, [22, 23, 22, 23]), { experiments: { toolsByPhase: true }, ...tag('night', 'arm') })

  test("the arm's own control, tagged by the runner, is the same-day control — and only then can a BETTER turn a switch on", () => {
    const d = diffResults(control, arm)
    assert.equal(d.verdict, 'BETTER')
    assert.deepEqual([d.base.kind, d.sameDay], ['same-day control', true])
    assert.match(formatDiff(d), /^base: the same-day control — session night: every switch off, interleaved with the arm$/m)
    assert.ok(!d.notes.some((n) => /only beside a same-day control/.test(n)))
  })

  test('a committed baseline is another day: the diff says so, and a BETTER against it says it cannot turn a switch on', () => {
    const saved = trimForBaseline(mergeResults([agentFile(passes(26, [16, 18])), agentFile(passes(26, [17, 17]))]), ['a', 'b'], new Date('2026-09-30T12:00:00Z'), { noise: true })
    const d = diffResults(saved, arm)
    assert.deepEqual([d.verdict, d.base.kind, d.sameDay], ['BETTER', 'committed baseline', false])
    assert.match(formatDiff(d), /^base: a committed baseline, saved 2026-09-30 — another day's, not a same-day control$/m)
    assert.match(d.notes.join('\n'), /BETTER against a committed baseline: a switch turns on only beside a same-day control — run the arm with EVAL_CONTROL=1/)
  })

  test('a control from another session, an untagged file, or an arm as the base: not a same-day control', () => {
    const other = diffResults(agentFile(passes(26, [16, 18, 17, 17]), tag('last-night', 'control')), arm)
    assert.deepEqual([other.base.kind, other.sameDay], ['control from another session', false])
    assert.match(other.base.text, /session last-night, not the run's \(arm, session night\)/)
    assert.match(other.notes.join('\n'), /BETTER against another session's control/)
    assert.deepEqual([diffResults(agentFile(passes(26, [16, 18, 17, 17])), arm).base.kind], ['untagged run'])
    assert.match(diffResults(arm, control).base.text, /no session as the control \(it is an arm\)/)
    // A WORSE or a SAME needs no such note: nothing turns on.
    assert.ok(!diffResults(arm, control).notes.some((n) => /same-day control —/.test(n)))
  })

  test('sliced runs of one session join into passes and merge into one side, keeping the session; a control never merges with its arm', () => {
    const slice = (ids: string[], role: 'control' | 'arm', id: string): Record<string, unknown> =>
      agentFile([ids.map((c) => run(c, true))], { ...(role === 'arm' ? { experiments: { toolsByPhase: true } } : {}), ...tag(id, role) })
    const pass = joinSlices([slice(['a', 'b'], 'control', 's1'), slice(['c'], 'control', 's2')])
    assert.deepEqual(pass.session, { ids: ['s1', 's2'], role: 'control' })
    const four = mergeResults([pass, pass, pass, pass])
    assert.deepEqual(four.session, { ids: ['s1', 's2'], role: 'control' })
    const armPass = joinSlices([slice(['a', 'b'], 'arm', 's1'), slice(['c'], 'arm', 's2')])
    const d = diffResults(four, mergeResults([armPass, armPass, armPass, armPass]))
    assert.equal(d.sameDay, true)
    // Untagged in the mix: the merged side is untagged, so not a same-day control.
    assert.equal(mergeResults([pass, agentFile([[run('a', true), run('b', true), run('c', true)]])]).session, undefined)
    assert.throws(() => mergeResults([control, agentFile(passes(26, [1]), tag('night', 'arm'))], ['c.json', 'a.json']), /cannot combine a\.json \(the session's arm\)/)
  })
})

// ---- eval:answers' library suite (v4.4, G5) -----------------------------------------------

const lib = (file: string, answered: boolean, o: { cited?: boolean; unsupported?: string[]; forbidden?: string[]; error?: string } = {}) => ({
  file,
  prompt: file,
  passagesFound: 3,
  ms: 1000,
  ...(o.error ? { error: o.error } : { score: { answered, cited: o.cited ?? answered, unsupported: o.unsupported ?? [], missing: [], forbidden: o.forbidden ?? [] } })
})
/** An eval:answers file as the runner writes it with EVAL_PASSES > 1: `library.passes[].runs`. */
const answersFile = (ps: ReturnType<typeof lib>[][], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: 'm',
  baseUrl: 'x',
  ranAt: 'now',
  cases: 'all',
  library: { passes: ps.map((runs) => ({ summary: {}, runs })), stability: {}, shapes: {} },
  quant: { ignored: true },
  ...extra
})
const libPass = (n: number, answered: number, o: { uncited?: number; forbidden?: number } = {}) =>
  Array.from({ length: n }, (_, i) => lib(`L${i}`, i < answered, { cited: i < answered && i >= (o.uncited ?? 0), forbidden: i < (o.forbidden ?? 0) ? ['stay by the windows'] : [] }))

describe('eval:diff on eval:answers library results (v4.4, G5)', () => {
  const base = answersFile([libPass(28, 27), libPass(28, 26), libPass(28, 27), libPass(28, 27)])

  test('an answers file is the library suite: answered per pass is the gated line, and the other suites in the file are not read', () => {
    assert.equal(detectSuite(base), 'library')
    const d = diffResults(base, base)
    assert.equal(d.suite, 'library')
    assert.equal(d.verdict, 'SAME-WITHIN-NOISE')
    assert.match(formatDiff(d), /^eval:answers \(library\) diff/)
    assert.equal(row(d, /^answered per pass \(28 cases\)$/).baseline, '26.75/28 per pass, σ 0.50 · [27, 26, 27, 27]')
    // A single-pass file (library.runs) reads as one pass.
    assert.equal(diffResults(answersFile([libPass(28, 27)]), { ...base, library: { summary: {}, runs: libPass(28, 27) } }, { minPasses: 1 }).baseline.passes, 1)
  })

  test('cited is better higher; one forbidden assertion is WORSE on any number of passes — never banded, like a false claim', () => {
    const lessCited = diffResults(base, answersFile([libPass(28, 27, { uncited: 10 }), libPass(28, 26, { uncited: 10 }), libPass(28, 27, { uncited: 10 }), libPass(28, 27, { uncited: 10 })]))
    assert.equal(lessCited.verdict, 'WORSE')
    assert.match(lessCited.regressions.join('\n'), /^cited the source fell/m)
    const forbidden = diffResults(base, answersFile([libPass(28, 27, { forbidden: 1 }), libPass(28, 26), libPass(28, 27), libPass(28, 27)]))
    assert.equal(forbidden.verdict, 'WORSE')
    assert.deepEqual(forbidden.regressions, ['asserted forbidden advice rose from 0/112 (0.0%) to 1/112 (0.9%) — never banded: any rise is WORSE'])
  })

  test('an errored case is excluded, not failed; runs of one arm merge, a re-rank arm does not merge with its control', () => {
    const d = diffResults(base, answersFile([[...libPass(27, 26), lib('L27', false, { error: 'HTTP 500' })], libPass(28, 26), libPass(28, 27), libPass(28, 27)]))
    assert.equal(row(d, /^runs excluded/).run, '1')
    const one = (k: number): Record<string, unknown> => answersFile([libPass(28, 26 + (k % 2))], { arm: 'rerank' })
    const merged = mergeResults([one(0), one(1), one(2), one(3)])
    assert.equal(detectSuite(merged), 'library')
    assert.deepEqual([diffResults(base, merged).run.passes, diffResults(base, merged).run.arm], [4, 'rerank'])
    assert.throws(() => mergeResults([base, one(0)]), /another arm/)
    const saved = trimForBaseline(merged, ['a', 'b', 'c', 'd'], new Date('2026-10-02T00:00:00Z'), { noise: true })
    assert.deepEqual([detectSuite(saved), diffResults(saved, merged).verdict], ['library', 'SAME-WITHIN-NOISE'])
  })
})

describe('a floor under a short control\'s spread (v4.4, G1)', () => {
  test('a four-pass control that happens to agree with itself does not narrow the band below a committed baseline\'s spread', () => {
    const tag = (role: 'control' | 'arm') => ({ session: { id: 'night', role } })
    // The control as measured on 2026-10-01 night (σ 0.58 of 26); the arm two lower a pass.
    const control = agentFile(passes(26, [18, 19, 18, 18]), tag('control'))
    const arm = agentFile(passes(26, [16, 17, 15, 16]), { experiments: { toolsByPhase: true }, ...tag('arm') })
    const own = diffResults(control, arm)
    assert.equal(own.verdict, 'WORSE', formatDiff(own))
    // The eight-pass baseline's spread (σ 2.49 of 26) as the floor: the same two cases are inside it.
    const committed = trimForBaseline(mergeResults([ENGINE_41, ENGINE_42]), 'e', new Date('2026-09-30T00:00:00Z'), { noise: true })
    const floored = diffResults(control, arm, { noiseFloor: { noise: committed.noise as ReturnType<typeof measureNoise>, from: 'agent-qwen3.8-9b-distill.json' } })
    assert.equal(floored.verdict, 'SAME-WITHIN-NOISE', formatDiff(floored))
    assert.equal(row(floored, /^solved per pass/).band, '±3.53')
    assert.match(floored.caveats.join('\n'), /spread floored at agent-qwen3\.8-9b-distill\.json's \(solved σ 2\.49 of 26, 8 passes in 2 runs\)/)
    // A floor is a floor: a noisier control keeps its own spread.
    const loud = diffResults(agentFile(passes(26, [12, 24, 14, 22]), tag('control')), arm, { noiseFloor: { noise: committed.noise as ReturnType<typeof measureNoise>, from: 'b' } })
    assert.ok(Number(row(loud, /^solved per pass/).band.slice(1)) > 3.53)
  })
})
