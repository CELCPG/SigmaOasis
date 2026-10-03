import {
  LIBRARY_SCORER_RULE,
  assertedPatterns,
  measurementsIn,
  normalizeReply,
  readReply,
  stabilityAcrossPasses,
  summarizeLibrary,
  type LibraryCaseResult
} from '../../renderer/src/lib/answerEval'
import { detectSuite, librarySuiteOf, measureNoise } from './evalDiff'

/**
 * v4.6 (J3): a library results file, moved to the current library scorer.
 *
 * What a run's flags owe to the scorer (answerEval.ts `scoreLibrary`):
 * `answered` and `missing` (the case's `mustInclude` patterns against the reply)
 * and `forbidden` (its `mustNotAssert` patterns, asserted and not negated),
 * both read from the reply as the scorer's `normalizeReply` leaves it. The
 * file keeps everything they are read from — the reply, and the case's patterns
 * are in its fixture — so a file can be re-scored without a model, a server or a
 * library, and `eval:diff` can then read both sides by one scorer.
 *
 * `cited` and `unsupported` are not re-read: `cited` looks for a bracket
 * citation or the words of a title, and `unsupported` for the measurements in
 * the reply against the passages the run retrieved — which the file does not
 * keep. Neither can move by the normalisation (no pattern in them reads a space
 * as one), and that is checked on every reply instead: `measurementsMoved` counts
 * the replies whose measurements differ before and after it (none, on every
 * recorded file) and the tool says so.
 *
 * Each flag that moves is told apart by what moved it: the normalisation (the
 * un-normalised current scorer reads the reply as the stored flag says, the
 * normalised one does not), or an older scorer (the stored flag is not what
 * today's scorer says of the reply as written — 4.4's list-lead-in and negation
 * changes came after some of its files were scored). A file that holds library-aids
 * runs (each has a `kind`) and does not say so — 4.5's control files did not — gets
 * `librarySuite` stamped, so eval:diff reads the suite off the file. A file's summaries
 * (`summary`, `stability`, `shapes`) are recomputed by the functions that wrote
 * them, and a stored `noise` is measured again by the one `--save` uses.
 */

export interface LibraryFixtureLike {
  mustInclude: string[]
  mustNotAssert?: string[]
}

export interface LibraryRunChange {
  case: string
  /** 1-based, within the file. */
  pass: number
  field: 'answered' | 'forbidden'
  was: boolean
  now: boolean
  because: 'normalisation' | 'older scorer'
  /** The pattern(s) that decided it: the ones now found (answered) or no longer asserted (forbidden), or the ones now missing. */
  patterns: string[]
}

