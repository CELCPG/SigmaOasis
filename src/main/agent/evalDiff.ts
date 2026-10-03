import { CLAIMS_RULE } from './claims'
import { summarize, type CaseRun } from './evalHarness'
import { fmtMs, median } from './latency'
import type { EvalFixtureRun } from '../../renderer/src/lib/evalRunner'
import { LIBRARY_SCORER_RULE, type LibraryCaseResult } from '../../renderer/src/lib/answerEval'
import { combineSessions, readSession, type MergedSession } from './evalSession'

/**
 * v4.1 (M2), v4.3: two eval results, compared — the gate every change passes.
 *
 * The roadmap said baselines were "committed and diffed"; they were neither.
 * A baseline is a results file as a runner writes it (or trimmed by `--save`,
 * same schema), kept in baselines/. `npm run eval:diff -- <baseline> <run>`
 * prints one table and a verdict: BETTER, SAME-WITHIN-NOISE or WORSE.
 *
 * Why 4.3 changed it. 4.1's gate compared the *stable set* — the baseline's
 * cases that did not flip between its passes — and called any drop WORSE. On
 * 2026-09-30 the same engine, unchanged, scored single passes from 14 to 21 of
 * 26 on the 9B (temperature 0; LM Studio's MTP drafting and prompt-cache reuse
 * make greedy decoding path-dependent), and the two-pass stable-set gate
 * called an unchanged engine WORSE. Two passes cannot tell a stable case from
 * a lucky one. So:
 *
 *   - **At least four passes per arm** (`MIN_PASSES`). Below that the verdict
 *     is TOO-FEW-PASSES and no banded line is called. Several runs merge into
 *     one arm (`mergeResults`), and should: passes of one run share the
 *     server's state, and on 9/30 two runs of the same code differed by four
 *     cases in their means.
 *   - **A noise band from the measured spread.** Each gated line is a per-pass
 *     rate over the cases both arms ran. The baseline's pass-to-pass standard
 *     deviation σb is measured when it is saved and stored in it (`noise`);
 *     the run's own σr is measured here, and never taken as smaller than σb —
 *     four passes that happen to agree do not prove a quieter engine. The band
 *     is NOISE_K standard errors of the difference of the two means:
 *
 *         band = 2 · √(σb²/nb + max(σr, σb)²/nr)
 *
 *     A line moved beyond its band is BETTER or WORSE; inside it, SAME-WITHIN-
 *     NOISE. The table prints the band beside every delta, so a reader sees
 *     how large a change the passes could have resolved.
 *   - **False claims are never banded.** Any rise is WORSE, however few the
 *     passes: it is the one thing the gate never trades (ROADMAP-v4.1.md).
 *   - Only the cases both files ran are compared, and the rest are named.
 *   - The stable set and the flaky cases are still reported — the cases a
 *     run lost or gained are where to look — but no longer gated.
 *   - Timing is printed and never gated: the machine moves it (v4.1,
 *     decision 1).
 *
 * v4.4 (G1): **which base.** Every diff says what it compared against: a
 * same-day control (the engine with every switch off, run in the arm's own
 * session and interleaved with it — evalSession.ts), a committed baseline
 * (another day's), or another results file. A BETTER against anything but a
 * same-day control says that it cannot turn a switch on.
 *
 * v4.4 (G5): **the library suite.** `eval:answers`' library results (the
 * `library` block of an answers file) are a third suite: answered per pass
 * is the gated line, then cited (higher is better), unsupported figures, and
 * forbidden advice — never banded, like a false claim: a library answer that
 * asserts what a case forbids is the unsafe advice the suite exists to catch.
 *
 * v4.5 (H3b): **one claim rule on both sides.** The false-claim line, and a
 * needs-you case's solved, are scored by the claim rule in claims.ts, and a
 * results file records the version its flags were scored under (`claimsRule`;
 * none = rule 1, 4.4's). A diff of two files scored under different rules would
 * call a change of rule a change of engine — the 4.4 rule's six wrong marks in
 * eleven made a one-clause difference a WORSE — so it is refused (exit 2), and
 * so is a merge or a join of them. `npm run eval:claims -- --rescore <file>`
 * moves a file to the current rule (the baselines were moved this way: they
 * carry no reports, so the reports were read from the full results they were
 * trimmed from). False claims stay never banded; what changed is how few of
 * the marks they count are the detector's.
 *
 * v4.6 (J3): **one library scorer on both sides.** A library results file
 * records the version of the scorer its answered / forbidden flags were scored
 * by (`libraryScorerRule`; none = 1, the scorer that read a reply exactly as
 * the model wrote it). Rule 2 reads Unicode spaces, dashes and quotes as their
 * plain forms (answerEval.ts `normalizeReply`) — the sample answer's four
 * "June 15" replies were scored missing for a narrow no-break space — so a file
 * scored by rule 1 and one scored by rule 2 are refused (exit 2), and so is a
 * merge of them. `npm run eval:library-rescore` moves a file to the current one.
 *
 * Plain data in, plain text out; the shell is scripts/eval-diff.ts.
 */

export type DiffSuite = 'agent' | 'toolchoice' | 'library'
export type LineVerdict = 'BETTER' | 'SAME-WITHIN-NOISE' | 'WORSE' | ''
export type Verdict = 'BETTER' | 'SAME-WITHIN-NOISE' | 'WORSE' | 'TOO-FEW-PASSES'

/** Passes per arm the gate needs before it calls a banded line (v4.3). */
export const MIN_PASSES = 4
/** The band's width in standard errors of the difference of the two arms' means (v4.3). */
export const NOISE_K = 2

/** One scored run of one case, reduced to what the diff reads. `null` flags do not apply to that case. */
interface Outcome {
  ok: boolean
  flags: Record<string, boolean | null>
}

