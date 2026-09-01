import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'crypto'
import { promises as fs, readFileSync } from 'fs'
import { join } from 'path'
import { load, resetState, state, testUserDataDir } from './harness'
import { AUDIT_ENTRY_KINDS, type AuditEntry } from '../src/shared/audit'
import { BEYOND_ANY_RECORD, buildRunRecord } from '../scripts/h2h-record'
import {
  countFromLedger,
  endPlan,
  planEndLine,
  planHeaderCount,
  planLedger,
  planLedgersFromAudit,
  planStartLine,
  planStepEndLine,
  planStepStartLine,
  PLAN_OUTCOMES,
  PLAN_STEP_STATUSES
} from '../src/renderer/src/lib/planState'
import type { ChatPlan, PlanStep, PlanStepStatus } from '../src/renderer/src/types'

/**
 * v2.5 — the plan header's number, and the record that now holds the facts
 * underneath it.
 *
 * A blind critic, on plan mode in BOTH arms of round 12: *"The plan header's
 * progress fraction is the only thing visible without interacting, and it is
 * the one number no artifact in the run can check — the audit records tools,
 * never steps. A reader who trusts `3/3 steps done` is trusting the block about
 * itself."* Both critics counted every plan step statement **unsettleable**
 * rather than agreed.
 *
 * Six lines was the whole of a three-step plan's record: `session_start`,
 * `user_input`, one `tool_call` per call, `assistant_output`. Nothing marked
 * where a step began or ended, and a plan whose steps called no tools left a
 * log in which nothing whatsoever happened between the question and the answer
 * — under a header reading `3/3 steps done`.
 *
 * What this file pins, in the order the argument runs:
 *
 *   1. The log carries a plan now, across the real encryption and the real
 *      hash chain, and the header's sentence comes back out of it through the
 *      same counting function the block uses.
 *   2. The reconstruction covers the class — every outcome over every step
 *      status — not the three fixtures someone thought of.
 *   3. The record is not a copy of the header. No line restates the sentence,
 *      so a reader has to count, and the counting is the check.
 *   4. Every log the app has already written still verifies, byte for byte. A
 *      tamper-evident record that quietly stopped verifying on upgrade would be
 *      a worse failure than the one this round is fixing.
 *   5. One writer: a step status cannot reach the screen without reaching the
 *      record.
 *   6. What it still does NOT settle, stated here rather than left to be
 *      rediscovered — the application writes the screen and the record both.
 */

const audit = load<typeof import('../src/main/ipc/audit')>('audit')
const { recordAuditEntry, readSessionPlaintext, currentAuditSessionId } = audit

const REPO = join(__dirname, '..', '..')

function step(n: number, status: PlanStepStatus, output?: string): PlanStep {
  return {
    id: `s${n}`,
    title: `Step ${n}`,
    detail: `detail ${n}`,
    tools: n === 1 ? ['web_search'] : [],
    status,
    ...(output ? { output } : {})
  }
}

function plan(steps: PlanStep[], rest: Partial<ChatPlan> = {}): ChatPlan {
  return { steps, approved: true, createdAt: 1, ...rest }
}

/** The plan as it stood before anything ran — what the reader was shown. */
function asShown(finished: ChatPlan): ChatPlan {
  return plan(
    finished.steps.map((s) => ({ ...s, status: 'pending' as PlanStepStatus })),
    { approved: finished.approved }
  )
}

/**
 * The lines a plan writes, in the order `hooks/planMode.ts` writes them: the
 * checklist as it was shown, a start for every step that ran, an end for every
 * step that reached a terminal status, and the outcome.
 *
 * `pending` and `skipped` steps write nothing, because nothing happened. Their
 * absence from the record is the fact, and the reconstruction puts them back
 * through `endPlan` — the block's own rule, not a second spelling of it.
 */
