/**
 * THE RUN'S OWN RECORD, ENUMERATED.
 *
 * One of the two questions asked of every task is whether what the application
 * says about a turn agrees with what the run's own record shows the turn did.
 * Round 10 put that question to eighteen tasks and found something to bite on
 * in four of them, and the critics all gave the same reason: on the other
 * fourteen there was no record. `trace/audit.jsonl` is written only when the
 * task asked the app to keep a session audit, and three tasks of eighteen ask.
 *
 * The obvious repair is to make every task ask. It is the wrong repair, twice
 * over, and both halves matter enough to state here rather than in a commit
 * message.
 *
 *   The audit is opt-in and off by default in the shipped product. Turning it
 *   on for all eighteen tasks measures eighteen runs of a configuration no
 *   user has unless they went and chose it — and not a free one: every user
 *   input, every assistant output and every tool call is then encrypted with
 *   the machine keychain, hash-chained against the previous line, and appended
 *   to disk through a serialized queue, in the same process whose latency this
 *   bench publishes as the product's. The project spent three rounds
 *   recovering from a baseline arm that was quietly not the shipped app. This
 *   would be that fault again, applied evenly to both arms, which makes it
 *   harder to see rather than less of a fault.
 *
 *   And it would not work. The audit's contents are fixed by what it is FOR:
 *   an append-only transcript of what was said, with no system prompts, no
 *   recalled memory and no compaction notes, so that a user can verify a
 *   session. Session start, user input, assistant output, tool call. It has no
 *   playbook identity and no timings. To make it settle those the product's
 *   audit log would have to grow fields that exist for the bench, which is the
 *   same fault pointing the other way.
 *
 *   v2.5 note on one item that used to be in that sentence. The log now does
 *   carry plan step boundaries, and the reason has nothing to do with this
 *   file: a plan's steps each produce text the reader is shown, and a
 *   transcript of what was said that omits it was incomplete against its own
 *   contract. The bench did not ask for the field and would not have been
 *   entitled to; it notices, in the session-audit entry below, and the notice
 *   is careful about how little agreement between the screen and the
 *   application's own record is worth.
 *
 * So the record is built here instead, out of things the harness already knows
 * from OUTSIDE the application, and it is written down as a list rather than
 * left implicit. Three parts:
 *
 *   `configuration`  the switches that were live when the turn ran, read back
 *                    through the app's own settings API — the same call the
 *                    harness already makes to verify the seed. This settles a
 *                    claim about a CAPABILITY: a line saying a check ran is
 *                    contradicted by that check's switch being off. It settles
 *                    nothing about whether an enabled capability was exercised,
 *                    and says so.
 *   `library`        the corpus the turn was given, read through the app's own
 *                    already-public library list. This settles what the screen
 *                    says it retrieved from, and — on a run with no packs — it
 *                    settles a claim to have retrieved at all.
 *   `beyondAnyRecord` the claims no artifact in the directory can settle, named
 *                    rather than left for each critic to rediscover. A duration
 *                    the application timed with its own clock is the type case.
 *                    A record of that number is the application writing the same
 *                    number down twice; it agrees by construction and settles
 *                    nothing. That is a third state, not a tie.
 *
 * NOTHING HERE CHANGES WHAT THE APPLICATION DOES. Every value is read through
 * an API the product already exposes and the harness already calls, the library
 * read is taken after the turn has ended so it cannot warm a cache the turn
 * would have paid for, and no product file is touched. The change is to what
 * gets written down, not to what happens.
 *
 * Blinding: every value recorded here is a switch, a small enum, a count or a
 * name shared by both arms. No URL, no filesystem path, no model id, no
 * version — those are what `_settings-in-app.json` carries, which is why that
 * file stays a sidecar and this does not.
 */

/** A settings value this record is willing to carry. */
export type RecordedValue = boolean | number | string | null

export interface RunRecordInput {
  /** The live settings object, as read back through the app's own settings API. */
  settings: unknown
  /** What the app's own library list returned, or null if it could not be read. */
  library: LibraryPackReading[] | null
  libraryError: string | null
  /** The audit export block, exactly as it appears elsewhere in run.json. */
  auditExport: { file: string | null; entries: number | null; error: string | null } | null
  /** One entry per loopback fixture the task stood up. */
  fixtures: { kind: string; file: string; requestCount: number }[]
  /** Wall-clock milliseconds from the driver's own clock, outside the page. */
  wallClockMs: number | null
}

export interface LibraryPackReading {
  id: string
  name: string
  version: string
  docs: number
  chunks: number
  embeddedChunks: number
}

