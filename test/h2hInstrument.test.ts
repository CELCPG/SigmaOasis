import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CAPTURE_SOURCE,
  compareInstruments,
  describeInstrument,
  readMeasures,
  staleInstrumentMessage
} from '../scripts/h2h-instrument'

/**
 * The harness must be able to say what it is, and must refuse to measure a
 * build it is behind.
 *
 * Round 10 built three paint-settling measurements into the capture and then
 * ran its sweep from a checkout that did not have them. All 36 run.json files
 * came out without the fields. Both arms used the same harness, so the
 * comparison was fair and nothing in the tooling objected; the only reason it
 * surfaced at all is that a blind critic reported a question as unanswerable
 * instead of inventing a reading for it.
 *
 * Two separate things are pinned here.
 *
 *   THE DECISION — what a harness declares it can measure, and whether one
 *   harness is fit to measure a build whose own checkout carries another. Run
 *   against real inputs, including the repo's actual capture source.
 *
 *   THE WIRING — that the decision is reached before anything is captured,
 *   that its refusal has its own exit code, that the runner stops the sweep on
 *   that code, and that the provenance recorded in the blind artifact contains
 *   nothing that distinguishes the arms. Some of this is read out of the
 *   harness sources, because exercising it for real needs a built Electron app
 *   and a live model, and a mock of those would only pin the mock. The staging
 *   guard, which needs neither, is exercised for real.
 */

const ROOT = join(__dirname, '..', '..')
const SCRIPTS = join(ROOT, 'scripts')
const CAPTURE = readFileSync(join(SCRIPTS, 'h2h-capture.ts'), 'utf8')
const RUNNER = readFileSync(join(SCRIPTS, 'h2h-run.sh'), 'utf8')
const PAIRS = join(ROOT, 'docs', 'head-to-head', 'make-blind-pairs.mjs')

/** The four figures round 10 added, and the reason this guard exists. */
const ROUND_10_MEASURES = [
  'streamEdgeAtTurnEnd',
  'streamEdgeClearedMs',
  'textGrewAfterTurnEndChars',
  'textSettledMs'
]

/** A checkout with just enough harness in it to be read. */
function fakeCheckout(turnRecordFields: string[], definitionFields: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'h2h-instrument-'))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  const src = [
    'interface TurnRecord {',
    ...turnRecordFields.map((f) => `  ${f}: number | null`),
    '}',
    '',
    'const run = {',
    '  timings: {',
    '    definitions: {',
    ...definitionFields.map((f) => `      ${f}: 'what ${f} means',`),
    '    }',
    '  }',
    '}'
  ].join('\n')
  writeFileSync(join(dir, 'scripts', 'h2h-capture.ts'), src)
  return dir
}