function linesFor(finished: ChatPlan): AuditEntry[] {
  const shown = asShown(finished)
  const out: AuditEntry[] = []
  const push = (line: object): void => {
    out.push({ at: '', conversationId: 'c1', prevHash: '', ...line } as AuditEntry)
  }
  push(planStartLine(shown))
  for (let i = 0; i < finished.steps.length; i++) {
    const s = finished.steps[i]!
    if (s.status === 'pending' || s.status === 'skipped') continue
    push(planStepStartLine(shown, i + 1))
    if (s.status === 'running') continue
    push(planStepEndLine(shown, i + 1, s.status, s.output))
  }
  if (finished.outcome) push(planEndLine(shown, finished.outcome))
  return out
}

/** The same lines, through the real encrypted, hash-chained log. */
async function replay(finished: ChatPlan): Promise<void> {
  for (const line of linesFor(finished)) {
    const { at: _at, prevHash: _p, ...input } = line
    await recordAuditEntry(input)
  }
}

async function entriesOnDisk(): Promise<AuditEntry[]> {
  const result = await readSessionPlaintext(currentAuditSessionId())
  assert.ok(!('error' in result), 'the log could not be read back')
  if ('error' in result) throw new Error('unreachable')
  assert.equal(result.chainValid, true, 'the chain broke')
  return result.entries
}

/** The plan a reconstruction is about is the last one the record holds. */
function lastLedger(entries: readonly AuditEntry[]): ReturnType<typeof planLedger> {
  const ledgers = planLedgersFromAudit(entries)
  assert.ok(ledgers.length > 0, 'the record holds no plan at all')
  return ledgers[ledgers.length - 1]!
}

const COMPLETED = endPlan(
  plan([step(1, 'done', 'result 1'), step(2, 'done', 'result 2'), step(3, 'done', 'result 3')]),
  'completed'
)
const CANCELLED = endPlan(
  plan([step(1, 'pending'), step(2, 'pending'), step(3, 'pending')], { approved: false }),
  'cancelled'
)
const STOPPED = endPlan(
  plan([step(1, 'done', 'result 1'), step(2, 'stopped'), step(3, 'pending'), step(4, 'pending')]),
  'stopped'
)
const FAILED = endPlan(
  plan([
    step(1, 'done', 'result 1'),
    step(2, 'failed', 'Step 2 could not run.'),
    step(3, 'pending')
  ]),
  'failed'
)

/**
 * One log for the whole file, appended to and never deleted — which is what an
 * append-only chained log is. A test that removed the file mid-run and kept
 * writing would produce a broken chain and prove nothing about this change.
 */
before(async () => {
  resetState()
  state.settings.audit = { enabled: true, autoPurgeOnQuit: false }
  await fs.rm(join(testUserDataDir(), 'audit'), { recursive: true, force: true })
})

/* ---- 1. the record holds the plan, and the header comes back out of it ---- */