export interface RecordEntry {
  id: string
  file: string | null
  settles: string[]
}

export interface AbsentEntry {
  id: string
  why: string
  wouldHaveSettled: string[]
}

export interface RunRecord {
  note: string
  configuration: {
    note: string
    tools: Record<string, RecordedValue>
    checking: Record<string, RecordedValue>
    other: Record<string, RecordedValue>
    notCovered: Record<string, string>
  }
  library: {
    note: string
    packs: LibraryPackReading[] | null
    error: string | null
    empty: boolean | null
  }
  driverClock: { wallClockMs: number | null; note: string }
  kept: RecordEntry[]
  notKept: AbsentEntry[]
  beyondAnyRecord: { claim: string; why: string }[]
}

/**
 * The tool switches, taken from the product's own tool table rather than typed
 * out here.
 *
 * This project's recurring defect is an enumeration narrower than the class it
 * guards, committed inside the guard against it. A hand-written tool list would
 * be exactly that: a tool added to the product would silently stop being part
 * of the record, and the column would quietly lose the ability to settle claims
 * about it. `test/h2hRunRecord.test.ts` pins this against the shipped table, so
 * a new tool fails the suite until someone decides about it.
 */
export function toolSwitches(settings: unknown, names: readonly string[]): Record<string, RecordedValue> {
  const tools = (settings as { tools?: Record<string, unknown> } | null)?.tools
  const out: Record<string, RecordedValue> = {}
  for (const name of [...names].sort()) {
    const v = tools && typeof tools === 'object' ? tools[name] : undefined
    // `null` is "this build has no such switch", which is a different fact from
    // "off" and has to survive as one. Both arms therefore report the same set
    // of keys whatever they were built from, so the shape of this object can
    // never be the thing that names an arm.
    out[name] = typeof v === 'boolean' ? v : null
  }
  return out
}

/**
 * The switches behind the lines the screen prints about its own checking, and
 * the handful of display and budget settings a claim can contradict.
 *
 * These are stated as paths rather than derived, because unlike the tool table
 * there is no single product list of them to derive from. `notCovered` below is
 * the compensation: the record names every top-level settings group it did NOT
 * look at, so a reader sees the boundary of this list instead of having to
 * assume there is none.
 */
export const CHECKING_PATHS: readonly string[] = [
  'claimCheck.enabled',
  'claimCheck.maxClaims',
  'grounding.autoCorrect',
  'grounding.ledger',
  'grounding.playbooks',
  'grounding.selfReview',
  'grounding.workbenchChecks',
  'secondOpinion.enabled'
]

export const OTHER_PATHS: readonly string[] = [
  'audit.enabled',
  'contextManagement',
  'hideToolCalls',
  'historyLimit',
  'memory.autoContext',
  'memory.topK',
  'plan.confirmPlan',
  'plan.maxSteps',
  'reasoningDisplay',
  'research.confirmPlan',
  'research.depth',
  'search.confirmBeforeSearch',
  'search.maxResults',
  'search.provider',
  'search.useHeadlessRenderer',
  'showResponseStats'
]

/**
 * Settings groups this record deliberately leaves out, and why. Named so the
 * omission is a decision on the page rather than an absence a reader has to
 * notice. Everything here either identifies a build or a machine (which would
 * de-blind the pair) or is prose the record has no claim to check against.
 */
export const DELIBERATELY_NOT_RECORDED: Record<string, string> = {
  baseUrl: 'a loopback URL carrying an OS-assigned port, which differs between the two runs of a pair',
  models: 'model ids, role names and system prompts — the largest de-blinder in the settings object',
  workingDirectory: 'a filesystem path',
  pipeline: 'names the model slots, which are model identity by another route',
  projects: 'user data, and empty in every staged run',
  theme: 'already recorded, off the document rather than off the config, where a mid-run switch shows',
  fontSize: 'a display size no claim on screen is about',
  stt: 'paths to local speech binaries',
  voice: 'a voice id belongs to the machine, not the run',
  proxy: 'host and port',
  shopping: 'no task in the set exercises it',
  updates: 'no task in the set exercises it',
  onboardingCompleted: 'a first-launch flag, true in every staged run',
  sidebarCollapsed: 'a panel state already visible in the screenshots',
  rightPanelCollapsed: 'a panel state already visible in the screenshots'
}

