import { summarize, type CaseRun } from './evalHarness'
import { fmtMs, median } from './latency'
import type { EvalFixtureRun } from '../../renderer/src/lib/evalRunner'

/**
 * v4.1 (M2): two eval results, compared — the gate every 4.1 change passes.
 *
 * The roadmap said baselines were "committed and diffed"; they were neither.
 * A baseline is a results file as a runner writes it (or trimmed by `--save`,
 * same schema), kept in baselines/. `npm run eval:diff -- <baseline> <run>`
 * prints one table and exits non-zero when the run is worse on a gated line.
 *
 * What is compared, and why:
 *
 *   - Only the cases both files ran. A run over EVAL_CASES=1-5 is compared
 *     with the baseline's same five, and the ones left out are named.
 *   - The *stable set* is the baseline's cases that did not flip between its
 *     passes. The flaky ones are the suite's measured noise floor
 *     (docs/evals.md, "EVAL_PASSES"), so they are reported and never gated.
 *   - Rates, not counts: a one-pass run and a three-pass baseline differ in
 *     runs, not in what a run means.
 *   - Gated: the stable set's solved rate (clean, for tool choice) may not
 *     drop; false claims, collateral and a dirty Undo (spurious calls, loops
 *     and invalid arguments, for tool choice) may not rise. Timing is printed
 *     and never gated — the machine moves it (v4.1, decision 1).
 *
 * Plain data in, plain text out; the shell is scripts/eval-diff.ts.
 */

export type DiffSuite = 'agent' | 'toolchoice'

/** One scored run of one case, reduced to what the diff reads. `null` flags do not apply to that case. */
interface Outcome {
  ok: boolean
  flags: Record<string, boolean | null>
}

interface Normalized {
  suite: DiffSuite
  model: string
  arm: string
  passes: number
  cases: Map<string, Outcome[]>
  excluded: number
  agentRuns?: CaseRun[][]
}

/** Gated flags per suite, in table order: [key, label]. */
const FLAGS: Record<DiffSuite, [string, string][]> = {
  agent: [
    ['falseClaim', 'false claims'],
    ['collateral', 'collateral'],
    ['undoDirty', 'undo left files']
  ],
  toolchoice: [
    ['spurious', 'spurious calls (no-tool fixtures)'],
    ['looped', 'loops'],
    ['invalidArgs', 'runs with invalid arguments']
  ]
}

const SOLVED_LABEL: Record<DiffSuite, string> = { agent: 'solved', toolchoice: 'clean' }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Which runner wrote this file; throws with the reason when neither did. */
export function detectSuite(file: unknown): DiffSuite {
  if (!isObj(file) || !Array.isArray(file.runs)) throw new Error('not an eval results file: no "runs" array')
  if (file.suite === 'agent' || (file.runs.length > 0 && file.runs.every(Array.isArray))) return 'agent'
  if (file.runs.every((r) => isObj(r) && typeof r.file === 'string' && 'expect' in r)) return 'toolchoice'
  throw new Error('not an eval:agent or eval:tools results file')
}

function armOf(file: Record<string, unknown>): string {
  const x = isObj(file.experiments) ? Object.keys(file.experiments).filter((k) => (file.experiments as Record<string, unknown>)[k]).sort() : []
  if (x.length) return `experiments: ${x.join('+')}`
  if (typeof file.arm === 'string' && file.arm !== 'full') return file.arm
  return 'default'
}

