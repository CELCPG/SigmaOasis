import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRunRecord,
  toolSwitches,
  BEYOND_ANY_RECORD,
  CHECKING_PATHS,
  DELIBERATELY_NOT_RECORDED,
  OTHER_PATHS
} from '../scripts/h2h-record'
import { DEFAULT_TOOL_TOGGLES } from '../src/shared/tools'

/**
 * The record a run keeps, and the two things it must never quietly become.
 *
 * Round 10's record column was contested on four tasks of eighteen. On the other
 * fourteen the artifact that would settle a statement was not there, so every
 * statement counted unsettled and the column tied. A column that can only fire
 * where a record exists is measuring the record's coverage, not the app.
 *
 * The tempting repair is to make every task keep the app's session audit. It is
 * refused, for reasons this suite pins rather than leaves in a comment:
 *
 *   The audit is opt-in and off by default in the shipped product, and it is
 *   not free — encryption, hash chaining and a serialized disk append per user
 *   input, assistant output and tool call, in the process whose latency this
 *   bench publishes as the product's. Turning it on everywhere measures a
 *   configuration no user has.
 *
 *   And it would not settle the claims anyway. The audit's contents are what it
 *   is for: what was said, and nothing in between. No step boundaries, no
 *   playbook identity, no timings. Growing it to serve the bench is the same
 *   fault pointing the other way.
 *
 * So the record is assembled from what the harness already knows from outside
 * the app. What this file guards:
 *
 *   1. The record never claims to settle a claim it cannot. The list of things
 *      beyond any record is part of the artifact, not part of a reader's memory.
 *   2. The tool half is derived from the product's own table, so a tool added
 *      to the app cannot silently drop out of the record.
 *   3. Nothing that names one arm rather than the other gets in. The pair is
 *      judged blind, and a settings value carrying a port or a model id would
 *      end that on every task at once.
 */

type Settings = Record<string, unknown>

const LIVE: Settings = {
  baseUrl: 'http://127.0.0.1:56323/v1',
  models: [{ id: 'model-1', modelId: 'some-model-9b', systemPrompt: 'You are helpful.' }],
  theme: 'light',
  fontSize: 15,
  historyLimit: 100,
  tools: { ...DEFAULT_TOOL_TOGGLES, reference_lookup: true, web_search: false },
  workingDirectory: '/Users/someone/work',
  pipeline: ['model-1'],
  voice: { autoRead: false, voiceURI: '', rate: 1 },
  stt: { whisperCliPath: '', whisperModelPath: '' },
  memory: { autoContext: true, topK: 3, embeddingModel: '' },
  search: { provider: 'searxng', searxngUrl: 'http://127.0.0.1:9', maxResults: 8, confirmBeforeSearch: false, useHeadlessRenderer: false },
  research: { depth: 'standard', confirmPlan: false },
  proxy: { mode: 'none', host: '127.0.0.1', port: 9050 },
  updates: { autoCheck: false },
  onboardingCompleted: true,
  hideToolCalls: false,
  reasoningDisplay: 'collapsed',
  showResponseStats: true,
  sidebarCollapsed: false,
  rightPanelCollapsed: false,
  projects: [],
  contextManagement: 'compact',
  secondOpinion: { enabled: false, criticSlotId: null },
  claimCheck: { enabled: true, maxClaims: 5 },
  grounding: { autoCorrect: true, playbooks: true, selfReview: true, workbenchChecks: true, ledger: true },
  shopping: { requireProxy: true, maxSellers: 4, excludeTierX: true },
  audit: { enabled: false, autoPurgeOnQuit: false },
  plan: { maxSteps: 6, confirmPlan: true }
}

const toolNames = Object.keys(DEFAULT_TOOL_TOGGLES)

function build(over: Partial<Parameters<typeof buildRunRecord>[0]> = {}): ReturnType<typeof buildRunRecord> {
  return buildRunRecord(
    {
      settings: LIVE,
      library: [],
      libraryError: null,
      auditExport: null,
      fixtures: [],
      wallClockMs: 120_000,
      ...over
    },
    toolNames
  )
}

