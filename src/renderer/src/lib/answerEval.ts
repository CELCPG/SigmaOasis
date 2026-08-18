/**
 * v1.6 answer-quality evals — the scoring, headless and shared by the shells
 * (scripts/eval-answers.ts today; an in-app button later), exactly as
 * evalRunner.ts is shared for tool choice.
 *
 * Three suites, from STRATEGY-depth-and-reasoning.md's "Measuring it":
 *
 *   library       does the model answer an offline reference question from the
 *                 retrieved passages, cite them, and state no measurement the
 *                 passages do not contain?
 *   quantitative  does it get the number right — with and without the
 *                 Workbench? The delta is the point: it is what "the app made
 *                 a 9B model smarter" means as a number.
 *   deliberation  the same questions with think-harder on, reported as a
 *                 delta and a cost in seconds.
 *
 * Every judgement here is mechanical. No model grades another model's answer:
 * a quantitative case knows its own answer, and a library case is scored
 * against the passages the app actually retrieved.
 */

// ---- numbers in an answer -------------------------------------------------------

/** Numbers as written, normalized: "1,249.99" and "$1249.99" both → 1249.99. */
export function numbersIn(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(/(?<![\w.])[-+]?\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''))
    if (Number.isFinite(n)) out.push(n)
  }
  return out
}

/**
 * Does the reply state this value? A figure counts when it matches to the
 * tolerance, or when it matches after rounding to the tolerance's precision —
 * "1,436.05" and "1436.0483" are the same answer stated differently, and an
 * eval that failed the second would be measuring formatting, not arithmetic.
 */
/**
 * Binary floating point makes `|31997.13 - 31997.12| <= 0.01` false by 2e-12.
 * Measured: it failed a model that had answered correctly, which is the one
 * thing an eval must never do.
 */
const FLOAT_SLOP = 1e-9

export function statesValue(reply: string, value: number, tolerance = 0.01): boolean {
  const found = numbersIn(reply)
  if (found.some((n) => Math.abs(n - value) <= tolerance + FLOAT_SLOP)) return true
  // Percentages written as "25.6%" against an expected 25.6 already match
  // above; this covers a reply that rounded harder than the tolerance allows
  // only when the expectation itself is a round number.
  const decimals = Math.max(0, Math.ceil(-Math.log10(tolerance)) - 0)
  const target = Number(value.toFixed(Math.min(6, decimals)))
  return found.some((n) => Number(n.toFixed(Math.min(6, decimals))) === target)
}

export interface QuantExpectation {
  label: string
  value: number
  tolerance?: number
}

export interface QuantScore {
  /** Every expected value appears in the reply. */
  hit: boolean
  missing: string[]
}

export function scoreQuantitative(reply: string, expect: QuantExpectation[]): QuantScore {
  const missing = expect.filter((e) => !statesValue(reply, e.value, e.tolerance ?? 0.01)).map((e) => e.label)
  return { hit: missing.length === 0, missing }
}

// ---- measurements, for the library suite ---------------------------------------

/**
 * Numbers that carry a unit — the class where inventing one is dangerous:
 * a duration, a temperature, a dose, a distance. Matched with its unit so
 * "20 minutes" and "20 people" are not the same claim.
 */
const MEASUREMENT =
  /(?<![\w.])(\d[\d,]*(?:\.\d+)?)\s*(°\s?[cf]\b|degrees?\b|%|minutes?\b|mins?\b|hours?\b|hrs?\b|days?\b|weeks?\b|months?\b|years?\b|seconds?\b|secs?\b|mg\b|ml\b|grams?\b|g\b|kg\b|litres?\b|liters?\b|l\b|gallons?\b|ounces?\b|oz\b|pounds?\b|lbs?\b|cm\b|mm\b|metres?\b|meters?\b|m\b|inches?\b|feet\b|ft\b|miles?\b|km\b)/gi

export interface Measurement {
  raw: string
  value: number
  unit: string
}

export function measurementsIn(text: string): Measurement[] {
  const out: Measurement[] = []
  for (const m of text.matchAll(MEASUREMENT)) {
    const value = Number(m[1].replace(/,/g, ''))
    if (!Number.isFinite(value)) continue
    out.push({ raw: m[0].trim(), value, unit: m[2].toLowerCase().replace(/\s+/g, '') })
  }
  return out
}

/**
 * Measurements the reply states that the retrieved passages do not contain.
 *
 * The corpus is matched on the *number*, not the exact phrasing: a passage
 * saying "15 to 30 minutes" supports "15 minutes" and "30 minutes" but not
 * "45 minutes". Deliberately lenient about units on the corpus side — the
 * question is whether the figure came from somewhere, and a false alarm here
 * would make the suite measure phrasing.
 */