function normalize(file: unknown): Normalized {
  const suite = detectSuite(file)
  const f = file as Record<string, unknown>
  const cases = new Map<string, Outcome[]>()
  const push = (id: string, o: Outcome): void => {
    const list = cases.get(id) ?? []
    list.push(o)
    cases.set(id, list)
  }
  let excluded = 0
  let passes = 0
  let agentRuns: CaseRun[][] | undefined
  if (suite === 'agent') {
    agentRuns = f.runs as CaseRun[][]
    passes = agentRuns.length
    for (const r of agentRuns.flat()) {
      if (r.excluded) {
        excluded++
        continue
      }
      push(r.case, { ok: r.solved, flags: { falseClaim: r.falseClaim, collateral: (r.collateral ?? []).length > 0, undoDirty: r.undo === 'dirty' } })
    }
  } else {
    // eval:tools writes every pass's runs in one flat list, the fixture order
    // repeating: a fixture's nth run belongs to pass n.
    const seen = new Map<string, number>()
    for (const r of f.runs as EvalFixtureRun[]) {
      const n = (seen.get(r.file) ?? 0) + 1
      seen.set(r.file, n)
      passes = Math.max(passes, n)
      if (r.error) {
        excluded++
        continue
      }
      push(r.file, {
        ok: r.correct !== false && !r.spurious && !r.looped,
        flags: {
          spurious: r.expect === 'no_tool' ? r.spurious === true : null,
          looped: r.looped,
          invalidArgs: (r.allCalls ?? []).some((c) => !c.valid)
        }
      })
    }
  }
  return { suite, model: typeof f.model === 'string' ? f.model : '?', arm: armOf(f), passes, cases, excluded, agentRuns }
}

type Stability = 'stable-pass' | 'stable-fail' | 'flaky'
const stability = (os: Outcome[]): Stability => (os.every((o) => o.ok) ? 'stable-pass' : os.some((o) => o.ok) ? 'flaky' : 'stable-fail')

export interface DiffRow {
  metric: string
  baseline: string
  run: string
  delta: string
  verdict: 'held' | 'better' | 'WORSE' | ''
}

export interface DiffResult {
  suite: DiffSuite
  baseline: { model: string; arm: string; passes: number }
  run: { model: string; arm: string; passes: number }
  rows: DiffRow[]
  /** Gated lines that got worse, in words. Empty: the run holds. */
  regressions: string[]
  /** Stable-pass cases in the baseline that failed at least once in the run. */
  lost: string[]
  /** Stable-fail cases in the baseline that the run solved at least once. */
  gained: string[]
  notes: string[]
}

export interface DiffOptions {
  /** Solved-rate drop, as a fraction, that still holds (default 0). */
  tolerance?: number
}

const pct = (hit: number, of: number): string => (of === 0 ? '—' : `${hit}/${of} (${((hit / of) * 100).toFixed(1)}%)`)
const rate = (hit: number, of: number): number | null => (of === 0 ? null : hit / of)
const pp = (a: number | null, b: number | null): string => (a === null || b === null ? '—' : `${b - a >= 0 ? '+' : ''}${((b - a) * 100).toFixed(1)} pp`)

