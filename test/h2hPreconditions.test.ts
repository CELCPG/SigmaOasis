import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CAPABILITIES, checkPreconditions, requiredCapabilities } from '../scripts/h2h-preconditions'

/**
 * The capture harness must refuse a run whose task could not have exercised
 * what the task measures. It already refuses a run whose fixture went
 * uncontacted; it did not refuse a run whose *preconditions* never held, and a
 * blind critic found the hole on TTU2 — a run where the local Python runtime
 * was absent, every Python block failed on "Workbench runtime not installed",
 * and run.json still said "validity": "VALID" with an empty reason list.
 * Validity was computed from fixtures, TTU2 has none, so nothing could catch
 * it. That is a confident-looking comparison of a path neither arm walked.
 *
 * The decision itself is pinned here against real inputs. The wiring — that a
 * precondition reason reaches validityReasons, and that INVALID still exits 3
 * for h2h-run.sh to count — is read out of the harness sources, because
 * exercising it for real needs a built Electron app and a live model, and a
 * mock of those would only pin the mock.
 */

const SCRIPTS = join(__dirname, '..', '..', 'scripts')
const captureSrc = readFileSync(join(SCRIPTS, 'h2h-capture.ts'), 'utf-8')
const runnerSrc = readFileSync(join(SCRIPTS, 'h2h-run.sh'), 'utf-8')
const setup = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'docs', 'head-to-head', 'task-setup.json'), 'utf-8')
) as { tasks: Record<string, { settings?: { tools?: Record<string, boolean> }; requires?: string[] }> }

// The probe honours SIGMA_PYODIDE_DIR because the app it mirrors does. An
// ambient one would point every case at somebody else's runtime, so the cases
// that are not about the override start without it.
delete process.env.SIGMA_PYODIDE_DIR

/** A build root with resources/pyodide fetched, or without. */
function build(withRuntime: boolean): { appRoot: string; mainDir: string } {
  const appRoot = mkdtempSync(join(tmpdir(), 'sigma-h2h-'))
  mkdirSync(join(appRoot, 'out', 'main'), { recursive: true })
  if (withRuntime) {
    mkdirSync(join(appRoot, 'resources', 'pyodide'), { recursive: true })
    writeFileSync(join(appRoot, 'resources', 'pyodide', 'pyodide.js'), '// runtime')
  }
  return { appRoot, mainDir: join(appRoot, 'out', 'main') }
}

const ranPython = (text: string) => ({ kind: 'ran-code', header: '✗ ⚡ Ran Python run failed', text })

/**
 * The app's own refusal, read out of its source rather than restated here. A
 * copy would go on matching a sentence the app had stopped printing, and the
 * detector would quietly stop catching the one thing it exists to catch.
 */
