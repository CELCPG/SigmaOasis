import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * Layer 0c — measured tool-choice scores, surfaced in the model picker.
 *
 * The eval harness (scripts/eval-tools.ts) writes one JSON per run to
 * .eval-results/, and slow models are evaluated in chunks — several partial
 * files per model, plus retries of individual fixtures. This module folds
 * those files into one summary per model: per fixture, the LATEST run wins,
 * so a retried timeout replaces its earlier error instead of double-counting.
 *
 * Electron-free on purpose: the aggregation is exercised by node:test, and
 * the IPC handler in main/index.ts is a thin shell over readEvalResults().
 */

export interface EvalRate {
  hit: number
  of: number
}

export interface EvalScoreSummary {
  model: string
  /** ISO timestamp of the newest run folded into this summary. */
  ranAt: string
  correctTool: EvalRate
  spuriousCall: EvalRate
  argValidity: EvalRate
  loop: EvalRate
}

/** The run record the eval harness writes per fixture (scripts/eval-tools.ts). */
export interface EvalFixtureRun {
  file: string
  expect: { tool: string } | 'no_tool'
  round1Calls: string[]
  allCalls: { name: string; valid: boolean; errors: string[] }[]
  stopReason: string
  correct: boolean | null
  spurious: boolean | null
  looped: boolean
  error?: string
}

export interface EvalResultFile {
  model: string
  ranAt: string
  runs: EvalFixtureRun[]
}

/**
 * Fold any number of eval result files into one summary per model. Per
 * (model, fixture) the run from the newest file wins; files whose JSON does
 * not match the harness shape are skipped rather than fatal.
 */
export function aggregateEvalFiles(files: EvalResultFile[]): EvalScoreSummary[] {
  const valid = files.filter(
    (f) => typeof f?.model === 'string' && typeof f?.ranAt === 'string' && Array.isArray(f?.runs)
  )
  // Fold oldest-first so a per-fixture overwrite is newest-wins — a retried
  // fixture replaces its earlier error instead of double-counting.
  valid.sort((a, b) => (a.ranAt < b.ranAt ? -1 : a.ranAt > b.ranAt ? 1 : 0))
  const byModel = new Map<string, { ranAt: string; perFixture: Map<string, EvalFixtureRun> }>()
  for (const f of valid) {
    let entry = byModel.get(f.model)
    if (!entry) {
      entry = { ranAt: f.ranAt, perFixture: new Map() }
      byModel.set(f.model, entry)
    }
    entry.ranAt = f.ranAt
    for (const run of f.runs) {
      if (typeof run?.file === 'string') entry.perFixture.set(run.file, run)
    }
  }

  const summaries: EvalScoreSummary[] = []
  for (const [model, entry] of byModel) {
    const runs = [...entry.perFixture.values()]
    const needTool = runs.filter((r) => r.expect !== 'no_tool' && !r.error)
    const noTool = runs.filter((r) => r.expect === 'no_tool' && !r.error)
    const calls = runs.filter((r) => !r.error).flatMap((r) => r.allCalls ?? [])
    summaries.push({
      model,
      ranAt: entry.ranAt,
      correctTool: { hit: needTool.filter((r) => r.correct === true).length, of: needTool.length },
      spuriousCall: { hit: noTool.filter((r) => r.spurious === true).length, of: noTool.length },
      argValidity: { hit: calls.filter((c) => c.valid).length, of: calls.length },
      loop: { hit: runs.filter((r) => r.looped).length, of: runs.length }
    })
  }
  return summaries.sort((a, b) => a.model.localeCompare(b.model))
}

/**
 * Read every tool-choice result file in the eval results directory and fold
 * them into per-model summaries. A missing directory (a packaged app, a fresh
 * checkout before the first eval) is an empty result, never an error.
 */
export function readEvalResults(dir: string): EvalScoreSummary[] {
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.startsWith('toolchoice-') && n.endsWith('.json'))
  } catch {
    return []
  }
  const files: EvalResultFile[] = []
  for (const name of names) {
    try {
      files.push(JSON.parse(readFileSync(join(dir, name), 'utf-8')) as EvalResultFile)
    } catch {
      // A truncated or hand-edited file is skipped, not fatal.
    }
  }
  return aggregateEvalFiles(files)
}


// ---- in-app eval runner support (Layer 0c) --------------------------------------

export interface EvalFixtureFile {
  file: string
  prompt: string
  expect: { tool: string } | 'no_tool'
}

/**
 * Load the tool-choice fixtures from the repo's test directory. Dev-only by
 * nature — a packaged app has no test tree, and the empty list tells the UI
 * to say so. Validation mirrors the CLI: a fixture must name a prompt and an
 * expectation, and the expected tool must be in the shipped toolbox.
 */
export function readEvalFixtures(dir: string, validToolNames: string[]): EvalFixtureFile[] {
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort()
  } catch {
    return []
  }
  const fixtures: EvalFixtureFile[] = []
  for (const name of names) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as {
        prompt?: unknown
        expect?: unknown
      }
      if (typeof raw.prompt !== 'string' || !raw.prompt) continue
      const e = raw.expect
      if (e === 'no_tool') {
        fixtures.push({ file: name, prompt: raw.prompt, expect: 'no_tool' })
      } else if (e && typeof e === 'object' && typeof (e as { tool?: unknown }).tool === 'string') {
        const tool = (e as { tool: string }).tool
        if (validToolNames.includes(tool)) {
          fixtures.push({ file: name, prompt: raw.prompt, expect: { tool } })
        }
      }
    } catch {
      // A malformed fixture is skipped, not fatal.
    }
  }
  return fixtures
}

/**
 * Persist one model's eval run to the results directory, using the same
 * filename convention as the CLI so readEvalResults() folds it in. The
 * payload is renderer-supplied, so it is validated before it touches disk.
 */
export function saveEvalResult(
  dir: string,
  payload: unknown
): { ok: boolean; error?: string } {
  const p = payload as { model?: unknown; runs?: unknown }
  if (typeof p?.model !== 'string' || !p.model || !Array.isArray(p?.runs)) {
    return { ok: false, error: 'eval result payload needs a model and runs' }
  }
  try {
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const file = join(dir, `toolchoice-${p.model.replace(/[^a-z0-9._-]+/gi, '_')}-${stamp}.json`)
    writeFileSync(file, JSON.stringify(payload, null, 2))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