describe('the record says what it is a record of', () => {
  test('a run with no session audit says the app was never asked for one, not that it failed', () => {
    const rec = build()
    const absent = rec.notKept.find((n) => n.id === 'session-audit')
    assert.ok(absent, 'a run with no audit does not say so')
    assert.match(absent!.why, /opt-in/)
    assert.match(absent!.why, /property of the staging/)
    assert.ok(absent!.wouldHaveSettled.length > 0, 'an absent record that settles nothing is not worth naming')
    assert.equal(rec.kept.find((k) => k.id === 'session-audit'), undefined)
  })

  test('a run whose audit export failed says that instead, and does not claim the file', () => {
    const rec = build({ auditExport: { file: null, entries: null, error: 'the keychain refused' } })
    const absent = rec.notKept.find((n) => n.id === 'session-audit')
    assert.ok(absent)
    assert.match(absent!.why, /the keychain refused/)
    assert.doesNotMatch(absent!.why, /opt-in/)
  })

  test('a run that kept an audit lists it as kept, with the file', () => {
    const rec = build({ auditExport: { file: 'trace/audit.jsonl', entries: 6, error: null } })
    const kept = rec.kept.find((k) => k.id === 'session-audit')
    assert.ok(kept)
    assert.equal(kept!.file, 'trace/audit.jsonl')
    assert.equal(rec.notKept.find((n) => n.id === 'session-audit'), undefined)
  })

  test('a fixture that watched the wire is a record, and its absence is named', () => {
    const without = build()
    assert.ok(without.notKept.some((n) => n.id === 'fixture:lm-shim'))
    const withShim = build({ fixtures: [{ kind: 'lm-shim', file: 'fixtures/lm-shim.json', requestCount: 15 }] })
    assert.ok(withShim.kept.some((k) => k.id === 'fixture:lm-shim'))
    assert.equal(withShim.notKept.find((n) => n.id === 'fixture:lm-shim'), undefined)
  })

  /**
   * The third state, in the artifact rather than in each critic's head. A
   * duration the app timed with its own clock is not settled by the app writing
   * the same number down again, and a record that pretended otherwise would
   * manufacture agreement on every run.
   */
  test('what no record can settle is part of the record', () => {
    const rec = build()
    assert.ok(rec.beyondAnyRecord.length >= 5, 'the list of unsettleable claims is suspiciously short')
    for (const e of rec.beyondAnyRecord) {
      assert.ok(e.claim.trim().length > 0 && e.why.trim().length > 0, `an entry with no reason: ${e.claim}`)
    }
    const joined = rec.beyondAnyRecord.map((e) => `${e.claim} ${e.why}`).join(' ')
    assert.match(joined, /sandbox/, 'the sandbox start-up figure is not named')
    assert.match(joined, /playbook/, 'the method attribution is not named')
    assert.match(joined, /plan step|step boundaries/, 'plan step boundaries are not named')
    assert.match(joined, /budget/, 'the checking budget is not named')
  })

  test('the reason a self-timed figure cannot be settled is stated, not assumed', () => {
    const joined = BEYOND_ANY_RECORD.map((e) => e.why).join(' ')
    assert.match(joined, /written twice|second clock/)
  })

  test('an empty library is recorded as empty, which is what settles a claim to have used one', () => {
    assert.equal(build({ library: [] }).library.empty, true)
    assert.equal(build({ library: [{ id: 'food-safety', name: 'Food safety', version: '1', docs: 4, chunks: 60, embeddedChunks: 60 }] }).library.empty, false)
  })

  test('a library that could not be read is an error, never an empty one', () => {
    const rec = build({ library: null, libraryError: 'the list refused' })
    assert.equal(rec.library.empty, null)
    assert.equal(rec.library.error, 'the list refused')
  })

  test('the driver clock says it bounds rather than measures', () => {
    const rec = build()
    assert.equal(rec.driverClock.wallClockMs, 120_000)
    assert.match(rec.driverClock.note, /BOUNDS rather than measures/)
  })

  test('the configuration block says it settles capability and not exercise', () => {
    assert.match(build().configuration.note, /CAPABILITY and not exercise/)
  })
})