/** Compare a run with a baseline. Throws when the two cannot be compared at all. */
export function diffResults(baselineFile: unknown, runFile: unknown, opts: DiffOptions = {}): DiffResult {
  const base = normalize(baselineFile)
  const run = normalize(runFile)
  if (base.suite !== run.suite) throw new Error(`the baseline is ${base.suite} results and the run is ${run.suite}: nothing to compare`)
  const suite = base.suite
  const tolerance = Math.max(0, opts.tolerance ?? 0)
  const notes: string[] = []
  const regressions: string[] = []
  const rows: DiffRow[] = []

  if (base.model !== run.model) notes.push(`different models: ${base.model} (baseline) vs ${run.model} (run)`)
  if (base.arm !== run.arm) notes.push(`different arms: ${base.arm} (baseline) vs ${run.arm} (run)`)
  const common = [...base.cases.keys()].filter((c) => run.cases.has(c)).sort()
  const onlyBase = [...base.cases.keys()].filter((c) => !run.cases.has(c)).sort()
  const onlyRun = [...run.cases.keys()].filter((c) => !base.cases.has(c)).sort()
  if (onlyBase.length) notes.push(`not in the run, not compared: ${onlyBase.join(', ')}`)
  if (onlyRun.length) notes.push(`not in the baseline, not compared: ${onlyRun.join(', ')}`)
  if (common.length === 0) throw new Error('the two files share no scored case')
  if (base.passes < 2) notes.push('the baseline has one pass, so no noise floor was measured: every case counts as stable')

  const stable = common.filter((c) => stability(base.cases.get(c)!) !== 'flaky')
  const flaky = common.filter((c) => stability(base.cases.get(c)!) === 'flaky')
  const tally = (n: Normalized, ids: string[]): { hit: number; of: number } => {
    const os = ids.flatMap((c) => n.cases.get(c)!)
    return { hit: os.filter((o) => o.ok).length, of: os.length }
  }

  // The gate's first line: the stable set's solved rate.
  const bs = tally(base, stable)
  const rs = tally(run, stable)
  const bRate = rate(bs.hit, bs.of)
  const rRate = rate(rs.hit, rs.of)
  const dropped = bRate !== null && rRate !== null && rRate < bRate - tolerance - 1e-9
  rows.push({
    metric: `${SOLVED_LABEL[suite]}, stable set (${stable.length} case${stable.length === 1 ? '' : 's'})`,
    baseline: pct(bs.hit, bs.of),
    run: pct(rs.hit, rs.of),
    delta: pp(bRate, rRate),
    verdict: bRate === null || rRate === null ? '' : dropped ? 'WORSE' : rRate > bRate ? 'better' : 'held'
  })
  if (dropped) regressions.push(`the stable set's ${SOLVED_LABEL[suite]} rate fell from ${pct(bs.hit, bs.of)} to ${pct(rs.hit, rs.of)}${tolerance ? ` (tolerance ${(tolerance * 100).toFixed(1)} pp)` : ''}`)
  const bf = tally(base, flaky)
  const rf = tally(run, flaky)
  if (flaky.length) {
    rows.push({ metric: `${SOLVED_LABEL[suite]}, flaky in the baseline (${flaky.length}; not gated)`, baseline: pct(bf.hit, bf.of), run: pct(rf.hit, rf.of), delta: pp(rate(bf.hit, bf.of), rate(rf.hit, rf.of)), verdict: '' })
  }

  // The flags that may not rise, over every common case: a false claim on a
  // flaky case is still a false claim.
  for (const [key, label] of FLAGS[suite]) {
    const count = (n: Normalized): { hit: number; of: number } => {
      const vals = common.flatMap((c) => n.cases.get(c)!.map((o) => o.flags[key])).filter((v): v is boolean => v !== null && v !== undefined)
      return { hit: vals.filter(Boolean).length, of: vals.length }
    }
    const b = count(base)
    const r = count(run)
    const br = rate(b.hit, b.of)
    const rr = rate(r.hit, r.of)
    const rose = br !== null && rr !== null && rr > br + 1e-9
    rows.push({ metric: label, baseline: pct(b.hit, b.of), run: pct(r.hit, r.of), delta: pp(br, rr), verdict: br === null || rr === null ? '' : rose ? 'WORSE' : rr < br ? 'better' : 'held' })
    if (rose) regressions.push(`${label} rose from ${pct(b.hit, b.of)} to ${pct(r.hit, r.of)}`)
  }

  rows.push({ metric: 'runs excluded (server failures)', baseline: String(base.excluded), run: String(run.excluded), delta: '', verdict: '' })

  // Timing: printed, never gated.
  if (suite === 'agent' && base.agentRuns && run.agentRuns) {
    const keep = new Set(common)
    const only = (runs: CaseRun[][]): CaseRun[][] => runs.map((p) => p.filter((r) => keep.has(r.case)))
    const sb = summarize(base.model, only(base.agentRuns))
    const sr = summarize(run.model, only(run.agentRuns))
    const timed = (runs: CaseRun[][]): CaseRun[] => only(runs).flat().filter((r) => !r.excluded && !r.machine && r.latencySummary)
    const med = (xs: (number | null | undefined)[]): number | null => {
      const n = xs.filter((x): x is number => typeof x === 'number')
      return n.length ? median(n) : null
    }
    const ttft = (runs: CaseRun[][]): number | null => med(timed(runs).map((r) => r.latencySummary!.ttftMedianMs))
    const tps = (runs: CaseRun[][]): number | null => med(timed(runs).map((r) => r.latencySummary!.decodeTokPerSecMedian))
    const rel = (a: number | null, b: number | null): string => (a === null || b === null || a === 0 ? '' : `${b >= a ? '+' : ''}${(((b - a) / a) * 100).toFixed(0)}%`)
    const sec = (ms: number | null): string => (ms === null ? '—' : `${(ms / 1000).toFixed(0)} s`)
    rows.push({ metric: 'median time, solved (not gated)', baseline: sec(sb.msPerSolvedMedian), run: sec(sr.msPerSolvedMedian), delta: rel(sb.msPerSolvedMedian, sr.msPerSolvedMedian), verdict: '' })
    rows.push({ metric: 'median rounds (not gated)', baseline: String(sb.roundsMedian), run: String(sr.roundsMedian), delta: '', verdict: '' })
    const bt = ttft(base.agentRuns)
    const rt = ttft(run.agentRuns)
    if (bt !== null || rt !== null) rows.push({ metric: 'TTFT, median of runs (not gated)', baseline: fmtMs(bt), run: fmtMs(rt), delta: rel(bt, rt), verdict: '' })
    const bd = tps(base.agentRuns)
    const rd = tps(run.agentRuns)
    if (bd !== null || rd !== null) rows.push({ metric: 'decode tok/s, median of runs (not gated)', baseline: bd === null ? '—' : String(bd), run: rd === null ? '—' : String(rd), delta: rel(bd, rd), verdict: '' })
  }

  const lost = stable.filter((c) => stability(base.cases.get(c)!) === 'stable-pass' && run.cases.get(c)!.some((o) => !o.ok))
  const gained = stable.filter((c) => stability(base.cases.get(c)!) === 'stable-fail' && run.cases.get(c)!.some((o) => o.ok))

  return {
    suite,
    baseline: { model: base.model, arm: base.arm, passes: base.passes },
    run: { model: run.model, arm: run.arm, passes: run.passes },
    rows,
    regressions,
    lost,
    gained,
    notes
  }
}