function atPath(root: unknown, path: string): unknown {
  let node: unknown = root
  for (const part of path.split('.')) {
    if (!node || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return node
}

/** A settings leaf, narrowed to what this record is willing to carry. */
function recordable(v: unknown): RecordedValue {
  if (typeof v === 'boolean' || typeof v === 'number') return v
  // Short strings only: an enum like a search provider or a depth is fine, a
  // URL or a path is not, and the length cap is the crude but effective line.
  if (typeof v === 'string' && v.length <= 24 && !v.includes('/') && !v.includes('\\')) return v
  return null
}

function pick(settings: unknown, paths: readonly string[]): Record<string, RecordedValue> {
  const out: Record<string, RecordedValue> = {}
  for (const p of paths) out[p] = recordable(atPath(settings, p))
  return out
}

/**
 * The claims no artifact in a run directory can settle, and the reason each is
 * beyond one. This list is part of the record precisely because it is the part
 * a reader would otherwise supply from memory, differently each time.
 *
 * The shared reason is worth stating plainly: the application is the only
 * witness. A figure it produced with its own clock, a segment it named itself,
 * a step boundary it drew itself — writing any of those into a record makes the
 * record agree with the screen by construction. That is not evidence. It is the
 * same number twice, and a column that treats the second copy as corroboration
 * has stopped measuring anything.
 */
export const BEYOND_ANY_RECORD: { claim: string; why: string }[] = [
  {
    claim: 'how long the application took to start its Python sandbox, and how long the code then ran',
    why:
      'both figures are produced by the application timing itself. The sandbox starts inside the ' +
      'renderer and crosses no boundary the harness can watch, so there is no second clock to ' +
      'check them against and a record of them would be the same measurement written twice.'
  },
  {
    claim: 'the named segments of a turn, and how long each one took',
    why:
      'the segment boundaries are the application\'s own — it decides where gathering ends and ' +
      'answering begins. An independent clock can time the whole turn and does, in the timings ' +
      'block; it cannot time a division it does not know about.'
  },
  {
    claim: 'which playbook the application selected for this turn',
    why:
      'the selection happens before the request is built and leaves the process only inside a ' +
      'system prompt. On a task whose setup routes the model through a loopback shim the request ' +
      'body is captured and the claim becomes settleable; on a task without one it is not, and ' +
      'standing a shim up on every task would change the staging that eight rounds of recorded ' +
      'runs are comparable through.'
  },
  {
    claim: 'how much of a checking budget each pass consumed',
    why:
      'the budget is the application\'s own timer. What CAN be settled is whether a pass it says ' +
      'it ran was even switched on, and the configuration block above is what settles it.'
  },
  {
    claim:
      'that a plan step did the work its row claims, and that the header\'s count of finished ' +
      'steps is TRUE rather than merely consistent',
    why:
      'a plan step is a construct of the application; nothing outside it observes a step starting ' +
      'or ending. As of v2.5 a kept session audit carries a line per step boundary, so the ' +
      'header CAN now be contradicted by the record, and the session-audit entry above claims ' +
      'exactly that much. Agreement is a different fact and is not claimed: the application ' +
      'writes the screen and the record both, so a build that misreported a step would misreport ' +
      'it identically in each. On a run that kept no audit there is no second reading at all.'
  }
]

export function buildRunRecord(input: RunRecordInput, toolNames: readonly string[]): RunRecord {
  const { settings, library, libraryError, auditExport, fixtures, wallClockMs } = input

  const topLevel = settings && typeof settings === 'object' ? Object.keys(settings as object).sort() : []
  const covered = new Set(
    [...CHECKING_PATHS, ...OTHER_PATHS].map((p) => p.split('.')[0]).concat(['tools'])
  )
  /**
   * Every settings group this record left out, with the reason it was left out.
   *
   * A group nobody has decided about gets the loud reason rather than silence.
   * The three lists above are enumerations, and an enumeration narrower than
   * the class it guards is the defect this project keeps finding in its own
   * checks; this is where a new one announces itself, in the artifact, on the
   * first run after it ships.
   */
  const notCovered: Record<string, string> = {}
  for (const k of topLevel) {
    if (covered.has(k)) continue
    notCovered[k] =
      DELIBERATELY_NOT_RECORDED[k] ??
      'UNDECIDED — this settings group appeared after the record was written and nobody has ' +
        'decided whether a claim on screen can be checked against it. Treat statements that bear ' +
        'on it as unsettled.'
  }

  const kept: RecordEntry[] = [
    {
      id: 'configuration',
      file: null,
      settles: [
        'a line naming a check that ran, against whether that check was switched on at all',
        'a line naming a tool it consulted, against whether the tool was available to the turn',
        'a claim to have been answered without sources, against whether any source tool was on'
      ]
    },
    {
      id: 'library',
      file: null,
      settles: [
        'a citation to a passage, against the packs actually installed for this run',
        'a claim to have retrieved from the library on a run whose library is empty'
      ]
    },
    {
      id: 'driver-clock',
      file: null,
      settles: [
        'a stated duration that exceeds the whole run, which no part of the run can have taken'
      ]
    }
  ]
  const notKept: AbsentEntry[] = []

  if (auditExport && auditExport.file) {
    kept.push({
      id: 'session-audit',
      file: auditExport.file,
      settles: [
        'every tool the screen says it called, against the calls the application recorded making',
        'whether a call the screen shows as successful was recorded as one',
        'work the record shows that the screen never mentions',
        // v2.5. The same shape as `configuration` above, and stated in the same
        // words: a CONTRADICTION is a finding, an agreement is not evidence.
        // The log now holds one line per plan step boundary, so a header
        // reading "3/3 steps done" over a record holding two finished steps is
        // catchable; a header that matches the record is merely consistent,
        // because the application wrote both. beyondAnyRecord keeps that half.
        'the plan header\'s step count, against the step lines the application recorded — a ' +
          'header that disagrees with them is a contradiction, and one that agrees is consistent ' +
          'rather than corroborated',
        'a plan step the screen shows as finished that the record never shows starting'
      ]
    })
  } else {
    notKept.push({
      id: 'session-audit',
      why: auditExport
        ? `the application was asked for its session audit and the export did not produce one: ${auditExport.error ?? 'unknown'}`
        : 'the session audit is opt-in and off by default, and this task did not ask for it. The ' +
          'application was never asked to keep a record, so its absence is a property of the ' +
          'staging and not a failure of the build',
      wouldHaveSettled: [
        'every tool the screen says it called, and whether each succeeded',
        'work the record shows that the screen never mentions',
        'a plan header\'s step count, against the step lines the application would have recorded'
      ]
    })
  }

  for (const f of fixtures) {
    kept.push({
      id: `fixture:${f.kind}`,
      file: f.file,
      settles: [
        'every request the application made to this service, and what came back',
        'a claim to have consulted this service on a turn where it made no request'
      ]
    })
  }
  if (!fixtures.some((f) => f.kind === 'lm-shim')) {
    notKept.push({
      id: 'fixture:lm-shim',
      why:
        'this task does not route the model through a loopback shim, so nothing observed the ' +
        'requests the application built. Standing one up on every task would change staging that ' +
        'eight rounds of recorded runs are comparable through',
      wouldHaveSettled: [
        'which playbook or method the application says it applied',
        'what the application actually sent, as against what it says it sent'
      ]
    })
  }

  return {
    note:
      'The record this run kept, listed. The cross-cutting question about the screen agreeing with ' +
      'the record needs to know what the record IS; before this block existed the answer was ' +
      'whatever the reader happened to open. A statement no entry below covers is UNSETTLED, and ' +
      'unsettled is not agreed. Where a statement is unsettled because a record was not kept, ' +
      'notKept says which and why; where no record could ever settle it, beyondAnyRecord says so. ' +
      'Those are two different facts and a round that merges them reports on its own capture and ' +
      'calls it a finding about the build.',
    configuration: {
      note:
        'The switches live in the application when the turn ran, read back through its own settings ' +
        'API. This settles CAPABILITY and not exercise: a line saying a pass ran while that pass was ' +
        'switched off is a contradiction, and a line saying a pass ran while it was switched on is ' +
        'merely possible. A switch reported as null is one this build does not have. Settings that ' +
        'name a build or a machine are deliberately absent — notCovered lists the groups left out, ' +
        'so the boundary of this block is on the page rather than assumed away.',
      tools: toolSwitches(settings, toolNames),
      checking: pick(settings, CHECKING_PATHS),
      other: pick(settings, OTHER_PATHS),
      notCovered
    },
    library: {
      note:
        'The reference corpus the turn was given, read through the application\'s own library list ' +
        'AFTER the turn ended, so the read cannot have warmed anything the turn would otherwise have ' +
        'paid for. An empty library settles a claim to have retrieved from one.',
      packs: library,
      error: libraryError,
      empty: library ? library.length === 0 : null
    },
    driverClock: {
      wallClockMs,
      note:
        'Measured outside the page, by the process driving it, from before the application launched ' +
        'to after the last artifact was read. It is the only clock in this directory the application ' +
        'did not produce, and it BOUNDS rather than measures: a duration the screen states that ' +
        'exceeds this figure cannot have happened, and one that fits inside it is not thereby ' +
        'confirmed.'
    },
    kept,
    notKept,
    beyondAnyRecord: BEYOND_ANY_RECORD
  }
}