describe('a plan turn leaves a record of itself', () => {
  test('a three-step plan that ran writes a line per boundary', async () => {
    await replay(COMPLETED)
    const kinds = (await entriesOnDisk()).map((e) => e.kind)
    assert.deepEqual(kinds, [
      'session_start',
      'plan_start',
      'plan_step_start',
      'plan_step_end',
      'plan_step_start',
      'plan_step_end',
      'plan_step_start',
      'plan_step_end',
      'plan_end'
    ])
  })

  test('every step line carries its ordinal, the total, and the status the row shows', async () => {
    const ends = (await entriesOnDisk()).filter((e) => e.kind === 'plan_step_end')
    assert.deepEqual(
      ends.map((e) => [e.planStepIndex, e.planStepCount, e.planStepStatus]),
      [
        [1, 3, 'done'],
        [2, 3, 'done'],
        [3, 3, 'done']
      ]
    )
  })

  test("the step's own result is in the record, not only behind a disclosure", async () => {
    const ends = (await entriesOnDisk()).filter((e) => e.kind === 'plan_step_end')
    assert.match(ends[1]!.text, /result 2/)
  })

  test('the plan as approved is in the record, with the tools each step forecast', async () => {
    const start = (await entriesOnDisk()).find((e) => e.kind === 'plan_start')!
    assert.equal(start.planStepCount, 3)
    // `toolPreview`'s own sentence, called rather than re-worded: the plan the
    // reader approved and the plan in the record are one document.
    assert.match(start.text, /Tools — may use: web_search/)
    assert.match(start.text, /Tools — none planned; this step reasons only/)
  })

  test('nothing is lost between the line that is built and the line that is read back', async () => {
    const onDisk = (await entriesOnDisk()).filter((e) => e.kind.startsWith('plan_'))
    const built = linesFor(COMPLETED)
    assert.deepEqual(
      onDisk.map((e) => [e.kind, e.planStepIndex, e.planStepCount, e.planStepStatus, e.text]),
      built.map((e) => [e.kind, e.planStepIndex, e.planStepCount, e.planStepStatus, e.text])
    )
  })

  test("the header's sentence is recomputed from the lines and comes out the same", async () => {
    const ledger = lastLedger(await entriesOnDisk())
    assert.equal(countFromLedger(ledger), planHeaderCount(COMPLETED))
    assert.equal(countFromLedger(ledger), '3/3 steps done')
  })

  test('a plan cancelled at the gate is recorded, with no step lines at all', async () => {
    await replay(CANCELLED)
    const entries = await entriesOnDisk()
    const tail = entries.slice(entries.findIndex((e) => e.planOutcome === 'completed') + 1)
    assert.equal(tail.filter((e) => e.kind.startsWith('plan_step')).length, 0)
    // Nothing ran, so nothing was written — the absence IS the evidence, and
    // `endPlan` is what turns it back into three never-ran rows.
    assert.equal(countFromLedger(lastLedger(entries)), planHeaderCount(CANCELLED))
    assert.equal(countFromLedger(lastLedger(entries)), '3 steps: 3 never ran')
  })
})

/* ---- 2. the reconstruction covers the class ------------------------------- */

describe('a plan that did not finish reconstructs as what it was', () => {
  test('stopped part-way: the step that ran, the one interrupted, and the two that were not', () => {
    const ledger = lastLedger(linesFor(STOPPED))
    assert.equal(countFromLedger(ledger), planHeaderCount(STOPPED))
    assert.equal(countFromLedger(ledger), '4 steps: 1 done, 1 stopped by you, 2 never ran')
  })

  test('failed: which step failed is a status in the record, not an absence', () => {
    const lines = linesFor(FAILED)
    const failed = lines.find((e) => e.planStepStatus === 'failed')
    assert.ok(failed, 'the record does not say which step failed')
    assert.equal(failed!.planStepIndex, 2)
    assert.equal(countFromLedger(lastLedger(lines)), planHeaderCount(FAILED))
  })

  test('a run cut off mid-step comes back as a step that started and never ended', () => {
    // The log is append-only and the app can be killed. A reconstruction that
    // rounded this off to "finished", or dropped the plan for want of an end
    // line, would hide the one thing a reader most needs from a session that
    // stopped in the middle.
    const live = plan([step(1, 'done', 'result 1'), step(2, 'running'), step(3, 'pending')])
    const ledger = lastLedger(linesFor(live))
    assert.deepEqual(ledger.statuses, ['done', 'running', 'pending'])
    assert.equal(ledger.outcome, undefined)
    assert.equal(countFromLedger(ledger), planHeaderCount(live))
  })

  test('two plans in one session are two ledgers, not one merged one', () => {
    const ledgers = planLedgersFromAudit([...linesFor(COMPLETED), ...linesFor(STOPPED)])
    assert.equal(ledgers.length, 2)
    assert.equal(countFromLedger(ledgers[0]!), planHeaderCount(COMPLETED))
    assert.equal(countFromLedger(ledgers[1]!), planHeaderCount(STOPPED))
  })

  test('the ledger a plan produces and the ledger its record produces are the same', () => {
    assert.deepEqual(lastLedger(linesFor(FAILED)), planLedger(FAILED))
  })

  /**
   * The class, not the fixtures. Every outcome over every step status a step
   * can hold. A counting function walking one list of statuses and a writer
   * walking another would show up here, on the combination nobody wrote a
   * fixture for — which is how this project's enumeration defects always
   * surface.
   */
  test('every outcome, over every step status, reconstructs the same sentence', () => {
    for (const outcome of PLAN_OUTCOMES) {
      for (const status of PLAN_STEP_STATUSES) {
        const p = endPlan(
          plan([step(1, 'done', 'result 1'), step(2, status), step(3, 'pending')]),
          outcome
        )
        const rebuilt = countFromLedger(lastLedger(linesFor(p)))
        assert.equal(
          rebuilt,
          planHeaderCount(p),
          `a ${outcome} plan with a ${status} step rebuilds as "${rebuilt}" where the header ` +
            `reads "${planHeaderCount(p)}"`
        )
      }
    }
  })

  test('a record with no plan in it produces no ledger, rather than an empty one', () => {
    assert.deepEqual(planLedgersFromAudit([]), [])
    assert.deepEqual(
      planLedgersFromAudit([
        { at: '', kind: 'user_input', conversationId: 'c1', text: 'hi', prevHash: '' }
      ]),
      []
    )
  })
})