/** One gated line's spread, as `--save` stores it in a baseline. Rates are per pass, 0–1. */
export interface NoiseLine {
  /** Hits per pass (solved cases; runs with the flag). */
  perPass: number[]
  /** Scored runs per pass the rate is over. */
  of: number[]
  mean: number
  /** Sample standard deviation of the per-pass rate. */
  sd: number
  /** The band a MIN_PASSES-pass run with no more spread than this one would get. */
  band: number
}

export interface StoredNoise {
  rule: string
  k: number
  minPasses: number
  passes: number
  runs: number
  /** The cases the spread was measured over; a comparison on other cases re-derives it. */
  cases: string[]
  lines: Record<string, NoiseLine>
}

interface Normalized {
  suite: DiffSuite
  model: string
  arm: string
  /** Per pass: case → outcome. Excluded runs are absent. */
  passes: Map<string, Outcome>[]
  /** How many separate runs (results files) the passes came from. */
  runs: number
  cases: Map<string, Outcome[]>
  excluded: number
  agentRuns?: CaseRun[][]
  /** v4.5 (H3b): the claim rule the agent flags were scored under; null for the other suites. */
  claimsRule: number | null
  /** v4.6 (J3): the version of the library scorer the flags were scored by; null for the other suites. */
  libraryRule: number | null
  noise?: StoredNoise
  /** v4.4 (G1): the session(s) the passes were measured in, and the side; null when untagged. */
  session: MergedSession | null
  /** v4.4 (G1): when `--save` committed it as a baseline. */
  savedAt?: string
}

/** The line every suite gates first; then its flags, [key, label, higher is better]. */
const SOLVED = 'solved'
const FLAGS: Record<DiffSuite, ([string, string] | [string, string, boolean])[]> = {
  agent: [
    ['falseClaim', 'false claims'],
    ['collateral', 'collateral'],
    ['undoDirty', 'undo left files']
  ],
  toolchoice: [
    ['spurious', 'spurious calls (no-tool fixtures)'],
    ['looped', 'loops'],
    ['invalidArgs', 'runs with invalid arguments']
  ],
  library: [
    ['cited', 'cited the source', true],
    ['unsupported', 'unsupported figures'],
    ['forbidden', 'asserted forbidden advice']
  ]
}
/** Flags compared without a band: any rise is WORSE. */
const NEVER_BANDED = new Set(['falseClaim', 'forbidden'])

const SOLVED_LABEL: Record<DiffSuite, string> = { agent: 'solved', toolchoice: 'clean', library: 'answered' }
const SUITE_NAME: Record<DiffSuite, string> = { agent: 'eval:agent', toolchoice: 'eval:tools', library: 'eval:answers (library)' }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Which runner wrote this file; throws with the reason when neither did. */
export function detectSuite(file: unknown): DiffSuite {
  // v4.4 (G5): an eval:answers file with a library block — one pass's runs, or several passes'.
  if (isObj(file) && isObj(file.library) && (Array.isArray(file.library.runs) || Array.isArray(file.library.passes))) return 'library'
  if (!isObj(file) || !Array.isArray(file.runs)) throw new Error('not an eval results file: no "runs" array')
  if (file.suite === 'agent' || (file.runs.length > 0 && file.runs.every(Array.isArray))) return 'agent'
  if (file.runs.every((r) => isObj(r) && typeof r.file === 'string' && 'expect' in r)) return 'toolchoice'
  throw new Error('not an eval:agent, eval:tools or eval:answers (library) results file')
}

/** v4.4 (G5): the library block's passes, each a list of case results. */
function libraryPasses(file: Record<string, unknown>): LibraryCaseResult[][] {
  const lib = file.library as { runs?: LibraryCaseResult[]; passes?: { runs: LibraryCaseResult[] }[] }
  return Array.isArray(lib.passes) ? lib.passes.map((p) => p.runs ?? []) : [lib.runs ?? []]
}

function armOf(file: Record<string, unknown>): string {
  const x = isObj(file.experiments) ? Object.keys(file.experiments).filter((k) => (file.experiments as Record<string, unknown>)[k]).sort() : []
  if (x.length) return `experiments: ${x.join('+')}`
  if (typeof file.arm === 'string' && file.arm !== 'full') return file.arm
  return 'default'
}

/** eval:tools writes every pass in one flat list, the fixture order repeating: a fixture's nth run belongs to pass n. */
function toolPasses(runs: EvalFixtureRun[]): EvalFixtureRun[][] {
  const seen = new Map<string, number>()
  const passes: EvalFixtureRun[][] = []
  for (const r of runs) {
    const n = seen.get(r.file) ?? 0
    seen.set(r.file, n + 1)
    ;(passes[n] ??= []).push(r)
  }
  return passes
}

/** Separate runs behind a file's passes: a merged run's or saved baseline's `passRuns`, else one. */
function runsOf(f: Record<string, unknown>): number {
  const m = isObj(f.merged) ? f.merged : isObj(f.baseline) ? f.baseline : null
  const pr = m && Array.isArray(m.passRuns) ? (m.passRuns as unknown[]) : null
  return pr && pr.length ? new Set(pr).size : 1
}