export interface LibraryRescored {
  file: Record<string, unknown>
  changes: LibraryRunChange[]
  /** Runs read from a reply and a fixture. */
  read: number
  /** Runs left as they were: errored (never scored), no reply kept, or no case fixture to read the patterns from. */
  left: { errored: number; noReply: number; noFixture: string[] }
  /** Replies whose measurements differ before and after the normalisation: what `unsupported` could move on. */
  measurementsMoved: number
  /** `librarySuite` was stamped on a file that held library-aids runs and did not say so. */
  suiteStamped: boolean
  /** Whether a summary recomputed from the stored flags equals the stored one, before anything moved (false: the recompute is not exact for this file). */
  summariesExact: boolean
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** The runs of every pass of a library block, with the pass each belongs to. */
function passesOf(lib: Record<string, unknown>): { runs: LibraryCaseResult[] }[] {
  return Array.isArray(lib.passes) ? (lib.passes as { runs: LibraryCaseResult[] }[]) : [{ runs: (lib.runs ?? []) as LibraryCaseResult[] }]
}

export function rescoreLibraryFile(file: unknown, fixtureOf: (run: LibraryCaseResult) => LibraryFixtureLike | undefined): LibraryRescored {
  if (detectSuite(file) !== 'library') throw new Error('only eval:answers results with a library block carry library flags')
  const f = file as Record<string, unknown>
  if (isObj(f.baseline) && typeof f.baseline.savedAt === 'string') throw new Error('a committed baseline keeps each reply cut to 300 characters: it cannot be re-scored from them')
  const lib = f.library as Record<string, unknown>
  const changes: LibraryRunChange[] = []
  const left = { errored: 0, noReply: 0, noFixture: [] as string[] }
  let read = 0
  let measurementsMoved = 0
  const before = passesOf(lib)
  // The summaries the file stored, against what the same function reads from its stored flags: true when recomputing them is exact.
  const storedSummaries: unknown[] = Array.isArray(lib.passes) ? (lib.passes as { summary?: unknown }[]).map((p) => p.summary) : [lib.summary]
  const summariesExact = storedSummaries.every((s, i) => s === undefined || JSON.stringify(summarizeLibrary(before[i]!.runs)) === JSON.stringify(s))

  const rescorePass = (runs: LibraryCaseResult[], pass: number): LibraryCaseResult[] =>
    runs.map((r) => {
      if (r.error || !r.score) {
        left.errored++
        return r
      }
      if (typeof r.reply !== 'string' || r.reply.length === 0) {
        left.noReply++
        return r
      }
      const fx = fixtureOf(r)
      if (!fx) {
        left.noFixture.push(r.file)
        return r
      }
      read++
      const raw = {
        answered: fx.mustInclude.every((p) => new RegExp(p, 'i').test(r.reply!)),
        forbidden: assertedPatterns(r.reply, fx.mustNotAssert ?? []).length > 0
      }
      const now = readReply(r.reply, fx)
      if (JSON.stringify(measurementsIn(r.reply).map((m) => [m.value, m.unit])) !== JSON.stringify(measurementsIn(normalizeReply(r.reply)).map((m) => [m.value, m.unit]))) measurementsMoved++
      const answered = now.missing.length === 0
      const forbiddenNow = now.forbidden.length > 0
      const storedAnswered = r.score.answered
      const storedForbidden = (r.score.forbidden ?? []).length > 0
      if (storedAnswered !== answered) changes.push({ case: r.file, pass, field: 'answered', was: storedAnswered, now: answered, because: raw.answered !== answered ? 'normalisation' : 'older scorer', patterns: answered ? r.score.missing : now.missing })
      if (storedForbidden !== forbiddenNow) changes.push({ case: r.file, pass, field: 'forbidden', was: storedForbidden, now: forbiddenNow, because: raw.forbidden !== forbiddenNow ? 'normalisation' : 'older scorer', patterns: forbiddenNow ? now.forbidden : r.score.forbidden })
      // Assigned in place, so every key keeps its place in the file.
      return { ...r, score: { ...r.score, answered, missing: now.missing, forbidden: now.forbidden } }
    })

  const passes = before.map((p, i) => ({ ...p, runs: rescorePass(p.runs, i + 1) }))
  const moved: Record<string, unknown> = {}
  const stampSuite = f.librarySuite === undefined && librarySuiteOf(f) === 'library-aids'
  const stamped = (k: string): boolean => k === 'libraryScorerRule'
  for (const [k, v] of Object.entries(f)) {
    if (stamped(k)) continue
    if (k === 'library') {
      if (stampSuite) moved.librarySuite = 'library-aids'
      moved.libraryScorerRule = LIBRARY_SCORER_RULE
      const out: Record<string, unknown> = {}
      for (const [lk, lv] of Object.entries(lib)) {
        if (lk === 'passes') out.passes = (lv as Record<string, unknown>[]).map((p, i) => ({ ...p, ...(isObj(p.summary) ? { summary: summarizeLibrary(passes[i]!.runs) } : {}), runs: passes[i]!.runs }))
        else if (lk === 'runs') out.runs = passes[0]!.runs
        else if (lk === 'summary') out.summary = summarizeLibrary(passes[0]!.runs)
        else if (lk === 'stability') out.stability = stabilityAcrossPasses(passes.map((p) => p.runs.map((r) => ({ file: r.file, pass: r.error ? null : (r.score?.answered ?? false) }))))
        else if (lk === 'shapes') {
          const failing = passes.flatMap((p) => p.runs.filter((r) => !r.error && r.score && !r.score.answered))
          out.shapes = {
            calledTheTool: failing.filter((r) => (r.toolCalls ?? 0) > 0).length,
            echoedTheHeader: failing.filter((r) => r.echoed).length,
            cutOffByTheCap: failing.filter((r) => r.finishReason === 'length').length,
            stoppedShort: failing.filter((r) => r.finishReason === 'stop' && (r.reply?.length ?? 0) < 200).length
          }
        } else out[lk] = lv
      }
      moved.library = out
    } else moved[k] = v
  }
  if (isObj(f.noise)) moved.noise = measureNoise(moved)
  return { file: moved, changes, read, left, measurementsMoved, suiteStamped: stampSuite, summariesExact }
}
