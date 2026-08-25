/**
 * Preconditions — the environment facts a task's setup says must hold.
 *
 * The harness already refuses two kinds of half-run: a seeded setting the app
 * did not take, and a fixture that was stood up and never contacted. Both are
 * about things the harness itself put in place. This file covers the third
 * kind, which it cannot put in place: something the task needs from the machine
 * it runs on. TTU2's setup says "resources/pyodide present locally"; on a
 * checkout where it was not, every Python block failed with "Workbench runtime
 * not installed" and the run still scored VALID with no fixtures to catch it —
 * a confident-looking comparison of a path neither arm walked. Worse than a
 * crash, because a crash is visible.
 *
 * A task says what it needs in two places, and both are read:
 *   - implicitly, in the setup it already carries. `settings.tools.run_python`
 *     is what "run_python enabled ... resources/pyodide present locally" looks
 *     like once tasks.json's prose is written for a machine, so no new
 *     vocabulary is needed to enforce it;
 *   - explicitly, in task-setup.json's `requires: [...]`, for a need that no
 *     setting implies.
 * The two are unioned, deliberately: deleting `settings.tools.run_python` from
 * a task must not quietly delete the runtime check with it, and neither must
 * deleting `requires`. An id in `requires` that this file has no check for is
 * itself a failure — a typo must not read as "nothing to check".
 *
 * Each capability is probed twice, because either probe alone has a blind spot.
 * On disk, exactly where the app itself would look: that catches the absence
 * even when the model never called the tool, and it catches it whatever the
 * transcript happens to say. And in the transcript, where every attempt failing
 * on "not installed" catches a build whose layout the on-disk probe read wrong.
 * Either one is enough to make the run INVALID.
 */

import { existsSync } from 'fs'
import { join } from 'path'

/** A captured transcript block, as h2h-capture records them. */
export interface PreconditionBlock {
  kind: string
  header: string
  text: string
}

/** How the harness tells whether one declared capability was really there. */
export interface Capability {
  /** Plain-English name of the thing, for the reason a critic reads. */
  what: string
  /** What tasks.json's prose already calls it, quoted back in the reason. */
  setupPhrase: string
  /** What the transcript calls an attempt to use it, for the reason. */
  attemptName: string
  /** Where the app itself would look for it, given the build being driven. */
  onDisk(appRoot: string, mainDir: string): string[]
  /** A block that is an attempt to use the capability. */
  isAttempt(b: PreconditionBlock): boolean
  /** An attempt that failed because the capability was not installed at all. */
  isMissing(b: PreconditionBlock): boolean
}

export const CAPABILITIES: Record<string, Capability> = {
  'python-runtime': {
    what: 'the local Python runtime under resources/pyodide',
    setupPhrase: 'resources/pyodide present locally',
    attemptName: 'run_python',
    /**
     * Mirrors pyodideDir() in src/main/ipc/workbench.ts, including its test of
     * pyodide.js rather than of the directory — a half-finished fetch leaves
     * the directory there. The packaged branch of that function is not mirrored
     * because it is unreachable here: the harness always spawns an unpackaged
     * Electron, so app.isPackaged is false for every run it drives.
     */
    onDisk: (appRoot, mainDir) => {
      const env = process.env.SIGMA_PYODIDE_DIR
      if (env) return [join(env, 'pyodide.js')]
      return [
        join(appRoot, 'resources', 'pyodide', 'pyodide.js'),
        join(mainDir, '..', '..', 'resources', 'pyodide', 'pyodide.js')
      ]
    },
    // The block is rendered by RanCodeBlock, whose header reads "⚡ Ran Python";
    // kindOf() in the capture labels anything carrying ⚡ as 'ran-code'.
    isAttempt: (b) => b.kind === 'ran-code' || /ran python|run_python/i.test(b.header),
    // ensureSandbox()'s refusal, which reaches the block through the tool
    // result's error text.
    isMissing: (b) => /workbench runtime not installed/i.test(b.text)
  }
}