function normalize(file: unknown): Normalized {
  const suite = detectSuite(file)
  const f = file as Record<string, unknown>
  const cases = new Map<string, Outcome[]>()
  const passes: Map<string, Outcome>[] = []
  let excluded = 0
  let agentRuns: CaseRun[][] | undefined
  const record = (pass: Map<string, Outcome>, id: string, o: Outcome): void => {
    pass.set(id, o)
    const list = cases.get(id) ?? []
    list.push(o)
    cases.set(id, list)
  }
  if (suite === 'agent') {
    agentRuns = f.runs as CaseRun[][]
    for (const p of agentRuns) {
      const pass = new Map<string, Outcome>()
      for (const r of p) {
        if (r.excluded) {
          excluded++
          continue
        }
        record(pass, r.case, { ok: r.solved, flags: { falseClaim: r.falseClaim, collateral: (r.collateral ?? []).length > 0, undoDirty: r.undo === 'dirty' } })
      }
      passes.push(pass)
    }
  } else if (suite === 'library') {
    for (const p of libraryPasses(f)) {
      const pass = new Map<string, Outcome>()
      for (const r of p) {
        if (r.error || !r.score) {
          excluded++
          continue
        }
        record(pass, r.file, {
          ok: r.score.answered,
          flags: { cited: r.score.cited, unsupported: r.score.unsupported.length > 0, forbidden: (r.score.forbidden ?? []).length > 0 }
        })
      }
      passes.push(pass)
    }
  } else {
    for (const p of toolPasses(f.runs as EvalFixtureRun[])) {
      const pass = new Map<string, Outcome>()
      for (const r of p) {
        if (r.error) {
          excluded++
          continue
        }
        record(pass, r.file, {
          ok: r.correct !== false && !r.spurious && !r.looped,
          flags: {
            spurious: r.expect === 'no_tool' ? r.spurious === true : null,
            looped: r.looped,
            invalidArgs: (r.allCalls ?? []).some((c) => !c.valid)
          }
        })
      }
      passes.push(pass)
    }
  }
  const noise = isObj(f.noise) && isObj(f.noise.lines) && Array.isArray(f.noise.cases) ? (f.noise as unknown as StoredNoise) : undefined
  const savedAt = isObj(f.baseline) && typeof f.baseline.savedAt === 'string' ? f.baseline.savedAt : undefined
  return { suite, model: typeof f.model === 'string' ? f.model : '?', arm: armOf(f), passes, runs: runsOf(f), cases, excluded, agentRuns, claimsRule: suite === 'agent' ? claimsRuleOf(f) : null, libraryRule: suite === 'library' ? libraryScorerRuleOf(f) : null, noise, session: readSession(f), savedAt }
}

/** The claim rule an agent results file's flags were scored under; a file that does not say was scored under rule 1. */
export function claimsRuleOf(file: unknown): number {
  return isObj(file) && typeof file.claimsRule === 'number' ? file.claimsRule : 1
}

function sameClaimsRule(what: string, a: { rule: number; name: string }, b: { rule: number; name: string }): void {
  if (a.rule === b.rule) return
  throw new Error(
    `${a.name} was scored under claims rule ${a.rule} and ${b.name} under rule ${b.rule}: its false claims (and a needs-you case's solved) are not read the same way, so ${what} would call a change of rule a change of engine. ` +
      `Move the older one first: npm run eval:claims -- <results folders> --rescore <file> --write (current rule: ${CLAIMS_RULE})`
  )
}

/** The version of the library scorer a library results file's flags were scored by; a file that does not say was scored by rule 1. */
export function libraryScorerRuleOf(file: unknown): number {
  return isObj(file) && typeof file.libraryScorerRule === 'number' ? file.libraryScorerRule : 1
}

function sameLibraryScorer(what: string, a: { rule: number; name: string }, b: { rule: number; name: string }): void {
  if (a.rule === b.rule) return
  throw new Error(
    `${a.name} was scored under library scorer rule ${a.rule} and ${b.name} under rule ${b.rule}: its answered and forbidden flags are not read the same way (rule 2 reads Unicode spaces, dashes and quotes as plain ones), so ${what} would call a change of scorer a change of engine. ` +
      `Move the older one first: npm run eval:library-rescore -- <file> --write (current rule: ${LIBRARY_SCORER_RULE})`
  )
}

// ---- which base (v4.4, G1) -----------------------------------------------------------

export type BaseKind = 'same-day control' | 'committed baseline' | 'control from another session' | 'untagged run'

/** What the base of a diff is, in words — and whether it is the run's own same-day control. */
export function describeBase(base: { session: MergedSession | null; savedAt?: string }, run: { session: MergedSession | null }): { kind: BaseKind; sameDay: boolean; text: string } {
  const ids = (x: MergedSession): string => x.ids.join(', ')
  if (base.savedAt) return { kind: 'committed baseline', sameDay: false, text: `a committed baseline, saved ${base.savedAt.slice(0, 10)} — another day's, not a same-day control` }
  const b = base.session
  const r = run.session
  if (b && b.role === 'control') {
    const same = r !== null && r.role === 'arm' && r.ids.length === b.ids.length && r.ids.every((id) => b.ids.includes(id))
    if (same) return { kind: 'same-day control', sameDay: true, text: `the same-day control — session ${ids(b)}: every switch off, interleaved with the arm` }
    return { kind: 'control from another session', sameDay: false, text: `a control from session ${ids(b)}, not the run's (${r ? `${r.role}, session ${ids(r)}` : 'untagged'}) — not a same-day control` }
  }
  return { kind: 'untagged run', sameDay: false, text: `a results file with no session${b ? ` as the control (it is an ${b.role})` : ''} — not a same-day control` }
}

// ---- statistics ----------------------------------------------------------------------

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

/** Sample standard deviation (n − 1); zero for fewer than two values. */
export function sampleSd(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))
}

interface PassTally {
  hit: number
  of: number
}

/** A line's hits per pass over `ids`; passes that scored none of them are left out. */
function perPass(n: Normalized, ids: ReadonlySet<string>, key: string): PassTally[] {
  const out: PassTally[] = []
  for (const pass of n.passes) {
    let hit = 0
    let of = 0
    for (const [id, o] of pass) {
      if (!ids.has(id)) continue
      const v = key === SOLVED ? o.ok : o.flags[key]
      if (v === null || v === undefined) continue
      of++
      if (v) hit++
    }
    if (of > 0) out.push({ hit, of })
  }
  return out
}

