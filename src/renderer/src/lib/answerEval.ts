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

import {
  measurementsIn as vocabularyMeasurementsIn,
  type Measurement
} from '../../../shared/measurements'

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
 *
 * v2.1: the vocabulary is `shared/measurements.ts`, not a regex of its own.
 *
 * That file exists, in its own words, because "two copies would drift, and the
 * drift would be silent". There were three, and the drift had happened: this
 * scorer did not recognise `mcg`, `µg`, `mph`, `km/h`, `kwh`, `watt`, `volt`,
 * `amp`, `calorie` or `kcal`, so a library reply stating an invented dose in
 * micrograms scored clean; it matched across a line break, so `"…3:47\nMiles
 * run: 26.2"` yielded `47 Miles`; and it had no rate suffix, so a pace scored
 * as a duration. Nothing about the eval justified any of the three — they were
 * simply what the second author of the same idea happened to write.
 *
 * The one deliberate difference is `%`, and it survives as a named flag rather
 * than a second alternation. A percentage in a reference answer ("your landlord
 * may raise it by 5%") is exactly the kind of figure this suite scores, and the
 * shipped rungs leave `%` out of the shared list on purpose — see
 * `MeasurementOptions`.
 */
export type { Measurement }

export function measurementsIn(text: string): Measurement[] {
  return vocabularyMeasurementsIn(text, { percent: true })
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
  /**
   * v1.9.2: what the grounding ladder said about the Workbench reply.
   *
   * Recorded so the checker can be measured on the arm where it is armed —
   * a computation tool really ran, and the case was scored correct or not
   * independently of it. A finding on a *correct* answer is a false positive,
   * which is the number that decides whether a rung is worth having.
   */
  grounding?: { quantities: string[]; figures: string[] }
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
  /**
   * v2.4: the shapes the multi-pass runs kept failing in, recorded per case so
   * the noise floor can be read rather than guessed at. `toolCalls` — the
   * model called reference_lookup itself (native or as prose; both execute,
   * as in the app). `echoed` — the reply opened with the app's own turn-notes
   * header and was scrubbed, as the app scrubs it. `finishReason` — 'length'
   * is the eval's own 2,000-token cap; 'stop' is the model choosing to end.
   */
  toolCalls?: number
  echoed?: boolean
  finishReason?: string
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
  /** What ran, so a re-read can be read: did the earlier turn even define a variable to reuse? */
  toolResults?: { name: string; code?: string; result: string }[]
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

// ---- reasoning: think-harder where it is actually for (v1.9.1) ---------------------

/**
 * The v1.6 quantitative suite measured think-harder on arithmetic and found a
 * null result at 2.6x the latency — and said so, adding that "the cases it
 * might help (reasoning, not arithmetic) are not what this suite measures".
 * This is that suite: multi-step problems with one checkable answer, where a
 * 9B makes a single wrong inference and everything after it follows. No tools
 * — computation is the Workbench's job, and tools here would confound.
 *
 * The comparison is draft vs the same draft after review-and-revise, so the
 * two arms share a draft and the delta is exactly what the pass adds. What
 * matters is not the totals but the two directed counts: how often review
 * FIXED a wrong draft, and how often it BROKE a right one.
 */
export interface ReasoningTurnResult {
  correct: boolean
  /** Answer patterns absent from the reply. */
  missing: string[]
  /** Distractor answers the reply asserted (negation-aware). */
  asserted: string[]
  /** The model replied with no content at all (reasoning-only response). */
  empty: boolean
  ms: number
  reply?: string
}

export interface ReasoningCaseResult {
  file: string
  kind: string
  draft: ReasoningTurnResult
  final: ReasoningTurnResult
  /** The reviewer said something was wrong. */
  reviewFoundProblems: boolean
  /** A revision was produced and replaced the draft. */
  revised: boolean
  reviewMs: number
  error?: string
}

export interface ReasoningSummary {
  draftCorrect: Rate
  finalCorrect: Rate
  /** Wrong draft -> right final. The reason the feature exists. */
  fixed: Rate
  /** Right draft -> wrong final. The reason it might not be worth it. */
  broke: Rate
  reviewFoundProblems: Rate
  revised: Rate
  secondsDraft: number
  /** Review + revision, i.e. what the pass costs on top of the draft. */
  secondsReview: number
}

export function summarizeReasoning(results: ReasoningCaseResult[]): ReasoningSummary {
  const ok = results.filter((r) => !r.error)
  const both = ok.filter((r) => !r.draft.empty && !r.final.empty)
  return {
    draftCorrect: rate(ok.filter((r) => r.draft.correct).length, ok.length),
    finalCorrect: rate(ok.filter((r) => r.final.correct).length, ok.length),
    fixed: rate(both.filter((r) => !r.draft.correct && r.final.correct).length, both.filter((r) => !r.draft.correct).length),
    broke: rate(both.filter((r) => r.draft.correct && !r.final.correct).length, both.filter((r) => r.draft.correct).length),
    reviewFoundProblems: rate(ok.filter((r) => r.reviewFoundProblems).length, ok.length),
    revised: rate(ok.filter((r) => r.revised).length, ok.length),
    secondsDraft: mean(ok.map((r) => r.draft.ms / 1000)),
    secondsReview: mean(ok.map((r) => r.reviewMs / 1000))
  }
}

// ---- deep research under the ladder (v1.9) ----------------------------------------

export interface ResearchArmResult {
  ok: boolean
  sources: number
  factsStated: number
  factsOf: number
  /** Decoy figures (absent from the corpus) the brief nonetheless stated. */
  decoysStated: string[]
  /** Independent audit of the final brief: figures+measurements in no passage. */
  unsupportedFigures: number
  badCitations: number
  /** Checked arm only: what the rung flagged on the first draft, and whether a revision was kept. */
  flaggedBefore: number
  revised: boolean
  ms: number
  brief?: string
  note?: string
  error?: string
}

export interface ResearchCaseResult {
  file: string
  question: string
  /** Which corpus served the case: 'thin' is the regime the rung exists for. */
  regime?: 'clean' | 'thin'
  checked: ResearchArmResult
  unchecked: ResearchArmResult
}

export interface ResearchArmSummary {
  ran: Rate
  /** Cases where every required fact was stated. */
  complete: Rate
  /** Cases stating at least one decoy. */
  statedDecoy: Rate
  /** Cases whose final brief carries an unsupported figure or measurement. */
  unsupported: Rate
  /** Cases with a citation to a source the run never read. */
  fabricatedCitation: Rate
  secondsPerCase: number
}

export interface ResearchSummary {
  checked: ResearchArmSummary & { flaggedFirstDraft: Rate; revised: Rate }
  unchecked: ResearchArmSummary
  /** Per regime — 'thin' is where the rung has something to catch. */
  byRegime: Record<'clean' | 'thin', { checked: ResearchArmSummary & { flaggedFirstDraft: Rate; revised: Rate }; unchecked: ResearchArmSummary; cases: number }>
}

function researchArm(results: ResearchCaseResult[], arm: 'checked' | 'unchecked'): ResearchArmSummary & { flaggedFirstDraft: Rate; revised: Rate } {
  const all = results.map((r) => r[arm]).filter((a) => a && !a.error)
  const ok = all.filter((a) => a.ok)
  return {
    ran: rate(ok.length, all.length),
    complete: rate(ok.filter((a) => a.factsStated === a.factsOf).length, ok.length),
    statedDecoy: rate(ok.filter((a) => a.decoysStated.length > 0).length, ok.length),
    unsupported: rate(ok.filter((a) => a.unsupportedFigures > 0).length, ok.length),
    fabricatedCitation: rate(ok.filter((a) => a.badCitations > 0).length, ok.length),
    flaggedFirstDraft: rate(ok.filter((a) => a.flaggedBefore > 0).length, ok.length),
    revised: rate(ok.filter((a) => a.revised).length, ok.length),
    secondsPerCase: mean(ok.map((a) => a.ms / 1000))
  }
}

export function summarizeResearch(results: ResearchCaseResult[]): ResearchSummary {
  const checked = researchArm(results, 'checked')
  const { flaggedFirstDraft: _f, revised: _r, ...unchecked } = researchArm(results, 'unchecked')
  const of = (regime: 'clean' | 'thin'): ResearchSummary['byRegime']['clean'] => {
    const subset = results.filter((r) => (r.regime ?? 'clean') === regime)
    const { flaggedFirstDraft: _a, revised: _b, ...un } = researchArm(subset, 'unchecked')
    return { checked: researchArm(subset, 'checked'), unchecked: un, cases: subset.length }
  }
  return { checked, unchecked, byRegime: { clean: of('clean'), thin: of('thin') } }
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
  /** Long regime: the wire history was compacted before this turn and the establishing turn dropped. */
  compacted?: boolean
  /** The ledger block as injected (ledger arm), so a miss can be read against what the model saw. */
  ledgerBlock?: string
  /** Tool results this turn produced — what the ledger is built from. */
  toolResults?: { name: string; result: string }[]
  reply?: string
  error?: string
}

export interface LedgerCaseResult {
  file: string
  /** 'long' = the establishing turn is compacted out before recall — the regime the ledger exists for. */
  regime?: 'short' | 'long'
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
  /** The same, restricted to long-regime cases (establishing turn compacted out). */
  long: { ledger: LedgerArmSummary; bare: LedgerArmSummary; cases: number }
  short: { ledger: LedgerArmSummary; bare: LedgerArmSummary; cases: number }
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
  const long = results.filter((r) => r.regime === 'long')
  const short = results.filter((r) => r.regime !== 'long')
  return {
    ledger: ledgerArm((r) => r.ledger, results),
    bare: ledgerArm((r) => r.bare, results),
    long: { ledger: ledgerArm((r) => r.ledger, long), bare: ledgerArm((r) => r.bare, long), cases: long.length },
    short: { ledger: ledgerArm((r) => r.ledger, short), bare: ledgerArm((r) => r.bare, short), cases: short.length }
  }
}

// ---- v1.11: project-wide recall ---------------------------------------------

export interface ProjectRecallQuestionResult {
  prompt: string
  /** recall = the answer lives in a sibling chat; control = it does not. */
  kind: 'recall' | 'control'
  /** The reply stated every expected value and contained every required string. */
  hit: boolean
  missing: string[]
  ms: number
  /** Recall fired and put at least one passage on the turn (recall arm only). */
  injected: boolean
  /** Titles of the sibling chats the injected passages came from. */
  from: string[]
  /** The passage block as injected, so a miss can be read against what the model saw. */
  block?: string
  /** Retrieval mode for this question: hybrid = keyword + embeddings. */
  mode?: 'hybrid' | 'keyword'
  /**
   * Control questions only: project-specific terms that appeared in the reply
   * and had no business being there. The harm signal — recall pulling a model
   * off the question it was asked.
   */
  decoysStated: string[]
  reply?: string
  error?: string
}

export interface ProjectRecallCaseResult {
  file: string
  project: string
  /** The sibling chat each recall question's answer actually lives in, by prompt. */
  recall: ProjectRecallQuestionResult[]
  bare: ProjectRecallQuestionResult[]
}

export interface ProjectRecallArmSummary {
  /** Questions whose answer lives in a sibling chat. */
  recallAnswered: Rate
  /** Questions answerable without the siblings — the arm must not make these worse. */
  controlAnswered: Rate
  /** Control replies that stated a project term the question never mentioned. */
  controlDistracted: Rate
  secondsPerQuestion: number
}

export interface ProjectRecallSummary {
  recall: ProjectRecallArmSummary
  bare: ProjectRecallArmSummary
  /**
   * Retrieval measured on its own, independently of whether the model then
   * used what it was given: how often the gate fired where it should, and how
   * often it stayed quiet where it should.
   */
  retrieval: {
    /** Recall questions where at least one passage was injected. Higher is better. */
    firedOnRecall: Rate
    /** Control questions where nothing was injected. Higher is better — this is the gate. */
    quietOnControl: Rate
    mode: 'hybrid' | 'keyword' | 'mixed' | 'none'
  }
}

function projectArm(
  questionsOf: (r: ProjectRecallCaseResult) => ProjectRecallQuestionResult[],
  results: ProjectRecallCaseResult[]
): ProjectRecallArmSummary {
  let rHit = 0
  let rOf = 0
  let cHit = 0
  let cOf = 0
  let dHit = 0
  let dOf = 0
  const secs: number[] = []
  for (const r of results) {
    for (const q of questionsOf(r)) {
      if (q.error) continue
      secs.push(q.ms / 1000)
      if (q.kind === 'recall') {
        rOf += 1
        if (q.hit) rHit += 1
      } else {
        cOf += 1
        if (q.hit) cHit += 1
        dOf += 1
        if (q.decoysStated.length > 0) dHit += 1
      }
    }
  }
  return {
    recallAnswered: rate(rHit, rOf),
    controlAnswered: rate(cHit, cOf),
    controlDistracted: rate(dHit, dOf),
    secondsPerQuestion: mean(secs)
  }
}

export function summarizeProjectRecall(results: ProjectRecallCaseResult[]): ProjectRecallSummary {
  let firedHit = 0
  let firedOf = 0
  let quietHit = 0
  let quietOf = 0
  const modes = new Set<string>()
  for (const r of results) {
    for (const q of r.recall) {
      if (q.error) continue
      if (q.mode) modes.add(q.mode)
      if (q.kind === 'recall') {
        firedOf += 1
        if (q.injected) firedHit += 1
      } else {
        quietOf += 1
        if (!q.injected) quietHit += 1
      }
    }
  }
  const mode =
    modes.size === 0 ? 'none' : modes.size > 1 ? 'mixed' : ([...modes][0] as 'hybrid' | 'keyword')
  return {
    recall: projectArm((r) => r.recall, results),
    bare: projectArm((r) => r.bare, results),
    retrieval: { firedOnRecall: rate(firedHit, firedOf), quietOnControl: rate(quietHit, quietOf), mode }
  }
}

// ---- v1.12: market indicators -----------------------------------------------

export interface MarketQuestionResult {
  prompt: string
  /** figures = numeric expectations; chart = a PNG must be produced. */
  kind: 'figures' | 'chart'
  hit: boolean
  missing: string[]
  /** The turn called market_data successfully (tool arm only). */
  fetched: boolean
  /** The turn ran run_python successfully (how indicators should be computed). */
  computed: boolean
  /** A .png came back from the sandbox this turn. */
  chartProduced: boolean
  /** The reply stated at least one specific figure (bare-arm fabrication signal). */
  statedFigures: boolean
  ms: number
  reply?: string
  error?: string
}

export interface MarketCaseResult {
  file: string
  symbol: string
  tool: MarketQuestionResult[]
  bare: MarketQuestionResult[]
}

export interface MarketArmSummary {
  /** Figure questions whose every expected value was stated. */
  figures: Rate
  /** Chart questions that produced a real PNG. */
  charts: Rate
  /** Turns that ran the sandbox (tool arm: computing, not eyeballing). */
  computed: Rate
  /**
   * Bare-arm honesty: figure questions answered WITHOUT stating figures — for
   * a ticker the model cannot know, a hedge or refusal is the right answer,
   * and a confident number is a fabrication.
   */
  declined: Rate
  secondsPerQuestion: number
}

export interface MarketSummary {
  tool: MarketArmSummary
  bare: MarketArmSummary
}

function marketArm(
  questionsOf: (r: MarketCaseResult) => MarketQuestionResult[],
  results: MarketCaseResult[]
): MarketArmSummary {
  let figHit = 0
  let figOf = 0
  let chartHit = 0
  let chartOf = 0
  let compHit = 0
  let compOf = 0
  let declHit = 0
  let declOf = 0
  const secs: number[] = []
  for (const r of results) {
    for (const q of questionsOf(r)) {
      if (q.error) continue
      secs.push(q.ms / 1000)
      compOf += 1
      if (q.computed) compHit += 1
      if (q.kind === 'chart') {
        chartOf += 1
        if (q.chartProduced) chartHit += 1
      } else {
        figOf += 1
        if (q.hit) figHit += 1
        declOf += 1
        if (!q.statedFigures) declHit += 1
      }
    }
  }
  return {
    figures: rate(figHit, figOf),
    charts: rate(chartHit, chartOf),
    computed: rate(compHit, compOf),
    declined: rate(declHit, declOf),
    secondsPerQuestion: mean(secs)
  }
}

export function summarizeMarket(results: MarketCaseResult[]): MarketSummary {
  return { tool: marketArm((r) => r.tool, results), bare: marketArm((r) => r.bare, results) }
}

// ---- v1.12.1: orchestration ---------------------------------------------------

export interface OrchestrateArmResult {
  hit: boolean
  missing: string[]
  ms: number
  /** Real tool executions this turn (excluding consult_model itself). */
  toolCalls: number
  /** Successful consult_model calls (orchestrated arm; always 0 independent). */
  consults: number
  /** Roles successfully consulted, in call order. */
  delegatedTo: string[]
  reply?: string
  error?: string
}

export interface OrchestrateCaseResult {
  file: string
  prompt: string
  independent: OrchestrateArmResult
  orchestrated: OrchestrateArmResult
}

export interface OrchestrateSummary {
  independent: { hit: Rate; secondsPerCase: number; toolCallsPerCase: number }
  orchestrated: {
    hit: Rate
    secondsPerCase: number
    toolCallsPerCase: number
    /** Cases where at least one consultation succeeded. */
    delegated: Rate
    consultsPerCase: number
  }
  /**
   * The slice the headline can hide: correctness on exactly the cases where
   * the orchestrator DID delegate, both arms. If delegation helps, it shows
   * here or nowhere.
   */
  whenDelegated: { cases: number; independent: Rate; orchestrated: Rate }
}

export function summarizeOrchestrate(results: OrchestrateCaseResult[]): OrchestrateSummary {
  const ok = (r: OrchestrateCaseResult): boolean => !r.independent.error && !r.orchestrated.error
  const usable = results.filter(ok)
  const rateOf = (pick: (r: OrchestrateCaseResult) => boolean): Rate =>
    rate(usable.filter(pick).length, usable.length)
  const meanOf = (pick: (r: OrchestrateCaseResult) => number): number =>
    mean(usable.map(pick))
  const delegated = usable.filter((r) => r.orchestrated.consults > 0)
  return {
    independent: {
      hit: rateOf((r) => r.independent.hit),
      secondsPerCase: meanOf((r) => r.independent.ms / 1000),
      toolCallsPerCase: meanOf((r) => r.independent.toolCalls)
    },
    orchestrated: {
      hit: rateOf((r) => r.orchestrated.hit),
      secondsPerCase: meanOf((r) => r.orchestrated.ms / 1000),
      toolCallsPerCase: meanOf((r) => r.orchestrated.toolCalls),
      delegated: rateOf((r) => r.orchestrated.consults > 0),
      consultsPerCase: meanOf((r) => r.orchestrated.consults)
    },
    whenDelegated: {
      cases: delegated.length,
      independent: rate(delegated.filter((r) => r.independent.hit).length, delegated.length),
      orchestrated: rate(delegated.filter((r) => r.orchestrated.hit).length, delegated.length)
    }
  }
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