describe('what a harness says it can measure', () => {
  test('reads the vocabulary out of both places a harness declares it', () => {
    const measures = readMeasures(
      [
        'interface TurnRecord {',
        '  index: number',
        '  textSettledMs: number | null',
        '}',
        'const x = { definitions: { firstVisible: "a", turnEnd: "b" } }'
      ].join('\n')
    )
    assert.deepEqual(measures, ['firstVisible', 'index', 'textSettledMs', 'turnEnd'])
  })

  test('a source with neither declaration reads as unknown, not as empty', () => {
    // The distinction is the whole point of the guard: "measures nothing" would
    // make every comparison against it pass trivially.
    assert.equal(readMeasures('const x = 1'), null)
    assert.equal(readMeasures(''), null)
  })

  test('braces and colons inside prose and comments do not become measurements', () => {
    const measures = readMeasures(
      [
        'interface TurnRecord {',
        '  index: number',
        '}',
        'const x = { definitions: {',
        "  turnEnd: 'the composer { leaving } its streaming state: see below',",
        '  // notAMeasure: this is a comment',
        '  /* alsoNot: a block comment { with a brace */',
        '} }'
      ].join('\n')
    )
    assert.deepEqual(measures, ['index', 'turnEnd'])
  })

  test('a nested object inside the block does not leak its keys upward', () => {
    const measures = readMeasures(
      ['const x = { definitions: {', '  turnEnd: { inner: 1 },', '  firstVisible: 2', '} }'].join('\n')
    )
    assert.deepEqual(measures, ['firstVisible', 'turnEnd'])
  })

  /**
   * The extractor is a heuristic over real TypeScript, so it is pinned against
   * the actual file it has to read rather than only against samples written to
   * suit it. If masking or brace-counting ever stops coping with the harness's
   * real syntax, this fails — instead of the guard quietly reading a short
   * vocabulary and waving a stale sweep through.
   */
  test('reads the repo\'s own capture source, including round 10\'s fields', () => {
    const measures = readMeasures(CAPTURE)
    assert.ok(measures, 'the repo\'s capture source must be readable')
    for (const m of ROUND_10_MEASURES) {
      assert.ok(measures.includes(m), `${m} should be read out of the real capture source`)
    }
    for (const m of ['firstVisible', 'turnEnd', 'sendToFirstVisibleMs', 'sendToTurnEndMs', 'endReason']) {
      assert.ok(measures.includes(m), `${m} should be read out of the real capture source`)
    }
    // Prose keys from neighbouring blocks must not be swept in as measurements.
    for (const m of ['clock', 'samplingNote', 'turnNote', 'note']) {
      assert.ok(!measures.includes(m), `${m} is commentary, not a measurement`)
    }
  })

  test('describeInstrument fingerprints the checkout it was pointed at', () => {
    const a = describeInstrument(ROOT)
    assert.equal(a.sourceAvailable, true)
    assert.ok(a.sourceSha && /^[0-9a-f]{12}$/.test(a.sourceSha))
    assert.ok(a.sources.includes(CAPTURE_SOURCE))
    // Same input, same fingerprint; a different checkout, a different one.
    assert.equal(describeInstrument(ROOT).sourceSha, a.sourceSha)
    const other = describeInstrument(fakeCheckout(['index'], ['turnEnd']))
    assert.notEqual(other.sourceSha, a.sourceSha)
  })

  test('a root with no harness in it is reported absent, not empty', () => {
    const empty = describeInstrument(mkdtempSync(join(tmpdir(), 'h2h-empty-')))
    assert.equal(empty.sourceAvailable, false)
    assert.equal(empty.sourceSha, null)
    assert.equal(empty.measures, null)
  })
})

describe('is this harness fit to measure this build', () => {
  /**
   * Round 10, reconstructed. The harness knows the old vocabulary; the build
   * under test carries a harness that knows the new one. Every run this pairing
   * produces is missing the round's own work.
   */
  test('refuses a harness that is behind the build it was pointed at', () => {
    const harness = describeInstrument(fakeCheckout(['index', 'endReason'], ['firstVisible', 'turnEnd']))
    const app = describeInstrument(
      fakeCheckout(['index', 'endReason', 'textSettledMs'], ['firstVisible', 'turnEnd', 'textGrewAfterTurnEndChars'])
    )
    const verdict = compareInstruments(harness, app)
    assert.equal(verdict.ok, false)
    assert.deepEqual(verdict.behind, ['textGrewAfterTurnEndChars', 'textSettledMs'])
    assert.deepEqual(verdict.ahead, [])

    // The refusal has to name the fields, or the reader is sent back to
    // diffing two checkouts by hand — which is the work the guard exists to do.
    const message = staleInstrumentMessage(verdict, harness, app)
    for (const m of ['textSettledMs', 'textGrewAfterTurnEndChars']) assert.ok(message.includes(m))
    assert.ok(message.includes(app.root), 'the refusal must say which build it is about')
    assert.ok(message.includes(harness.root), 'the refusal must say which harness ran')
  })

  /**
   * The arm-A exemption, and it is structural rather than a flag.
   *
   * The baseline arm is always an older commit, so its copy of the harness
   * always knows less. Requiring equality would make every baseline capture
   * impossible; requiring a subset in this direction lets the baseline through
   * without anyone having to remember to say so.
   */
  test('allows a harness that is ahead of the build it was pointed at', () => {
    const harness = describeInstrument(
      fakeCheckout(['index', 'textSettledMs'], ['firstVisible', 'turnEnd', 'textGrewAfterTurnEndChars'])
    )
    const baseline = describeInstrument(fakeCheckout(['index'], ['firstVisible', 'turnEnd']))
    const verdict = compareInstruments(harness, baseline)
    assert.equal(verdict.ok, true)
    assert.deepEqual(verdict.behind, [])
    assert.deepEqual(verdict.ahead, ['textGrewAfterTurnEndChars', 'textSettledMs'])
  })

  test('an identical checkout is fit and reports nothing on either side', () => {
    const same = describeInstrument(ROOT)
    const verdict = compareInstruments(same, same)
    assert.equal(verdict.ok, true)
    assert.deepEqual(verdict.behind, [])
    assert.deepEqual(verdict.ahead, [])
    assert.equal(verdict.skipped, null)
  })

  /**
   * "We could not check" and "we checked and it was fine" are different
   * answers. A packaged build carries no sources, and that has to read as a
   * gap in the check rather than as a pass.
   */
  test('a build with no harness in it skips the check and says so', () => {
    const harness = describeInstrument(ROOT)
    const packaged = describeInstrument(mkdtempSync(join(tmpdir(), 'h2h-packaged-')))
    const verdict = compareInstruments(harness, packaged)
    assert.equal(verdict.ok, true)
    assert.ok(verdict.skipped, 'a skipped check must state why it was skipped')
    assert.ok(verdict.skipped.includes(CAPTURE_SOURCE))
  })
})