const rates = (t: PassTally[]): number[] => t.map((x) => x.hit / x.of)

/**
 * The band for one line: `k` standard errors of the difference of the two
 * arms' mean per-pass rates, the run's spread floored at the baseline's.
 */
export function noiseBand(baseRates: number[], runRates: number[], baseSd?: number, k: number = NOISE_K): { delta: number; band: number; sdBase: number; sdRun: number } {
  const sdBase = baseSd ?? sampleSd(baseRates)
  const sdRun = Math.max(sampleSd(runRates), sdBase)
  const se = Math.sqrt((sdBase * sdBase) / Math.max(1, baseRates.length) + (sdRun * sdRun) / Math.max(1, runRates.length))
  return { delta: mean(runRates) - mean(baseRates), band: k * se, sdBase, sdRun }
}

/** Passes per arm that bring the band down to `target` (a rate) at spread `sd`. */
export function passesToResolve(sd: number, target: number, k: number = NOISE_K): number {
  if (sd <= 0) return 1
  return Math.ceil(2 * ((k * sd) / target) ** 2)
}

// ---- the diff --------------------------------------------------------------------------

export interface DiffRow {
  metric: string
  baseline: string
  run: string
  delta: string
  /** The noise band the delta is read against; empty on lines that are not banded. */
  band: string
  verdict: LineVerdict
}

export interface DiffResult {
  suite: DiffSuite
  verdict: Verdict
  /** Passes per arm this diff needed to call a banded line. */
  minPasses: number
  baseline: { model: string; arm: string; passes: number; runs: number }
  run: { model: string; arm: string; passes: number; runs: number }
  /** v4.4 (G1): what the base was, in words, and whether it is the run's same-day control. */
  base: { kind: BaseKind; text: string }
  /** v4.4 (G1): only a diff against a same-day control can turn a switch on. */
  sameDay: boolean
  /** v4.5 (H3b): the claim rule both sides' false claims were scored under; null for the suites that have none. */
  claimsRule: number | null
  /** v4.6 (J3): the version of the library scorer both sides were scored by; null for the other suites. */
  libraryRule: number | null
  rows: DiffRow[]
  /** Gated lines that got worse beyond their band (at all, for false claims), in words. Empty: no WORSE. */
  regressions: string[]
  /** Gated lines that got better beyond their band. */
  improvements: string[]
  /** Stable-pass cases in the baseline that failed at least once in the run. */
  lost: string[]
  /** Stable-fail cases in the baseline that the run solved at least once. */
  gained: string[]
  /** What makes the two files less than comparable: other models, arms, cases. */
  notes: string[]
  /** How the band was arrived at, and what limits it. */
  caveats: string[]
}

export interface DiffOptions {
  /** Extra solved-rate drop, as a fraction, that still holds — added to the band (default 0). */
  tolerance?: number
  /**
   * Passes per arm needed to call a banded line (default MIN_PASSES). A scripted
   * replay is deterministic — its spread is zero by construction — and may pass 1.
   */
  minPasses?: number
  /** Standard errors the band spans (default NOISE_K). */
  k?: number
  /**
   * v4.4 (G1): a spread no side may be read as quieter than — a committed
   * baseline's stored noise. A four-pass same-day control measures its own σ
   * from four numbers. On 2026-10-01 night the 9B's control read 18, 19, 18 —
   * σ 0.58 of 26 — after three passes, where the eight-pass baseline holds
   * 2.49; its fourth pass scored 13. A band built on the smaller figure calls
   * a change the engine's own noise can make.
   */
  noiseFloor?: { noise: StoredNoise; from: string }
}

type Stability = 'stable-pass' | 'stable-fail' | 'flaky'
const stability = (os: Outcome[]): Stability => (os.every((o) => o.ok) ? 'stable-pass' : os.some((o) => o.ok) ? 'flaky' : 'stable-fail')

const pct = (hit: number, of: number): string => (of === 0 ? '—' : `${hit}/${of} (${((hit / of) * 100).toFixed(1)}%)`)
const pp = (a: number | null, b: number | null): string => (a === null || b === null ? '—' : `${b - a >= 0 ? '+' : ''}${((b - a) * 100).toFixed(1)} pp`)
const f2 = (x: number): string => x.toFixed(2)
const signed = (x: number): string => `${x >= 0 ? '+' : '−'}${f2(Math.abs(x))}`
const total = (t: PassTally[]): PassTally => ({ hit: t.reduce((a, x) => a + x.hit, 0), of: t.reduce((a, x) => a + x.of, 0) })
/** The scale a per-pass rate is shown at: the runs a pass usually scores on that line. */
const scaleOf = (t: PassTally[]): number => (t.length ? median(t.map((x) => x.of)) : 0)