/**
 * Tool toggles that need more than the toggle. A tool absent from here is one
 * the app can always run once it is switched on; run_python is not, because it
 * needs a runtime that is fetched, not built.
 */
const TOOL_CAPABILITIES: Record<string, string> = { run_python: 'python-runtime' }

/** What this task needs: what its setup already implies, plus what it declares. */
export function requiredCapabilities(settings: unknown, declared: readonly string[] = []): string[] {
  const out = new Set<string>()
  for (const id of declared) if (String(id).trim()) out.add(String(id).trim())
  const tools = (settings as { tools?: Record<string, unknown> } | null | undefined)?.tools
  if (tools && typeof tools === 'object') {
    for (const [tool, capability] of Object.entries(TOOL_CAPABILITIES)) {
      if (tools[tool] === true) out.add(capability)
    }
  }
  return [...out].sort()
}

/** One capability's verdict, written into run.json beside the fixture reports. */
export interface PreconditionReport {
  capability: string
  /** null for an id no check exists for — which is itself a failure. */
  what: string | null
  /** The paths the app would have looked in, so a reader can go and look too. */
  onDiskChecked: string[]
  onDiskFound: boolean
  /** Blocks that tried to use it, and how many of those said it was absent. */
  attempts: number
  attemptsReportingMissing: number
  ok: boolean
  /** Plain-voice reason, in the same shape the fixture-bypass reason uses. */
  reason: string | null
}

/**
 * The verdict for every capability the task requires. A report per capability
 * whether it passed or not, so run.json shows the check ran rather than leaving
 * a reader to infer it from silence.
 */
export function checkPreconditions(input: {
  required: readonly string[]
  /** The build being driven — h2h-capture's appRoot. */
  appRoot: string
  /** The directory of that build's main entry, for the app's own fallback path. */
  mainDir: string
  /** Every block of the expanded transcript, in order. */
  blocks: readonly PreconditionBlock[]
}): PreconditionReport[] {
  const out: PreconditionReport[] = []
  for (const id of input.required) {
    const cap = CAPABILITIES[id]
    if (!cap) {
      out.push({
        capability: id,
        what: null,
        onDiskChecked: [],
        onDiskFound: false,
        attempts: 0,
        attemptsReportingMissing: 0,
        ok: false,
        reason:
          `the task's setup requires "${id}", which the harness has no check for — it cannot tell ` +
          'whether that precondition held, so this run cannot be scored as though it did'
      })
      continue
    }

    // Deduped: join() normalises, so the app's two candidates collapse to one
    // path under the standard out/main layout and the reason should say it once.
    const onDiskChecked = [...new Set(cap.onDisk(input.appRoot, input.mainDir))]
    const onDiskFound = onDiskChecked.some((p) => existsSync(p))
    const attemptBlocks = input.blocks.filter((b) => cap.isAttempt(b))
    const missing = attemptBlocks.filter((b) => cap.isMissing(b))
    const declared = `the task's setup requires ${cap.what} ("${cap.setupPhrase}")`

    let reason: string | null = null
    if (!onDiskFound) {
      reason =
        `${declared} and the build under test does not have it — nothing at ` +
        `${onDiskChecked.join(' or ')}, so this run did not exercise the path the task is about`
    } else if (attemptBlocks.length > 0 && missing.length === attemptBlocks.length) {
      reason =
        `${declared} and all ${attemptBlocks.length} ${cap.attemptName} ` +
        `block${attemptBlocks.length === 1 ? '' : 's'} failed because it was not installed — the app ` +
        'never had it, so this run did not exercise the path the task is about'
    }

    out.push({
      capability: id,
      what: cap.what,
      onDiskChecked,
      onDiskFound,
      attempts: attemptBlocks.length,
      attemptsReportingMissing: missing.length,
      ok: reason === null,
      reason
    })
  }
  return out
}