export function formatDiff(d: DiffResult): string {
  const lines: string[] = []
  lines.push(`eval:${d.suite === 'agent' ? 'agent' : 'tools'} diff · baseline ${d.baseline.model} (${d.baseline.arm}, ${d.baseline.passes} pass${d.baseline.passes === 1 ? '' : 'es'}) → run ${d.run.model} (${d.run.arm}, ${d.run.passes} pass${d.run.passes === 1 ? '' : 'es'})`)
  lines.push('')
  lines.push('| | baseline | run | Δ | |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const r of d.rows) lines.push(`| ${r.metric} | ${r.baseline} | ${r.run} | ${r.delta} | ${r.verdict === 'WORSE' ? '**WORSE**' : r.verdict} |`)
  lines.push('')
  if (d.lost.length) lines.push(`stable-pass in the baseline, failed in the run: ${d.lost.join(', ')}`)
  if (d.gained.length) lines.push(`stable-fail in the baseline, solved in the run: ${d.gained.join(', ')}`)
  for (const n of d.notes) lines.push(`note: ${n}`)
  lines.push(d.regressions.length ? `REGRESSION: ${d.regressions.join('; ')}` : 'held: no gated line got worse')
  return lines.join('\n')
}

/**
 * The trimmed copy `--save` writes to baselines/: the same schema, minus what
 * only a reader of one failure needs (the report text, the check's output, each
 * round's timing — the per-run summary stays). Small enough to review in a diff.
 */
export function trimForBaseline(file: unknown, from: string, savedAt: Date = new Date()): Record<string, unknown> {
  const suite = detectSuite(file)
  const f = file as Record<string, unknown>
  const runs =
    suite === 'agent'
      ? (f.runs as CaseRun[][]).map((pass) =>
          pass.map((r) => {
            const { finalText: _t, latency: _l, check, ...rest } = r
            return { ...rest, ...(check ? { check: { exitCode: check.exitCode, tail: '' } } : {}), finalText: '' }
          })
        )
      : (f.runs as EvalFixtureRun[]).map((r) => ({ ...r, allCalls: (r.allCalls ?? []).map((c) => ({ name: c.name, valid: c.valid, errors: [] })) }))
  return { ...f, baseline: { from, savedAt: savedAt.toISOString() }, runs }
}