/** Compare a run with a baseline. Throws when the two cannot be compared at all. */
export function diffResults(baselineFile: unknown, runFile: unknown, opts: DiffOptions = {}): DiffResult {
  const base = normalize(baselineFile)
  const run = normalize(runFile)
  if (base.suite !== run.suite) throw new Error(`the baseline is ${base.suite} results and the run is ${run.suite}: nothing to compare`)
  const suite = base.suite
  if (base.libraryRule !== null && run.libraryRule !== null) sameLibraryScorer('the diff', { rule: base.libraryRule, name: 'the baseline' }, { rule: run.libraryRule, name: 'the run' })
  if (base.claimsRule !== null && run.claimsRule !== null) sameClaimsRule('the diff', { rule: base.claimsRule, name: 'the baseline' }, { rule: run.claimsRule, name: 'the run' })
  const tolerance = Math.max(0, opts.tolerance ?? 0)
  const minPasses = Math.max(1, Math.round(opts.minPasses ?? MIN_PASSES))
  const k = opts.k ?? NOISE_K
  const notes: string[] = []
  const caveats: string[] = []
  const regressions: string[] = []
  const improvements: string[] = []
  const rows: DiffRow[] = []
  // v4.5 (H3b): what a BETTER rests on — a banded line moved beyond its band, or only a never-banded line fell.
  let bandedBetter = false
  let neverBandedFall = ''

  if (base.model !== run.model) notes.push(`different models: ${base.model} (baseline) vs ${run.model} (run)`)
  if (base.arm !== run.arm) notes.push(`different arms: ${base.arm} (baseline) vs ${run.arm} (run)`)
  const common = [...base.cases.keys()].filter((c) => run.cases.has(c)).sort()
  const onlyBase = [...base.cases.keys()].filter((c) => !run.cases.has(c)).sort()
  const onlyRun = [...run.cases.keys()].filter((c) => !base.cases.has(c)).sort()
  if (onlyBase.length) notes.push(`not in the run, not compared: ${onlyBase.join(', ')}`)
  if (onlyRun.length) notes.push(`not in the baseline, not compared: ${onlyRun.join(', ')}`)
  if (common.length === 0) throw new Error('the two files share no scored case')
  const ids = new Set(common)

  const enough = base.passes.length >= minPasses && run.passes.length >= minPasses
  if (!enough) {
    const short = [base.passes.length < minPasses ? `the baseline has ${base.passes.length}` : '', run.passes.length < minPasses ? `the run has ${run.passes.length}` : ''].filter(Boolean).join(' and ')
    caveats.push(`the gate needs ${minPasses} passes per arm to call a line by its noise band; ${short} — rerun with EVAL_PASSES=${minPasses}, or merge more runs, and diff again`)
  }

  // The stored band applies when this comparison covers the cases it was measured on.
  const stored = base.noise && base.noise.cases.length === common.length && base.noise.cases.every((c) => ids.has(c)) ? base.noise : undefined
  if (base.noise && !stored) caveats.push(`the baseline's stored band covers its ${base.noise.cases.length} cases; this comparison covers ${common.length}, so the spread is re-derived from its passes on those`)
  if (stored) caveats.push(`baseline spread: stored, from ${stored.passes} passes in ${stored.runs} run${stored.runs === 1 ? '' : 's'}`)
  else caveats.push(`baseline spread: derived from its ${base.passes.length} pass${base.passes.length === 1 ? '' : 'es'} in ${base.runs} run${base.runs === 1 ? '' : 's'} (no stored band)`)
  if (opts.noiseFloor) {
    const f = opts.noiseFloor
    const s = f.noise.lines[SOLVED]
    const scale = s ? Math.round(s.of.reduce((a, b) => a + b, 0) / s.of.length) : 0
    caveats.push(`spread floored at ${f.from}'s${s ? ` (${SOLVED_LABEL[suite]} σ ${f2(s.sd * scale)} of ${scale}, ${f.noise.passes} passes in ${f.noise.runs} runs)` : ''}: no side is read as quieter than that (--noise-from)`)
  }
  for (const [who, n] of [['baseline', base], ['run', run]] as const) {
    if (minPasses > 1 && n.passes.length >= 2 && n.runs === 1) caveats.push(`the ${who}'s passes all come from one run, and share the server's state; merge a second run to measure the spread between runs too`)
  }

  /** One banded line: per-pass rates, the band, the verdict. */
  const banded = (key: string, label: string, higherBetter: boolean, extra = 0): void => {
    const bt = perPass(base, ids, key)
    const rt = perPass(run, ids, key)
    if (!bt.length || !rt.length) return
    const floor = opts.noiseFloor?.noise.lines[key]?.sd
    const baseSd = floor === undefined ? stored?.lines[key]?.sd : Math.max(stored?.lines[key]?.sd ?? sampleSd(rates(bt)), floor)
    const nb = noiseBand(rates(bt), rates(rt), baseSd, k)
    const scale = scaleOf(bt)
    const band = nb.band + extra
    const show = (t: PassTally[], sd: number): string => `${f2(mean(rates(t)) * scale)}/${scale} per pass, σ ${f2(sd * scale)} · [${t.map((x) => x.hit).join(', ')}]`
    let verdict: LineVerdict = ''
    if (enough) {
      const worse = higherBetter ? nb.delta < -band - 1e-9 : nb.delta > band + 1e-9
      const better = higherBetter ? nb.delta > band + 1e-9 : nb.delta < -band - 1e-9
      verdict = worse ? 'WORSE' : better ? 'BETTER' : 'SAME-WITHIN-NOISE'
    }
    rows.push({ metric: label, baseline: show(bt, nb.sdBase), run: show(rt, sampleSd(rates(rt))), delta: signed(nb.delta * scale), band: `±${f2(band * scale)}`, verdict })
    const moved = `${nb.delta < 0 ? 'fell' : 'rose'} from ${f2(mean(rates(bt)) * scale)} to ${f2(mean(rates(rt)) * scale)} of ${scale} per pass (${signed(nb.delta * scale)}; noise band ±${f2(band * scale)})`
    if (verdict === 'WORSE') regressions.push(`${label} ${moved}`)
    if (verdict === 'BETTER') {
      improvements.push(`${label} ${moved}`)
      bandedBetter = true
    }
  }

  // The gate's first line: solved (clean) per pass, over every common case.
  banded(SOLVED, `${SOLVED_LABEL[suite]} per pass (${common.length} case${common.length === 1 ? '' : 's'})`, true, tolerance)

  // The stable set and the flaky cases: where to look, no longer gated.
  const stable = common.filter((c) => stability(base.cases.get(c)!) !== 'flaky')
  const flaky = common.filter((c) => stability(base.cases.get(c)!) === 'flaky')
  const tally = (n: Normalized, cs: string[]): PassTally => {
    const os = cs.flatMap((c) => n.cases.get(c)!)
    return { hit: os.filter((o) => o.ok).length, of: os.length }
  }
  const info = (label: string, cs: string[]): void => {
    if (!cs.length) return
    const b = tally(base, cs)
    const r = tally(run, cs)
    rows.push({ metric: label, baseline: pct(b.hit, b.of), run: pct(r.hit, r.of), delta: pp(b.of ? b.hit / b.of : null, r.of ? r.hit / r.of : null), band: '', verdict: '' })
  }
  info(`${SOLVED_LABEL[suite]}, stable set (${stable.length}; not gated)`, stable)
  info(`${SOLVED_LABEL[suite]}, flaky in the baseline (${flaky.length}; not gated)`, flaky)

  // The flags, over every common case: a false claim on a flaky case is still a false claim.
  for (const [key, label, higherBetter] of FLAGS[suite]) {
    if (!NEVER_BANDED.has(key)) {
      banded(key, label, higherBetter === true)
      continue
    }
    const b = total(perPass(base, ids, key))
    const r = total(perPass(run, ids, key))
    if (!b.of || !r.of) continue
    const br = b.hit / b.of
    const rr = r.hit / r.of
    const rose = rr > br + 1e-9
    const fell = rr < br - 1e-9
    rows.push({ metric: `${label} (never banded)`, baseline: pct(b.hit, b.of), run: pct(r.hit, r.of), delta: pp(br, rr), band: '', verdict: rose ? 'WORSE' : !enough ? '' : fell ? 'BETTER' : 'SAME-WITHIN-NOISE' })
    if (rose) regressions.push(`${label} rose from ${pct(b.hit, b.of)} to ${pct(r.hit, r.of)} — never banded: any rise is WORSE`)
    else if (fell && enough) {
      improvements.push(`${label} fell from ${pct(b.hit, b.of)} to ${pct(r.hit, r.of)}`)
      neverBandedFall = `${label} ${pct(b.hit, b.of)} → ${pct(r.hit, r.of)}`
    }
  }

  rows.push({ metric: 'runs excluded (server failures)', baseline: String(base.excluded), run: String(run.excluded), delta: '', band: '', verdict: '' })

  // Timing: printed, never gated.
  if (suite === 'agent' && base.agentRuns && run.agentRuns) {
    const only = (runs: CaseRun[][]): CaseRun[][] => runs.map((p) => p.filter((r) => ids.has(r.case)))
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
    const timing = (metric: string, b: string, r: string, delta: string): void => {
      rows.push({ metric, baseline: b, run: r, delta, band: '', verdict: '' })
    }
    timing('median time, solved (not gated)', sec(sb.msPerSolvedMedian), sec(sr.msPerSolvedMedian), rel(sb.msPerSolvedMedian, sr.msPerSolvedMedian))
    timing('median rounds (not gated)', String(sb.roundsMedian), String(sr.roundsMedian), '')
    const bt = ttft(base.agentRuns)
    const rt = ttft(run.agentRuns)
    if (bt !== null || rt !== null) timing('TTFT, median of runs (not gated)', fmtMs(bt), fmtMs(rt), rel(bt, rt))
    const bd = tps(base.agentRuns)
    const rd = tps(run.agentRuns)
    if (bd !== null || rd !== null) timing('decode tok/s, median of runs (not gated)', bd === null ? '—' : String(bd), rd === null ? '—' : String(rd), rel(bd, rd))
  }

  // What the passes could resolve: a sense of scale for the next run.
  const solvedBase = perPass(base, ids, SOLVED)
  const solvedRun = perPass(run, ids, SOLVED)
  if (enough && solvedBase.length && solvedRun.length) {
    const sd = Math.max(stored?.lines[SOLVED]?.sd ?? sampleSd(rates(solvedBase)), sampleSd(rates(solvedRun)), opts.noiseFloor?.noise.lines[SOLVED]?.sd ?? 0)
    const scale = scaleOf(solvedBase)
    if (sd > 0 && scale >= 2) caveats.push(`at this spread (σ ${f2(sd * scale)} of ${scale} per pass) a change of 2 ${SOLVED_LABEL[suite]} per pass needs about ${passesToResolve(sd, 2 / scale, k)} passes per arm to resolve`)
  }

  const lost = stable.filter((c) => stability(base.cases.get(c)!) === 'stable-pass' && run.cases.get(c)!.some((o) => !o.ok))
  const gained = stable.filter((c) => stability(base.cases.get(c)!) === 'stable-fail' && run.cases.get(c)!.some((o) => o.ok))

  const verdict: Verdict = regressions.length ? 'WORSE' : !enough ? 'TOO-FEW-PASSES' : improvements.length ? 'BETTER' : 'SAME-WITHIN-NOISE'
  const which = describeBase(base, run)
  if (verdict === 'BETTER' && !bandedBetter && neverBandedFall) {
    notes.push(
      `this BETTER rests only on a fall in a never-banded line (${neverBandedFall}): it has no noise band, so one report moves it — and since 4.5 the rule finds real false claims the first one missed, so a side that had one can read as better than it was. No banded line moved; read ${SOLVED_LABEL[suite]} per pass before turning anything on (docs/evals/claims.md)`
    )
  }
  if (verdict === 'BETTER' && !which.sameDay) {
    const against = which.kind === 'committed baseline' ? 'a committed baseline' : which.kind === 'control from another session' ? "another session's control" : 'an untagged run'
    notes.push(`BETTER against ${against}: a switch turns on only beside a same-day control — run the arm with EVAL_CONTROL=1 (or as EVAL_SESSION slices beside its control) and diff against that (ROADMAP-v4.4, G1)`)
  }
  return {
    suite,
    verdict,
    minPasses,
    baseline: { model: base.model, arm: base.arm, passes: base.passes.length, runs: base.runs },
    run: { model: run.model, arm: run.arm, passes: run.passes.length, runs: run.runs },
    base: { kind: which.kind, text: which.text },
    sameDay: which.sameDay,
    claimsRule: base.claimsRule,
    libraryRule: base.libraryRule,
    rows,
    regressions,
    improvements,
    lost,
    gained,
    notes,
    caveats
  }
}