export function unsupportedMeasurements(reply: string, corpus: string): string[] {
  const known = new Set(numbersIn(corpus).map((n) => String(n)))
  const flagged: string[] = []
  const seen = new Set<string>()
  for (const m of measurementsIn(reply)) {
    if (known.has(String(m.value))) continue
    // A rounded restatement of a known figure ("about 30 minutes" for 29.5).
    if ([...known].some((k) => Math.abs(Number(k) - m.value) < 0.5)) continue
    if (seen.has(m.raw)) continue
    seen.add(m.raw)
    flagged.push(m.raw)
  }
  return flagged
}

/**
 * Did the reply point at the source? Either a bracketed citation the tool
 * output used, or a document/pack title from the passages it was given. Title
 * matching uses the longest word of the title so "FM 4-25.11 First Aid" is
 * matched by "First Aid" but a reply that merely says "the manual" is not.
 */
export function citesSource(reply: string, titles: string[]): boolean {
  if (/\[\d+\]/.test(reply)) return true
  const lower = reply.toLowerCase()
  return titles.some((t) => {
    const words = t
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 5)
    return words.length > 0 && words.every((w) => lower.includes(w))
  })
}

/**
 * Words that turn a mention into a warning. Deliberately broad: the cost of
 * missing one is flagging a correct answer, which is the failure mode that
 * makes an eval worse than useless.
 */
const NEGATION_CUES =
  /\b(?:not|never|no|none|don'?t|doesn'?t|didn'?t|won'?t|shouldn'?t|cannot|can'?t|must not|avoid|avoids|avoiding|unsafe|unsafely|danger|dangerous|risky|away from|instead of|rather than|refrain|discard|throw (?:it )?(?:away|out)|wrong|incorrect|myth)\b/i

/**
 * The sentence (or list item, or line) a match sits in — the scope negation
 * actually operates over. "Never thaw on the counter" and "counter thawing is
 * unsafe" both negate; a character window either side would also drag in the
 * neighbouring bullet, which is how a fixture starts measuring layout.
 */
function scopeAround(text: string, index: number, length: number): string {
  const before = text.slice(0, index)
  const after = text.slice(index + length)
  const start = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('. '), before.lastIndexOf('! '), before.lastIndexOf('? '), before.lastIndexOf('; '))
  const endCandidates = [after.indexOf('\n'), after.indexOf('. '), after.indexOf('! '), after.indexOf('? ')].filter((i) => i >= 0)
  const end = endCandidates.length > 0 ? Math.min(...endCandidates) : after.length
  return text.slice(start + 1, index + length + end + 1)
}

/**
 * Patterns the reply *asserts* — matched somewhere no negation cue shares its
 * sentence. This is what a case means by "must not": a reply that says
 * "never thaw on the counter" or "cook to 165°F, not 145°F" is correct, and
 * measured against the naive form both were flagged as failures.
 */
export function assertedPatterns(reply: string, patterns: string[]): string[] {
  const flagged: string[] = []
  for (const pattern of patterns) {
    const re = new RegExp(pattern, 'gi')
    let asserted = false
    for (const m of reply.matchAll(re)) {
      const scope = scopeAround(reply, m.index ?? 0, m[0].length)
      if (!NEGATION_CUES.test(scope)) {
        asserted = true
        break
      }
    }
    if (asserted) flagged.push(pattern)
  }
  return flagged
}

export interface LibraryScore {
  /** Every required fact appears in the reply. */
  answered: boolean
  missing: string[]
  cited: boolean
  /** Measurements the retrieved passages do not support. */
  unsupported: string[]
  /** Patterns the reply asserted that the case forbids (a wrong figure, unsafe advice). */
  forbidden: string[]
}

export function scoreLibrary(
  reply: string,
  input: { mustInclude: string[]; mustNotAssert?: string[]; passages: string; titles: string[] }
): LibraryScore {
  const missing = input.mustInclude.filter((p) => !new RegExp(p, 'i').test(reply))
  const forbidden = assertedPatterns(reply, input.mustNotAssert ?? [])
  return {
    answered: missing.length === 0,
    missing,
    cited: citesSource(reply, input.titles),
    unsupported: unsupportedMeasurements(reply, input.passages),
    forbidden
  }
}

// ---- suite summaries -------------------------------------------------------------

export interface Rate {
  hit: number
  of: number
}

export function rate(hit: number, of: number): Rate {
  return { hit, of }
}

export function pct(r: Rate): string {
  return r.of === 0 ? '—' : `${Math.round((r.hit / r.of) * 100)}%`
}