describe('the guard is wired into the capture', () => {
  test('the decision is made before anything is captured', () => {
    const guard = CAPTURE.indexOf('compareInstruments(invokedInstrument, appInstrument)')
    const runDir = CAPTURE.indexOf('const runDir = join(args.outRoot')
    assert.ok(guard > 0, 'the capture must compare the two instruments')
    assert.ok(runDir > 0)
    assert.ok(
      guard < runDir,
      'the instrument check must run before the run directory is made, so a stale sweep leaves nothing behind'
    )
  })

  test('a stale harness exits 5, distinct from INVALID and from a crash', () => {
    assert.ok(/if \(!instrumentVerdict\.ok\) \{[\s\S]*?process\.exit\(5\)/.test(CAPTURE))
    // 3 is INVALID and 1 is a crash; both mean something else entirely to the runner.
    assert.ok(CAPTURE.includes('process.exitCode = 3'), 'INVALID must keep its own code')
  })

  test('the runner aborts the whole sweep on 5 rather than retrying every task', () => {
    assert.ok(/if \[ "\$STATUS" = "5" \]; then/.test(RUNNER))
    assert.ok(/SWEEP ABORTED/.test(RUNNER))
    assert.ok(/exit 5/.test(RUNNER))
    const abort = RUNNER.indexOf('if [ "$STATUS" = "5" ]')
    const tally = RUNNER.indexOf('if [ "$STATUS" = "0" ]; then OK+=')
    assert.ok(abort < tally, 'the abort must be decided before the task is tallied as a mere failure')
  })
})

describe('the provenance in a blind artifact is not an arm tell', () => {
  /**
   * `instrument` is staged into the blind pair — a critic has to read
   * `measures` to know what the silence in a field means. That is only safe
   * because every field of it describes the HARNESS, which is identical in both
   * arms. Anything derived from the build is arm-identifying: the fit check
   * reports the harness "ahead of" the older arm and level with the newer one,
   * which labels the pair as neatly as a version number would.
   */
  test('run.json records the harness and nothing about the build it drove', () => {
    const block = CAPTURE.slice(CAPTURE.indexOf('instrument: {'), CAPTURE.indexOf('taskId: args.taskId'))
    assert.ok(block.includes('invokedInstrument.measures'), 'the measure set must reach run.json')
    assert.ok(block.includes('invokedInstrument.sourceSha'))
    for (const leak of ['appInstrument', 'instrumentVerdict', 'appRoot', 'ahead', 'behind']) {
      assert.ok(!block.includes(leak), `run.json's instrument block must not carry ${leak}`)
    }
  })

  test('the fit check and the build\'s own harness live in the identifying sidecar', () => {
    const sidecar = CAPTURE.slice(CAPTURE.indexOf("join(runDir, '_arm.json')"), CAPTURE.indexOf('await shutdown()'))
    assert.ok(sidecar.includes('appHarness'), 'the build\'s copy of the harness belongs in _arm.json')
    assert.ok(sidecar.includes('harnessAheadOfApp'))
    assert.ok(sidecar.includes('harnessBehindApp'))
  })

  test('the staging scrubber knows about the build\'s harness path', () => {
    const staging = readFileSync(PAIRS, 'utf8')
    assert.ok(
      /appHarness\?\.path/.test(staging),
      'armTells must collect the app harness path so assertBlind actually searches for it'
    )
  })
})

/**
 * The staging guard, exercised rather than described.
 *
 * make-blind-pairs.mjs is a plain script over directories, so the failure can
 * be planted for real: two arms whose runs record different harnesses.
 */
describe('staging refuses two arms measured by different harnesses', () => {
  const stage = (
    aInstrument: unknown,
    bInstrument: unknown
  ): { status: number; stderr: string; outDir: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'h2h-stage-'))
    for (const [arm, instrument] of [
      ['A', aInstrument],
      ['B', bInstrument]
    ] as const) {
      const runDir = join(dir, arm, 'V1-20260828-101112')
      mkdirSync(runDir, { recursive: true })
      const run: Record<string, unknown> = { schema: 'h2h-capture/2', taskId: 'V1', reply: { chars: 1 } }
      if (instrument !== null) run.instrument = instrument
      writeFileSync(join(runDir, 'run.json'), JSON.stringify(run, null, 2))
      writeFileSync(
        join(runDir, '_arm.json'),
        JSON.stringify({ arm, appVersion: '2.0.0', appRoot: `/builds/${arm}` }, null, 2)
      )
      writeFileSync(join(runDir, 'reply.txt'), 'hello')
    }
    try {
      execFileSync(process.execPath, [PAIRS, join(dir, 'A'), join(dir, 'B'), join(dir, 'out'), 'salt'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })
      return { status: 0, stderr: '', outDir: join(dir, 'out') }
    } catch (err) {
      const e = err as { status?: number; stderr?: string }
      return { status: e.status ?? -1, stderr: e.stderr ?? '', outDir: join(dir, 'out') }
    }
  }

  const INSTRUMENT = { sourceSha: 'aaaaaaaaaaaa', measures: ['firstVisible', 'turnEnd'] }

  /**
   * The block has to REACH the critic, not merely survive being written. If
   * staging dropped or scrubbed it, the artifact would be back to a silence
   * that cannot be told from a zero — the original defect, one layer along.
   */
  test('one harness, both arms: staged, and the block reaches the critic', () => {
    const { status, outDir } = stage(INSTRUMENT, { ...INSTRUMENT })
    assert.equal(status, 0)
    for (const run of ['run-1', 'run-2']) {
      const staged = JSON.parse(readFileSync(join(outDir, 'V1', run, 'run.json'), 'utf8'))
      assert.deepEqual(staged.instrument.measures, ['firstVisible', 'turnEnd'])
      assert.equal(staged.instrument.sourceSha, 'aaaaaaaaaaaa')
    }
  })

  test('two different harnesses: refused, naming both', () => {
    const { status, stderr } = stage(INSTRUMENT, { ...INSTRUMENT, sourceSha: 'bbbbbbbbbbbb' })
    assert.equal(status, 1)
    assert.ok(stderr.includes('STAGING REFUSED'))
    assert.ok(stderr.includes('aaaaaaaaaaaa') && stderr.includes('bbbbbbbbbbbb'))
  })

  /**
   * Same fingerprint but a different measure set cannot happen honestly — the
   * fingerprint covers the source the set is read from. It is checked anyway,
   * because the alternative is trusting a hash to imply a fact it is only
   * correlated with.
   */
  test('same fingerprint, different measure sets: refused', () => {
    const { status, stderr } = stage(INSTRUMENT, { ...INSTRUMENT, measures: ['firstVisible'] })
    assert.equal(status, 1)
    assert.ok(stderr.includes('different measure sets'))
  })

  test('one arm records an instrument and the other does not: refused', () => {
    const { status, stderr } = stage(INSTRUMENT, null)
    assert.equal(status, 1)
    assert.ok(stderr.includes('one run records its instrument and the other does not'))
  })

  /**
   * Rounds captured before the block existed carry nothing to compare, and
   * re-staging them must still work — the same treatment assertSameVersion
   * gives an unreadable sidecar. This is also the honest limit of the guard:
   * it cannot retrospectively judge round 10's artifacts.
   */
  test('neither arm records an instrument: staged, as legacy runs', () => {
    const { status } = stage(null, null)
    assert.equal(status, 0)
  })
})