/* ---- 3. the record carries the facts, not the sentence -------------------- */

/**
 * The line this round could most easily have crossed.
 *
 * Writing `3/3 steps done` into the log would make the record "agree" with the
 * screen on every run, at no cost and with no information. `scripts/h2h-record
 * .ts` names that move exactly: *"a step boundary it drew itself — writing any
 * of those into a record makes the record agree with the screen by
 * construction. That is not evidence. It is the same number twice."* So the log
 * carries the facts and the arithmetic stays on screen, where a reader who
 * wants to check it has to redo it.
 */
describe('the record carries the facts, not the sentence', () => {
  test('no line in the log restates the header', () => {
    for (const e of linesFor(COMPLETED)) {
      assert.doesNotMatch(
        e.text,
        /\d+\/\d+ steps done/,
        `the record restates the header instead of leaving it to be checked: "${e.text}"`
      )
    }
  })

  test('and not the census either', () => {
    for (const e of linesFor(STOPPED)) {
      assert.doesNotMatch(e.text, /steps: \d+ /, `the record restates the census: "${e.text}"`)
    }
  })

  test('a record that disagrees with the screen is a contradiction a reader can see', () => {
    // The point of the exercise: the reconstruction is a real reading, not a
    // formality. Drop one step's end line — which is what a build that marked a
    // step done without running it would leave behind — and the two sentences
    // part company. A test suite where this passed trivially would be pinning
    // nothing.
    const doctored = linesFor(STOPPED).filter(
      (e) => !(e.kind === 'plan_step_end' && e.planStepIndex === 1)
    )
    assert.notEqual(countFromLedger(lastLedger(doctored)), planHeaderCount(STOPPED))
  })
})

/* ---- 4. every log already on disk still verifies -------------------------- */

/**
 * The hash chain covers `JSON.stringify(entry)`. A field added unconditionally
 * — even as `null` — changes those bytes for every entry ever written, and
 * every existing log stops verifying on the first launch after the upgrade. The
 * plan fields are therefore spread in conditionally, exactly as `roleName`,
 * `modelId`, `toolName` and `ok` already were.
 *
 * Asserted against a file built by hand in the pre-v2.5 shape, not against one
 * this build wrote: the second only proves the build agrees with itself, which
 * is the whole species of mistake this round is about.
 */