export interface QuantCaseResult {
  file: string
  prompt: string
  /** Replies per arm, kept so a failed case can be read rather than guessed at. */
  replies?: { bare?: string; workbench?: string; deliberated?: string }
  /** Without the Workbench: no tools at all. */
  bare: { hit: boolean; missing: string[]; ms: number; error?: string }
  /** With run_python / analyze_file available and really executed. */
  workbench?: { hit: boolean; missing: string[]; ms: number; toolCalls: number; error?: string }
  /** What the model actually ran, so a miss can be read rather than re-run. */
  tools?: { name: string; code?: string; result?: string }[]
  /** The bare draft after one think-harder pass. */
  deliberated?: { hit: boolean; missing: string[]; ms: number; revised: boolean; error?: string }
}

export interface QuantSummary {
  bare: Rate
  workbench: Rate
  deliberated: Rate
  /** Mean seconds per case, per arm. */
  seconds: { bare: number; workbench: number; deliberated: number }
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
}

export function summarizeQuant(results: QuantCaseResult[]): QuantSummary {
  const bare = results.filter((r) => !r.bare.error)
  const wb = results.filter((r) => r.workbench && !r.workbench.error)
  const del = results.filter((r) => r.deliberated && !r.deliberated.error)
  return {
    bare: rate(bare.filter((r) => r.bare.hit).length, bare.length),
    workbench: rate(wb.filter((r) => r.workbench!.hit).length, wb.length),
    deliberated: rate(del.filter((r) => r.deliberated!.hit).length, del.length),
    seconds: {
      bare: mean(bare.map((r) => r.bare.ms / 1000)),
      workbench: mean(wb.map((r) => r.workbench!.ms / 1000)),
      deliberated: mean(del.map((r) => r.deliberated!.ms / 1000))
    }
  }
}

export interface LibraryCaseResult {
  file: string
  prompt: string
  pack?: string
  passagesFound: number
  score?: LibraryScore
  ms: number
  error?: string
  /** The reply, kept so a failed case can be read rather than guessed at. */
  reply?: string
  /** Which passages the app retrieved, and how they were ranked. */
  retrieved?: string[]
  mode?: 'hybrid' | 'keyword'
}

export interface LibrarySummary {
  retrieved: Rate
  answered: Rate
  cited: Rate
  /** Cases whose reply stated a measurement the passages do not support. */
  unsupported: Rate
  seconds: number
}

// ---- multi-turn analysis (v1.8) --------------------------------------------------

/**
 * One turn of a multi-turn analysis case: the same mechanical scoring as the
 * quantitative suite, plus what the sessions feature exists to change —
 * whether the turn's Python re-read the data file, and how many tool calls
 * the turn cost. A follow-up that filters the dataframe already in the
 * session needs no re-read; a stateless follow-up must re-read or fail.
 */
export interface MultiTurnTurnResult {
  prompt: string
  hit: boolean
  missing: string[]
  ms: number
  toolCalls: number
  /** This turn's executed Python read a data file (read_csv/read_excel/open of a data path). */
  reread: boolean
  reply?: string
  error?: string
}

export interface MultiTurnCaseResult {
  file: string
  session: MultiTurnTurnResult[]
  stateless: MultiTurnTurnResult[]
}

export interface MultiTurnArmSummary {
  /** Turn 1 of each case — sessions cannot help here; a gap would be noise. */
  first: Rate
  /** Turns 2+ — where persistent state should show. */
  followup: Rate
  /** Follow-up turns whose code re-read the data (lower is the session's win). */
  followupRereads: Rate
  secondsPerTurn: number
  toolCallsPerTurn: number
}

export interface MultiTurnSummary {
  session: MultiTurnArmSummary
  stateless: MultiTurnArmSummary
}

