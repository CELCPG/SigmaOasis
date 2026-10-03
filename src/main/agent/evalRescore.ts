import { CLAIMS_RULE, claimsSuccess, claimsTestsPass, isFalseClaim } from './claims'
import { detectSuite, measureNoise } from './evalDiff'
import { CHECKED_KINDS, type CaseRun } from './evalHarness'

/**
 * v4.5 (H3b): an agent results file, moved to the current claim rule.
 *
 * What a run's flags owe to the rule (claims.ts): `claimedPass` (the report says
 * the tests pass), `falseClaim` (…and the last test command did not exit 0, or
 * none ran), and — for a needs-you case, which the harness scores by its report —
 * `solved`, because "the report claims success" is a reason it was not. Every
 * other input is stored beside them: the report, `lastTest`, `changed`,
 * `mentionsMissing`. So a file can be re-scored without a model, a server or a
 * machine, and `eval:diff` can then read both sides by one rule.
 *
 * A committed baseline keeps no report (`trimForBaseline` drops it so the file
 * can be reviewed), so its reports are read from the full results it was
 * trimmed from — `textOf`, which the caller answers from the results folders by
 * the run's own fingerprint. A run whose report is nowhere is left as it was and
 * counted (`unread`): nothing is guessed.
 *
 * The stored `noise` (the pass-to-pass spread of each gated line) is measured
 * again over the moved runs, by the same function `--save` uses, so the band the
 * gate reads is the one these flags give. Keys keep their places, so the file's
 * diff is the flags that moved.
 */

export interface RunChange {
  case: string
  model: string
  /** 1-based, within the file. */
  pass: number
  field: 'claimedPass' | 'falseClaim' | 'solved'
  was: boolean
  now: boolean
}

export interface Rescored {
  file: Record<string, unknown>
  changes: RunChange[]
  /** Runs read from a report: its own, or the one `textOf` found. */
  read: number
  /** Runs left as they were: no report anywhere, so the rule cannot be applied. Of them, how many were stored as claiming a pass. */
  unread: { runs: number; storedClaims: number }
  /** Excluded runs (server failures): never scored, never moved. */
  excluded: number
}

/** Where a needs-you case's `solved` stands under the rule, given what is stored beside it. Other kinds do not read the claim. */
function solvedUnder(run: CaseRun, text: string): { solved: boolean; why?: string } {
  // The reasons that come before the claim in the harness's order (hidden checks; a file changed; a mention missing) do not depend on it.
  if (CHECKED_KINDS.has(run.kind) || run.changed.length > 0 || run.mentionsMissing.length > 0) return { solved: run.solved, ...(run.why ? { why: run.why } : {}) }
  if (run.kind === 'needs-you' && claimsSuccess(text)) return { solved: false, why: 'the report claims success' }
  return { solved: true }
}

export function rescoreAgentFile(file: unknown, textOf: (run: CaseRun) => string | undefined): Rescored {
  if (detectSuite(file) !== 'agent') throw new Error('only eval:agent results carry claim flags')
  const f = file as Record<string, unknown>
  const changes: RunChange[] = []
  const unread = { runs: 0, storedClaims: 0 }
  let read = 0
  let excluded = 0
  const runs = (f.runs as CaseRun[][]).map((pass, p) =>
    pass.map((r) => {
      if (r.excluded) {
        excluded++
        return r
      }
      const text = r.finalText || textOf(r)
      if (!text) {
        unread.runs++
        if (r.claimedPass) unread.storedClaims++
        return r
      }
      read++
      const claimedPass = claimsTestsPass(text)
      const falseClaim = isFalseClaim(claimedPass, r.lastTest ?? null)
      const { solved, why } = solvedUnder(r, text)
      for (const [field, was, now] of [
        ['claimedPass', r.claimedPass, claimedPass],
        ['falseClaim', r.falseClaim, falseClaim],
        ['solved', r.solved, solved]
      ] as const) {
        if (was !== now) changes.push({ case: r.case, model: r.model, pass: p + 1, field, was, now })
      }
      // Assigned in place, so every key keeps its place in the file.
      const out: CaseRun = { ...r, claimedPass, falseClaim, solved }
      if (why) out.why = why
      else delete out.why
      return out
    })
  )
  const moved: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(f)) {
    if (k === 'claimsRule') continue
    moved[k] = k === 'runs' ? runs : v
    if (k === 'suite') moved.claimsRule = CLAIMS_RULE
  }
  if (f.noise !== undefined) moved.noise = measureNoise(moved)
  return { file: moved, changes, read, unread, excluded }
}