describe('logs written before this change still verify', () => {
  const GENESIS = createHash('sha256').update('sigma-oasis-audit-genesis').digest('hex')
  const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
  // The harness's deterministic stand-in for the OS keychain (see harness.ts).
  const enc = (s: string): string =>
    Buffer.from(`enc:${Buffer.from(s, 'utf-8').toString('base64')}`).toString('base64')

  test('a pre-v2.5 file, written with the old four kinds and no plan fields, verifies', async () => {
    const old: Record<string, unknown>[] = [
      {
        at: '2026-08-01T00:00:00.000Z',
        kind: 'session_start',
        conversationId: '',
        text: 'Audit session session-old started (Sigma Oasis 2.4.0).',
        prevHash: GENESIS
      },
      { at: '2026-08-01T00:00:01.000Z', kind: 'user_input', conversationId: 'c1', text: 'hello' },
      {
        at: '2026-08-01T00:00:02.000Z',
        kind: 'tool_call',
        conversationId: 'c1',
        toolName: 'web_search',
        ok: true,
        text: 'web_search({"q":"x"})'
      },
      {
        at: '2026-08-01T00:00:03.000Z',
        kind: 'assistant_output',
        conversationId: 'c1',
        roleName: 'Assistant',
        modelId: 'a-model',
        text: 'an answer'
      }
    ]
    let prev = GENESIS
    const lines: string[] = []
    for (const e of old) {
      const entry = 'prevHash' in e ? e : { ...e, prevHash: prev }
      lines.push(enc(JSON.stringify(entry)))
      prev = sha256(JSON.stringify(entry))
    }
    const dir = join(testUserDataDir(), 'audit')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'session-old.jsonl'), `${lines.join('\n')}\n`, 'utf-8')

    const result = await readSessionPlaintext('session-old')
    assert.ok(!('error' in result))
    if ('error' in result) return
    assert.equal(result.chainValid, true, 'a log written before this change stopped verifying')
    assert.equal(result.entries.length, 4)
    // And it says, correctly, that it holds no plan — rather than inventing one.
    assert.deepEqual(planLedgersFromAudit(result.entries), [])
  })

  test('an entry with nothing to do with a plan still serializes to the old bytes', async () => {
    await recordAuditEntry({ conversationId: 'c1', kind: 'user_input', text: 'hello' })
    const entries = await entriesOnDisk()
    const written = entries[entries.length - 1]!
    // Key set AND order: `JSON.stringify` is order-sensitive and the chain
    // hashes its output, so a plan field slipped in as present-but-undefined
    // would break every chain in existence.
    assert.deepEqual(Object.keys(written), ['at', 'kind', 'conversationId', 'text', 'prevHash'])
  })

  test('and a plan line puts its fields where they do not disturb the old ones', async () => {
    const start = (await entriesOnDisk()).find((e) => e.kind === 'plan_step_end')!
    assert.deepEqual(Object.keys(start), [
      'at',
      'kind',
      'conversationId',
      'planStepIndex',
      'planStepCount',
      'planStepStatus',
      'text',
      'prevHash'
    ])
  })
})

/**
 * `recordAuditEntry` refuses a kind it does not know. Through v2.4 the list it
 * checked against was hand-written beside a hand-written type — two
 * enumerations of one class, where a kind added to one and not the other
 * typechecks clean and is dropped silently at runtime. It now reads
 * `AUDIT_ENTRY_KINDS`, so this covers the whole class rather than the four
 * kinds someone remembered.
 */