/** Does executed Python read a tabular data file? Matches pandas readers and open() of a data path. */
export function codeReadsData(code: string): boolean {
  return /(?:\bread_csv|\bread_excel)\s*\(|\bopen\s*\(\s*["'][^"']*\.(?:csv|tsv|xlsx|json)\b/.test(code)
}

function armSummary(turnsOf: (r: MultiTurnCaseResult) => MultiTurnTurnResult[], results: MultiTurnCaseResult[]): MultiTurnArmSummary {
  const all = results.flatMap((r) => turnsOf(r).map((t, i) => ({ t, i }))).filter(({ t }) => !t.error)
  const first = all.filter(({ i }) => i === 0)
  const later = all.filter(({ i }) => i > 0)
  return {
    first: rate(first.filter(({ t }) => t.hit).length, first.length),
    followup: rate(later.filter(({ t }) => t.hit).length, later.length),
    followupRereads: rate(later.filter(({ t }) => t.reread).length, later.length),
    secondsPerTurn: mean(all.map(({ t }) => t.ms / 1000)),
    toolCallsPerTurn: mean(all.map(({ t }) => t.toolCalls))
  }
}

export function summarizeMultiTurn(results: MultiTurnCaseResult[]): MultiTurnSummary {
  return {
    session: armSummary((r) => r.session, results),
    stateless: armSummary((r) => r.stateless, results)
  }
}

// ---- conversation ledger (v1.9) ----------------------------------------------------

export interface LedgerTurnResult {
  prompt: string
  /** establish = turn 1 computes the fact; filler = off-topic; recall = must refer back. */
  kind: 'establish' | 'filler' | 'recall'
  hit: boolean
  missing: string[]
  ms: number
  /** The ledger block rode this turn (ledger arm only). */
  ledgerInjected: boolean
  reply?: string
  error?: string
}

export interface LedgerCaseResult {
  file: string
  ledger: LedgerTurnResult[]
  bare: LedgerTurnResult[]
}

export interface LedgerArmSummary {
  /** Did turn 1 establish the fact? A recall cannot be judged if not. */
  established: Rate
  /** Recall turns answered, over cases whose fact was established. */
  recall: Rate
  secondsPerTurn: number
}

export interface LedgerSummary {
  ledger: LedgerArmSummary
  bare: LedgerArmSummary
}

function ledgerArm(turnsOf: (r: LedgerCaseResult) => LedgerTurnResult[], results: LedgerCaseResult[]): LedgerArmSummary {
  let estHit = 0
  let estOf = 0
  let recHit = 0
  let recOf = 0
  const secs: number[] = []
  for (const r of results) {
    const turns = turnsOf(r)
    const est = turns.find((t) => t.kind === 'establish')
    if (!est || est.error) continue
    estOf += 1
    if (!est.hit) continue // no fact to recall — not a recall failure
    estHit += 1
    for (const t of turns) {
      if (t.error) continue
      secs.push(t.ms / 1000)
      if (t.kind !== 'recall') continue
      recOf += 1
      if (t.hit) recHit += 1
    }
  }
  return { established: rate(estHit, estOf), recall: rate(recHit, recOf), secondsPerTurn: mean(secs) }
}

export function summarizeLedger(results: LedgerCaseResult[]): LedgerSummary {
  return { ledger: ledgerArm((r) => r.ledger, results), bare: ledgerArm((r) => r.bare, results) }
}

/**
 * v1.7.1: stability across repeated passes of one suite. Motivated by the
 * v1.7 retrieval re-measurement, where three runs at temperature 0 produced
 * mostly-disjoint failure sets: cases flipped with identical retrieval, so a
 * ±3-case movement said nothing. A change should be judged against the
 * stable set — a case that passes some runs and fails others is measuring
 * the server's nondeterminism, not the app.
 */
export interface StabilityReport {
  /** Passing count per pass, in run order. */
  perPass: number[]
  /** Median of perPass (mean of the two middles for an even count). */
  median: number
  /** Cases that passed in every pass with data. */
  stablePass: number
  /** Cases that failed in every pass with data. */
  stableFail: number
  /** Cases with mixed outcomes — the noise floor, named. */
  flaky: string[]
  /** Distinct cases seen. */
  of: number
}

/** `passes[i]` is pass i's outcomes; `pass: null` = no data (errored/skipped). */
export function stabilityAcrossPasses(passes: { file: string; pass: boolean | null }[][]): StabilityReport {
  const byFile = new Map<string, (boolean | null)[]>()
  for (const pass of passes) {
    for (const c of pass) {
      const arr = byFile.get(c.file) ?? []
      arr.push(c.pass)
      byFile.set(c.file, arr)
    }
  }
  let stablePass = 0
  let stableFail = 0
  const flaky: string[] = []
  for (const [file, outcomes] of byFile) {
    const data = outcomes.filter((o): o is boolean => o !== null)
    if (data.length === 0) continue
    if (data.every((o) => o)) stablePass += 1
    else if (data.every((o) => !o)) stableFail += 1
    else flaky.push(file)
  }
  flaky.sort()
  const perPass = passes.map((p) => p.filter((c) => c.pass === true).length)
  const sorted = [...perPass].sort((a, b) => a - b)
  const median =
    sorted.length === 0
      ? 0
      : sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
  return { perPass, median, stablePass, stableFail, flaky, of: byFile.size }
}

export function summarizeLibrary(results: LibraryCaseResult[]): LibrarySummary {
  const ok = results.filter((r) => !r.error)
  const scored = ok.filter((r) => r.score)
  return {
    retrieved: rate(ok.filter((r) => r.passagesFound > 0).length, ok.length),
    answered: rate(scored.filter((r) => r.score!.answered).length, scored.length),
    cited: rate(scored.filter((r) => r.score!.cited).length, scored.length),
    unsupported: rate(scored.filter((r) => r.score!.unsupported.length > 0).length, scored.length),
    seconds: mean(ok.map((r) => r.ms / 1000))
  }
}