const APP_REFUSAL = (
  readFileSync(join(__dirname, '..', '..', 'src', 'main', 'ipc', 'workbench.ts'), 'utf-8').match(
    /`(Workbench runtime not installed[^`]*)`/
  )?.[1] ?? ''
).replace('${pyodideDir()}', '/repo/resources/pyodide')

/** That refusal as it reaches the block, wrapped by workbenchFormat's failure shape. */
const RUNTIME_ABSENT = `Python run failed after 3 ms.\n\nerror:\n${APP_REFUSAL}\n\nFix the code and run again — do not guess at the value it would have produced.`

describe('a declared precondition that did not hold', () => {
  test("the detector is matched against the app's own refusal, so a reworded one cannot slip past", () => {
    assert.ok(
      APP_REFUSAL.startsWith('Workbench runtime not installed ('),
      'src/main/ipc/workbench.ts no longer prints that sentence — the detector in ' +
        'scripts/h2h-preconditions.ts must be moved to whatever it prints now'
    )
    assert.ok(CAPABILITIES['python-runtime'].isMissing({ kind: 'ran-code', header: '', text: RUNTIME_ABSENT }))
  })

  test("TTU2's run-2: the runtime was absent and every Python block failed on it — INVALID, naming it", () => {
    const { appRoot, mainDir } = build(false)
    const reports = checkPreconditions({
      required: requiredCapabilities({ tools: { run_python: true } }, []),
      appRoot,
      mainDir,
      blocks: [ranPython(RUNTIME_ABSENT), ranPython(RUNTIME_ABSENT)]
    })
    assert.equal(reports.length, 1)
    const [r] = reports
    assert.equal(r.capability, 'python-runtime')
    assert.equal(r.ok, false)
    // The reason must say which precondition failed, not merely that one did.
    assert.match(r.reason ?? '', /resources\/pyodide/)
    assert.match(r.reason ?? '', /did not exercise the path the task is about/)
    // And the harness turns any reason at all into INVALID.
    assert.equal(reports.filter((p) => p.reason).length ? 'INVALID' : 'VALID', 'INVALID')
  })

  test('the runtime is absent even though the model never called run_python — still INVALID', () => {
    const { appRoot, mainDir } = build(false)
    const [r] = checkPreconditions({ required: ['python-runtime'], appRoot, mainDir, blocks: [] })
    assert.equal(r.ok, false)
    assert.equal(r.attempts, 0)
    assert.equal(r.onDiskFound, false)
    assert.match(r.reason ?? '', /the build under test does not have it/)
  })

  test('the runtime is on disk but every attempt still reported it missing — INVALID', () => {
    const { appRoot, mainDir } = build(true)
    const [r] = checkPreconditions({
      required: ['python-runtime'],
      appRoot,
      mainDir,
      blocks: [ranPython(RUNTIME_ABSENT), { kind: 'tool-call', header: '✓ reference_lookup', text: 'ok' }]
    })
    assert.equal(r.onDiskFound, true)
    assert.equal(r.attempts, 1)
    assert.equal(r.attemptsReportingMissing, 1)
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /all 1 run_python block failed because it was not installed/)
  })

  test('a required capability the harness cannot check is a failure, not a pass', () => {
    const { appRoot, mainDir } = build(true)
    const [r] = checkPreconditions({ required: ['gpu-offload'], appRoot, mainDir, blocks: [] })
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /"gpu-offload", which the harness has no check for/)
  })
})

describe('a precondition that held', () => {
  test('the runtime is on disk and Python ran — VALID, and the check is still reported', () => {
    const { appRoot, mainDir } = build(true)
    const [r] = checkPreconditions({
      required: ['python-runtime'],
      appRoot,
      mainDir,
      blocks: [{ kind: 'ran-code', header: '✓ ⚡ Ran Python ran in 1.5 s', text: 'Python ran in 1512 ms.\n\nstdout:\n824693' }]
    })
    assert.equal(r.ok, true)
    assert.equal(r.reason, null)
    assert.equal(r.attempts, 1)
    assert.equal(r.attemptsReportingMissing, 0)
  })

  test('one failed run among several is the task failing, not the precondition', () => {
    const { appRoot, mainDir } = build(true)
    const [r] = checkPreconditions({
      required: ['python-runtime'],
      appRoot,
      mainDir,
      blocks: [ranPython(RUNTIME_ABSENT), { kind: 'ran-code', header: '✓ ⚡ Ran Python', text: 'Python ran in 40 ms.' }]
    })
    assert.equal(r.ok, true)
  })

  test('a task that requires nothing is unaffected', () => {
    const { appRoot, mainDir } = build(false)
    assert.deepEqual(checkPreconditions({ required: [], appRoot, mainDir, blocks: [] }), [])
    assert.deepEqual(requiredCapabilities({ tools: { reference_lookup: true, web_search: true } }, []), [])
  })

  test('the probe looks where the app would, SIGMA_PYODIDE_DIR included', () => {
    const { appRoot, mainDir } = build(true)
    try {
      process.env.SIGMA_PYODIDE_DIR = join(appRoot, 'elsewhere')
      const [away] = checkPreconditions({ required: ['python-runtime'], appRoot, mainDir, blocks: [] })
      assert.equal(away.onDiskFound, false, 'the override is where the app would look, so the default path is not')
      process.env.SIGMA_PYODIDE_DIR = join(appRoot, 'resources', 'pyodide')
      const [here] = checkPreconditions({ required: ['python-runtime'], appRoot, mainDir, blocks: [] })
      assert.equal(here.onDiskFound, true)
    } finally {
      delete process.env.SIGMA_PYODIDE_DIR
    }
  })
})

describe('what a task declares', () => {
  test('the setting a task already carries is the declaration — no second vocabulary needed', () => {
    assert.deepEqual(requiredCapabilities({ tools: { run_python: true } }, []), ['python-runtime'])
    assert.deepEqual(requiredCapabilities({ tools: { run_python: false } }, []), [])
    assert.deepEqual(requiredCapabilities(null, []), [])
  })

  test('an explicit requires is unioned with it, so deleting either still holds the run to it', () => {
    assert.deepEqual(requiredCapabilities({ tools: { run_python: true } }, ['python-runtime']), ['python-runtime'])
    assert.deepEqual(requiredCapabilities({}, ['python-runtime']), ['python-runtime'])
  })

  test('TTU2 declares the runtime both ways, and task-setup.json uses no id the harness cannot check', () => {
    const ttu2 = setup.tasks.TTU2
    assert.deepEqual(ttu2.requires, ['python-runtime'])
    assert.ok(requiredCapabilities(ttu2.settings, ttu2.requires).includes('python-runtime'))
    assert.ok(requiredCapabilities(ttu2.settings, []).includes('python-runtime'), 'derivable without requires')
    for (const [id, t] of Object.entries(setup.tasks)) {
      for (const cap of t.requires ?? []) {
        assert.ok(CAPABILITIES[cap], `task ${id} requires "${cap}", which scripts/h2h-preconditions.ts cannot check`)
      }
    }
  })
})

describe('the harness acts on it', () => {
  /** assert.ok, not assert.match: a failed match prints the whole 80 kB source. */
  const has = (src: string, re: RegExp, why: string): void => assert.ok(re.test(src), why)

  test('a precondition reason reaches validityReasons, so the run is marked INVALID', () => {
    has(
      captureSrc,
      /const preconditionReports = checkPreconditions\(/,
      'h2h-capture never checks preconditions: validity is computed from fixtures alone'
    )
    has(
      captureSrc,
      /for \(const p of preconditionReports\) if \(p\.reason\) validityReasons\.push\(p\.reason\)/,
      'h2h-capture checks preconditions but no failed one reaches validityReasons'
    )
    has(
      captureSrc,
      /const validity = validityReasons\.length \? 'INVALID' : 'VALID'/,
      'any validity reason at all must make the run INVALID'
    )
  })

  test('INVALID still exits 3, which is what h2h-run.sh counts as INVALID rather than captured', () => {
    has(captureSrc, /if \(validity === 'INVALID'\) process\.exitCode = 3/, 'INVALID no longer exits 3')
    has(runnerSrc, /STATUS" = "3" \]; then INVALID\+=/, 'h2h-run.sh no longer counts exit 3 in the INVALID column')
  })

  test("the runner forwards a task's requires to the capture", () => {
    has(runnerSrc, /eff\.requires[\s\S]{0,80}--requires/, 'a task can declare requires but h2h-run.sh drops it')
  })
})