describe('the log accepts every kind it declares, and nothing else', () => {
  test('every declared kind reaches disk', async () => {
    for (const kind of AUDIT_ENTRY_KINDS) {
      await recordAuditEntry({ conversationId: 'c1', kind, text: `a ${kind} line` })
    }
    const written = new Set((await entriesOnDisk()).map((e) => e.kind))
    for (const kind of AUDIT_ENTRY_KINDS) {
      assert.ok(written.has(kind), `${kind} is declared but never reaches the log`)
    }
  })

  test('a kind the log does not declare is refused', async () => {
    const before = (await entriesOnDisk()).length
    await recordAuditEntry({
      conversationId: 'c1',
      kind: 'plan_step_middle' as never,
      text: 'should not appear'
    })
    assert.equal((await entriesOnDisk()).length, before)
  })
})

/* ---- 5 and 6: one writer, and what this still does not settle ------------- */

/**
 * The property that makes the reconstruction worth anything: a step's status
 * cannot reach the screen without reaching the record, because one function
 * writes both. A second pass that logged whatever the store ended up holding
 * would be the screen agreeing with a copy of itself — which is the failure
 * this round is about — so this is a property of the source, and is read off
 * the source, the same way the single writer of `cancelled` is.
 */
describe('a step status has one writer, and it writes to both places', () => {
  const planMode = readFileSync(
    join(REPO, 'src', 'renderer', 'src', 'hooks', 'planMode.ts'),
    'utf-8'
  )

  test('the executor rewrites a plan’s steps in exactly the two places that record it', () => {
    const writers = planMode.split('\n').filter((l) => /steps: plan\.steps\.map/.test(l)).length
    assert.equal(writers, 2, `${writers} places rewrite a plan's steps; expected beginStep/endStep`)
    assert.ok(!/patchStep\(/.test(planMode), 'the old status-only patcher is still reachable')
  })

  test('each writer records as well as patches', () => {
    for (const [fn, line] of [
      ['beginStep', 'planStepStartLine'],
      ['endStep', 'planStepEndLine'],
      ['finish', 'planEndLine']
    ] as const) {
      const from = planMode.indexOf(`const ${fn} = `)
      assert.ok(from > 0, `${fn} is gone`)
      const body = planMode.slice(from, planMode.indexOf('\n  }\n', from))
      assert.match(
        body,
        new RegExp(`audit\\(convo, ${line}\\(`),
        `${fn} changes the block without writing a line`
      )
    }
  })

  test('and the checklist itself is recorded when it is shown, not when it ends', () => {
    const shown = planMode.indexOf('audit(convo, planStartLine(')
    assert.ok(shown > 0, 'the plan is never recorded')
    assert.ok(
      shown < planMode.indexOf('Approval gate'),
      'the plan is recorded after the approval gate, so a plan the reader cancelled would leave ' +
        'no record of what was cancelled'
    )
  })

  /**
   * Stated in the suite because it is the half a reader of the tests above
   * would otherwise supply from memory, and supply wrongly. Closing
   * *unrecorded* is not closing *uncorroborated*: the application writes the
   * screen and the record both, so a build that misreported a step would
   * misreport it identically in each. The bench's list keeps saying so.
   */
  test('the bench still reports agreement as consistency, never as corroboration', () => {
    const beyond = BEYOND_ANY_RECORD.map((e) => `${e.claim} ${e.why}`).join(' ')
    assert.match(beyond, /plan step is a construct of the application/)
    assert.match(beyond, /Agreement is a different fact and is not claimed/)

    // And the kept entry claims contradiction only — the same distinction the
    // configuration block has always drawn between capability and exercise.
    const record = buildRunRecord(
      {
        settings: { tools: {} },
        library: [],
        libraryError: null,
        auditExport: { file: 'trace/audit.jsonl', entries: 9, error: null },
        fixtures: [],
        wallClockMs: 1
      },
      []
    )
    const settles = record.kept.find((k) => k.id === 'session-audit')!.settles.join(' ')
    assert.match(settles, /disagrees with them is a contradiction/)
    assert.match(settles, /consistent rather than corroborated/)
    // The plain claim — "the record settles the step count" — is the one thing
    // this entry must never say.
    assert.doesNotMatch(settles, /confirms|corroborates|proves/)
  })
})