describe('the record covers the class, not a list someone remembered', () => {
  /**
   * The defect this project keeps finding in its own checks, guarded against
   * here: a hand-typed tool list would quietly stop covering a tool the product
   * gained, and the column would lose the ability to settle claims about it
   * without anything failing.
   */
  test('every tool the product ships is in the record', () => {
    const recorded = Object.keys(build().configuration.tools).sort()
    assert.deepEqual(recorded, Object.keys(DEFAULT_TOOL_TOGGLES).sort())
  })

  test('a switch this build does not have is null, not off', () => {
    const partial = toolSwitches({ tools: { reference_lookup: true } }, toolNames)
    assert.equal(partial.reference_lookup, true)
    assert.equal(partial.web_search, null)
  })

  /**
   * The pair is staged blind. Both arms must produce the same SET of keys
   * whatever they were built from, or the shape of the record becomes the tell.
   */
  test('both arms report the same switches even when one build has fewer', () => {
    const rich = toolSwitches(LIVE, toolNames)
    const poor = toolSwitches({ tools: { reference_lookup: true } }, toolNames)
    assert.deepEqual(Object.keys(rich), Object.keys(poor))
  })

  test('a settings group nobody has decided about is flagged in the artifact, not omitted', () => {
    const rec = buildRunRecord(
      {
        settings: { ...LIVE, somethingNew: { enabled: true } },
        library: [],
        libraryError: null,
        auditExport: null,
        fixtures: [],
        wallClockMs: 1
      },
      toolNames
    )
    assert.match(rec.configuration.notCovered.somethingNew ?? '', /UNDECIDED/)
  })

  test('a group left out on purpose carries the reason it was left out', () => {
    const notCovered = build().configuration.notCovered
    for (const [group, why] of Object.entries(notCovered)) {
      assert.ok(why.trim().length > 0, `${group} is omitted with no reason given`)
    }
    assert.match(notCovered.baseUrl ?? '', /port/)
    assert.match(notCovered.models ?? '', /de-blinder/)
  })

  test('every deliberate omission names a group that could plausibly appear', () => {
    for (const [group, why] of Object.entries(DELIBERATELY_NOT_RECORDED)) {
      assert.ok(why.trim().length > 0, `${group} is excluded with an empty reason`)
    }
  })
})

describe('nothing in the record names an arm', () => {
  /**
   * `_settings-in-app.json` is withheld from critics precisely because it
   * carries a loopback port, a filesystem path and a model id. This block is
   * the same data, filtered, and it goes into an artifact the critic reads. The
   * filter is therefore load-bearing and is checked against the values that
   * would break blinding rather than against the ones it happens to allow.
   */
  test('no recorded value carries a URL, a path, a port or a model id', () => {
    const rec = build()
    const values = [
      ...Object.values(rec.configuration.tools),
      ...Object.values(rec.configuration.checking),
      ...Object.values(rec.configuration.other)
    ]
    for (const v of values) {
      if (typeof v !== 'string') continue
      assert.doesNotMatch(v, /[/\\]/, `a recorded value looks like a path or URL: ${v}`)
      assert.doesNotMatch(v, /\d{4,}/, `a recorded value looks like a port: ${v}`)
      assert.ok(v.length <= 24, `a recorded value is long enough to be prose or an identifier: ${v}`)
    }
  })

  test('the settings paths the record reads are all short scalars, never prose or a location', () => {
    for (const p of [...CHECKING_PATHS, ...OTHER_PATHS]) {
      const leaf = p.split('.').pop()!
      assert.doesNotMatch(leaf, /Url|Path|Prompt|Directory|Id$/, `${p} names something that locates or identifies`)
    }
  })

  test('the whole record survives a search for the values that would de-blind it', () => {
    const serialized = JSON.stringify(build())
    for (const tell of ['127.0.0.1', 'some-model-9b', '/Users/someone/work', '56323']) {
      assert.ok(!serialized.includes(tell), `the record leaked ${tell}`)
    }
  })

  test('a run that installed packs records their identity and size, and nothing else', () => {
    const rec = build({
      library: [{ id: 'food-safety', name: 'Food safety', version: '2', docs: 4, chunks: 61, embeddedChunks: 61 }]
    })
    assert.deepEqual(Object.keys(rec.library.packs![0]).sort(), [
      'chunks',
      'docs',
      'embeddedChunks',
      'id',
      'name',
      'version'
    ])
  })
})