export function formatDiff(d: DiffResult): string {
  const arm = (x: DiffResult['run']): string => `${x.model} (${x.arm}, ${x.passes} pass${x.passes === 1 ? '' : 'es'}, ${x.runs} run${x.runs === 1 ? '' : 's'})`
  const lines: string[] = []
  lines.push(`${SUITE_NAME[d.suite]} diff · baseline ${arm(d.baseline)} → run ${arm(d.run)}`)
  lines.push(`base: ${d.base.text}`)
  if (d.claimsRule !== null) lines.push(`claims rule ${d.claimsRule}: false claims read by it on both sides`)
  if (d.libraryRule !== null) lines.push(`library scorer rule ${d.libraryRule}: answered and forbidden read by it on both sides`)
  lines.push('')
  lines.push('| | baseline | run | Δ | noise band | |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const r of d.rows) lines.push(`| ${r.metric} | ${r.baseline} | ${r.run} | ${r.delta} | ${r.band} | ${r.verdict === 'WORSE' || r.verdict === 'BETTER' ? `**${r.verdict}**` : r.verdict} |`)
  lines.push('')
  if (d.lost.length) lines.push(`stable-pass in the baseline, failed in the run: ${d.lost.join(', ')}`)
  if (d.gained.length) lines.push(`stable-fail in the baseline, solved in the run: ${d.gained.join(', ')}`)
  for (const n of d.notes) lines.push(`note: ${n}`)
  for (const c of d.caveats) lines.push(`band: ${c}`)
  const why =
    d.verdict === 'WORSE'
      ? d.regressions.join('; ')
      : d.verdict === 'BETTER'
        ? d.improvements.join('; ')
        : d.verdict === 'TOO-FEW-PASSES'
          ? `no banded line is called on fewer than ${d.minPasses} passes per arm`
          : 'no gated line moved beyond its noise band'
  lines.push(`${d.verdict}: ${why}`)
  return lines.join('\n')
}

// ---- several runs as one arm, and the committed copy ----------------------------------

/**
 * Several results files of one arm — same suite, model and experiments — as one
 * file whose passes are all of theirs, in order. `merged.passRuns` says which
 * run each pass came from, so the diff can tell four passes of one run (which
 * share the server's state) from four runs.
 */
export function mergeResults(files: unknown[], names: string[] = []): Record<string, unknown> {
  if (!files.length) throw new Error('nothing to merge')
  if (files.length === 1) return files[0] as Record<string, unknown>
  const suite = detectSuite(files[0])
  const first = files[0] as Record<string, unknown>
  const label = (i: number): string => names[i] ?? `file ${i + 1}`
  // v4.4 (G1): one side of one session's comparison, or untagged; never a control merged with its arm.
  const session = combineSessions(files, label)
  const passRuns: number[] = []
  const runs: unknown[] = []
  files.forEach((file, i) => {
    const s = detectSuite(file)
    if (s !== suite) throw new Error(`cannot merge ${label(i)} (${s}) with ${label(0)} (${suite})`)
    const f = file as Record<string, unknown>
    if (f.model !== first.model) throw new Error(`cannot merge ${label(i)} (${String(f.model)}) with ${label(0)} (${String(first.model)}): another model`)
    if (armOf(f) !== armOf(first)) throw new Error(`cannot merge ${label(i)} (${armOf(f)}) with ${label(0)} (${armOf(first)}): another arm`)
    if (suite === 'agent') sameClaimsRule('a merge', { rule: claimsRuleOf(first), name: label(0) }, { rule: claimsRuleOf(f), name: label(i) })
    if (suite === 'library') sameLibraryScorer('a merge', { rule: libraryScorerRuleOf(first), name: label(0) }, { rule: libraryScorerRuleOf(f), name: label(i) })
    const m = isObj(f.merged) ? f.merged : isObj(f.baseline) ? f.baseline : null
    const inner = m && Array.isArray(m.passRuns) ? (m.passRuns as number[]) : null
    const offset = passRuns.length ? Math.max(...passRuns) + 1 : 0
    const ps: unknown[][] = suite === 'agent' ? (f.runs as unknown[][]) : suite === 'library' ? libraryPasses(f) : toolPasses(f.runs as EvalFixtureRun[])
    ps.forEach((_p, j) => passRuns.push(offset + (inner?.[j] ?? 0)))
    if (suite === 'toolchoice') runs.push(...(f.runs as unknown[]))
    else runs.push(...ps)
  })
  const { baseline: _b, noise: _n, session: _s, ...rest } = first
  const tag = session ? { session } : {}
  const merged = { from: files.map((_f, i) => label(i)), passRuns }
  if (suite === 'library') return { ...rest, ...tag, merged, library: { passes: (runs as LibraryCaseResult[][]).map((r) => ({ runs: r })) } }
  const extra = suite === 'agent' ? { passes: runs.length, cases: [...new Set((runs as CaseRun[][]).flat().map((r) => r.case))] } : {}
  return { ...rest, ...tag, ...extra, merged, runs }
}

/**
 * v4.3: slices of the same pass — one arm, run over disjoint EVAL_CASES ranges
 * because a whole pass outlasts the time one command may take — joined back
 * into one file, pass by pass. Not mergeResults: these are parts of one pass,
 * not more passes. Every slice must have the same number of passes, the same
 * model and arm, and no case another slice has.
 */
export function joinSlices(files: unknown[], names: string[] = []): Record<string, unknown> {
  if (!files.length) throw new Error('nothing to join')
  const label = (i: number): string => names[i] ?? `slice ${i + 1}`
  const first = files[0] as Record<string, unknown>
  if (detectSuite(first) !== 'agent') throw new Error('only eval:agent results are joined; an eval:tools pass takes minutes and runs whole')
  const passes = (first.runs as unknown[][]).length
  const session = combineSessions(files, label)
  const seen = new Map<string, number>()
  const runs: CaseRun[][] = Array.from({ length: passes }, () => [])
  files.forEach((file, i) => {
    const f = file as Record<string, unknown>
    if (detectSuite(f) !== 'agent') throw new Error(`${label(i)} is not eval:agent results`)
    if (f.model !== first.model) throw new Error(`cannot join ${label(i)} (${String(f.model)}) with ${label(0)} (${String(first.model)}): another model`)
    if (armOf(f) !== armOf(first)) throw new Error(`cannot join ${label(i)} (${armOf(f)}) with ${label(0)} (${armOf(first)}): another arm`)
    sameClaimsRule('a join', { rule: claimsRuleOf(first), name: label(0) }, { rule: claimsRuleOf(f), name: label(i) })
    const ps = f.runs as CaseRun[][]
    if (ps.length !== passes) throw new Error(`cannot join ${label(i)} (${ps.length} passes) with ${label(0)} (${passes}): slices of one run have the same passes`)
    for (const c of new Set(ps.flat().map((r) => r.case))) {
      if (seen.has(c)) throw new Error(`${c} is in both ${label(seen.get(c)!)} and ${label(i)}: slices must not overlap`)
      seen.set(c, i)
    }
    ps.forEach((p, j) => runs[j]!.push(...p))
  })
  const { baseline: _b, noise: _n, merged: _m, session: _s, ...rest } = first
  return { ...rest, ...(session ? { session } : {}), passes, cases: [...seen.keys()], runs, joined: { from: files.map((_f, i) => label(i)) } }
}

/** The spread of every gated line over a file's own passes, as `--save` stores it. */
export function measureNoise(file: unknown, opts: { k?: number; minPasses?: number } = {}): StoredNoise {
  const n = normalize(file)
  const k = opts.k ?? NOISE_K
  const minPasses = opts.minPasses ?? MIN_PASSES
  const ids = new Set(n.cases.keys())
  const r4 = (x: number): number => Math.round(x * 1e4) / 1e4
  const lines: Record<string, NoiseLine> = {}
  for (const key of [SOLVED, ...FLAGS[n.suite].map(([x]) => x)]) {
    const t = perPass(n, ids, key)
    if (!t.length) continue
    const rs = rates(t)
    const sd = sampleSd(rs)
    lines[key] = { perPass: t.map((x) => x.hit), of: t.map((x) => x.of), mean: r4(mean(rs)), sd: r4(sd), band: r4(k * sd * Math.sqrt(1 / t.length + 1 / minPasses)) }
  }
  return {
    rule: `per-pass rates; band = ${k} × √(σb²/nb + max(σr, σb)²/nr); false claims never banded — src/main/agent/evalDiff.ts (v4.3)`,
    k,
    minPasses,
    passes: n.passes.length,
    runs: n.runs,
    cases: [...ids].sort(),
    lines
  }
}

/**
 * The trimmed copy `--save` writes to baselines/: the same schema, minus what
 * only a reader of one failure needs (the report text, the check's output, each
 * round's timing — the per-run summary stays). Small enough to review in a diff.
 * With `noise`, the spread measured over its passes goes in beside it (v4.3).
 */
export function trimForBaseline(file: unknown, from: string | string[], savedAt: Date = new Date(), opts: { noise?: boolean } = {}): Record<string, unknown> {
  const suite = detectSuite(file)
  const f = file as Record<string, unknown>
  if (suite === 'library') {
    // v4.4 (G5): the library block alone, each reply cut to what a reader of one failure needs.
    const { merged, noise: _n, library: _l, ...rest } = f
    const from_ = isObj(merged) ? merged : isObj(f.baseline) ? f.baseline : null
    const passRuns = from_ && Array.isArray(from_.passRuns) ? { passRuns: from_.passRuns } : {}
    const passes = libraryPasses(f).map((p) => ({ runs: p.map((r) => ({ ...r, reply: (r.reply ?? '').slice(0, 300) })) }))
    return { ...rest, baseline: { from, savedAt: savedAt.toISOString(), ...passRuns }, ...(opts.noise ? { noise: measureNoise(file) } : {}), library: { passes } }
  }
  const runs =
    suite === 'agent'
      ? (f.runs as CaseRun[][]).map((pass) =>
          pass.map((r) => {
            const { finalText: _t, latency: _l, check, ...rest } = r
            return { ...rest, ...(check ? { check: { exitCode: check.exitCode, tail: '' } } : {}), finalText: '' }
          })
        )
      : (f.runs as EvalFixtureRun[]).map((r) => ({ ...r, allCalls: (r.allCalls ?? []).map((c) => ({ name: c.name, valid: c.valid, errors: [] })) }))
  const { merged, noise: _n, ...rest } = f
  const from_ = isObj(merged) ? merged : isObj(f.baseline) ? f.baseline : null
  const passRuns = from_ && Array.isArray(from_.passRuns) ? { passRuns: from_.passRuns } : {}
  return {
    ...rest,
    baseline: { from, savedAt: savedAt.toISOString(), ...passRuns },
    ...(opts.noise ? { noise: measureNoise(file) } : {}),
    runs
  }
}
