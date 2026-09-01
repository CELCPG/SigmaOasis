import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join } from 'path'
import { formatTurnCost, gatherMs, tailMs } from '../src/renderer/src/lib/turnCost'
import { VERIFY_BUDGET_MS, createVerifyBudget } from '../src/renderer/src/lib/turnPhase'
import { describeRecompute } from '../src/renderer/src/lib/workbenchChecks'
import type { ResponseStats } from '../src/renderer/src/types'

/**
 * The post-answer tail: what it cost the reader, and how long it may cost them.
 *
 * Round 3 named the tail and opened the action row through it; round 4 cut two
 * specific causes. Two things were left. The stat line still called the token
 * stream "total" — blind critics reading recorded runs measured 213.0 s of wait
 * under a footer of "76.6s total", 80.0 under "25.7s", 162.8 under "51.9s" — and
 * nothing bounded the tail at all: one recorded run was still checking when a
 * 300-second capture budget expired.
 *
 * Figures below are the recorded ones (.h2h-runs/judge-r4), so a regression
 * reads as the run it would reproduce.
 */

const MESSAGE_BUBBLE = join(__dirname, '..', '..', 'src', 'renderer', 'src', 'components', 'MessageBubble.tsx')
const USE_LM_STUDIO = join(__dirname, '..', '..', 'src', 'renderer', 'src', 'hooks', 'useLMStudio.ts')

const stats = (over: Partial<ResponseStats> = {}): ResponseStats => ({
  ttftMs: 850,
  totalMs: 25_700,
  completionTokens: 320,
  tokensPerSecond: 12.4,
  ...over
})

describe('the stat line reports the turn, not just the stream', () => {
  test('V1: the 54 seconds of checking the footer hid are on the line', () => {
    // Recorded: sendToTurnEndMs 80032 against an on-screen "25.7s total".
    const line = formatTurnCost(stats({ totalMs: 25_700, turnMs: 80_032 }))
    assert.ok(line.includes('80.0s total'), `the reader waited 80.0s; line was: ${line}`)
    assert.ok(line.includes('25.7s answer'), `the stream is 25.7s and must say so; line was: ${line}`)
    assert.ok(line.includes('54.3s checking'), `the tail must be named; line was: ${line}`)
    assert.ok(!line.includes('25.7s total'), 'the stream must never be presented as the total')
  })

  test('V3: 136 seconds of hidden checking, the worst measured', () => {
    // Recorded: sendToTurnEndMs 213023 against an on-screen "76.6s total".
    const line = formatTurnCost(stats({ totalMs: 76_600, turnMs: 213_023 }))
    assert.ok(line.includes('213.0s total'), line)
    assert.ok(line.includes('136.4s checking'), line)
  })

  test('V2 and TH1 too — the whole recorded set', () => {
    for (const [totalMs, turnMs, total, checking] of [
      [51_900, 162_814, '162.8s total', '110.9s checking'],
      [19_600, 42_640, '42.6s total', '23.0s checking']
    ] as const) {
      const line = formatTurnCost(stats({ totalMs, turnMs }))
      assert.ok(line.includes(total), line)
      assert.ok(line.includes(checking), line)
    }
  })

  test('a turn with no tail keeps its one honest total', () => {
    // Nothing ran after the last token, so "total" was never a lie there.
    const none = formatTurnCost(stats({ totalMs: 12_300 }))
    assert.ok(none.endsWith('12.3s total'), none)
    assert.ok(!none.includes('checking'), 'no tail, no third figure')
    // A mechanical-only tail is a regex and a render, not a wait.
    const noise = formatTurnCost(stats({ totalMs: 12_300, turnMs: 12_340 }))
    assert.ok(noise.endsWith('12.3s total'), noise)
    assert.ok(!noise.includes('checking'), noise)
  })

  test('the tail is measured, never negative, never invented', () => {
    assert.equal(tailMs(stats({ totalMs: 25_700, turnMs: 80_032 })), 54_332)
    assert.equal(tailMs(stats({ totalMs: 25_700 })), 0, 'an unmeasured turn claims no tail')
    // turnMs is stamped from the same origin as totalMs, so this cannot happen —
    // and if a clock ever made it happen, the line must not show a negative wait.
    assert.equal(tailMs(stats({ totalMs: 25_700, turnMs: 20_000 })), 0)
  })

  test('token figures are still only shown when the server reported them', () => {
    const measured = formatTurnCost(stats({ totalMs: 25_700, turnMs: 80_032 }))
    assert.ok(measured.startsWith('320 tok · 12.4 tok/s · 0.85s to first token · '), measured)
    const untokened = formatTurnCost({ ttftMs: 850, totalMs: 25_700, turnMs: 80_032 })
    assert.ok(!untokened.includes('320 tok'), untokened)
    assert.ok(!untokened.includes('tok/s'), untokened)
    assert.ok(untokened.includes('80.0s total'), 'timing is honest with or without tokens')
  })

  test('the bubble renders the turn cost through this formatter', () => {
    const source = readFileSync(MESSAGE_BUBBLE, 'utf-8')
    assert.ok(source.includes('formatTurnCost'), 'the stat line must come from lib/turnCost.ts')
    assert.ok(
      !source.includes('}s total`'),
      'MessageBubble must not build its own "total" — that template is what called the stream the turn'
    )
  })

  test('the live line says the checking is bounded, while it is still running', () => {
    const source = readFileSync(MESSAGE_BUBBLE, 'utf-8')
    const start = source.indexOf('function TurnPhaseLine')
    assert.ok(start > 0, 'TurnPhaseLine not found')
    const line = source.slice(start, start + 2000)
    assert.ok(line.includes('VERIFY_BUDGET_MS'), 'the running tail must name its own deadline')
  })
})

describe('the post-answer tail has a deadline that fires with a name', () => {
  test('a tail that fits inside the budget is bounded and silent', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const budget = createVerifyBudget(VERIFY_BUDGET_MS)
    assert.equal(budget.remainingMs(), VERIFY_BUDGET_MS)
    for (const pass of ['claims', 'code', 'revising'] as const) {
      assert.equal(budget.admits(pass), true, `${pass} must run when there is time`)
      t.mock.timers.tick(10_000)
      budget.ran(pass)
    }
    assert.equal(budget.expired(), false)
    assert.equal(budget.signal.aborted, false)
    assert.equal(budget.notice(), null, 'nothing was lost, so the reader is told nothing')
    budget.stop()
  })

  test('V3 cannot happen: the tail ends long before a 300s capture budget', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    assert.ok(VERIFY_BUDGET_MS <= 90_000, 'a bound the reader cannot sit out is not a bound')
    const budget = createVerifyBudget()
    // The recorded V3 tail: still checking at 136 s, still going at 300 s.
    t.mock.timers.tick(136_423)
    assert.equal(budget.expired(), true, 'the deadline must have fired by then')
    assert.equal(budget.signal.aborted, true, 'a pass in flight must be cut short')
    assert.equal(budget.remainingMs(), 0)
    budget.stop()
  })

  test('a pass refused after expiry is named, not silently dropped', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const budget = createVerifyBudget()
    assert.equal(budget.admits('claims'), true)
    t.mock.timers.tick(30_000)
    budget.ran('claims')
    assert.equal(budget.admits('code'), true)
    t.mock.timers.tick(31_000)
    budget.ran('code')
    assert.equal(budget.admits('recompute'), false, 'the budget is spent')
    assert.equal(budget.admits('revising'), false)
    const notice = budget.notice()
    assert.ok(notice, 'an expiry that cost the reader a pass must say so')
    assert.equal(notice.kind, 'deadline')
    assert.equal(notice.ok, false)
    assert.match(notice.summary, /60s limit/)
    assert.match(notice.summary, /Ran: the claim check, the code check/)
    assert.match(notice.summary, /Not run: the recomputation, the revision/)
    assert.match(notice.summary, /answer above is unchanged/)
    budget.stop()
  })

  /**
   * Round 13 splits the two states this line used to spell the same way.
   *
   * `Not run` over a pass that never began is true. `Not run` over a pass the
   * deadline caught in flight is the defect round 12 repaired one pass over:
   * on `.h2h-runs/judge-r12/TTU1` it printed `Not run: the revision` directly
   * under `∅ 🔍 deep_research` — a row the revision itself had put there. The
   * revision ran; what it did not do was finish. So a pass that began and was
   * cut off is now named as cut short, and `Not run` keeps the one meaning it
   * can always stand behind: the deadline was already spent when this pass was
   * asked for.
   */
  test('a pass still running when the deadline fires is cut short, not never-started', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const budget = createVerifyBudget()
    assert.equal(budget.admits('revising'), true)
    t.mock.timers.tick(VERIFY_BUDGET_MS)
    // The revision never returned, so `ran` is never called for it.
    const notice = budget.notice()
    assert.ok(notice)
    assert.match(notice.summary, /Ran: nothing/)
    assert.match(notice.summary, /Cut short: the revision/)
    assert.doesNotMatch(
      notice.summary,
      /Not run/,
      'a pass that began and was stopped is not a pass that never began'
    )
    budget.stop()
  })

  test('the two states are told apart on one turn', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const budget = createVerifyBudget()
    budget.ran('code')
    assert.equal(budget.admits('revising'), true, 'the revision started inside the minute')
    t.mock.timers.tick(VERIFY_BUDGET_MS + 500)
    assert.equal(budget.admits('recompute'), false, 'the recomputation never began')
    const notice = budget.notice()
    assert.ok(notice)
    assert.match(
      notice.summary,
      /Ran: the code check\. Cut short: the revision\. Not run: the recomputation\./,
      notice.summary
    )
    budget.stop()
  })

  /**
   * FR3 (`.h2h-runs/B10/FR3-20260827-224622`) replayed against the two pieces
   * the turn joins: the budget, and the pass's own account of itself. The
   * recomputation's `run_python` takes no abort signal, so a program admitted at
   * 57 s prints its output after the 60 s deadline — measured, `62.2s checking`
   * — and the line the reader gets is `describeRecompute({ ran: true, ok: true })`
   * with the program and its stdout above it.
   */
  test('a pass that finished after the deadline is not named as one that never ran', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const budget = createVerifyBudget()
    assert.equal(budget.admits('code'), true)
    budget.ran('code')
    t.mock.timers.tick(57_000)
    assert.equal(budget.admits('recompute'), true, 'there was still time when it started')
    // The model wrote the program, the sandbox booted, the run printed — and
    // the deadline passed somewhere in the middle of that.
    t.mock.timers.tick(5_200)
    assert.equal(budget.expired(), true)
    const shown = describeRecompute({ ran: true, ok: true })
    assert.match(shown.summary, /Recomputed the stated figures/)
    if (shown.ran) budget.ran('recompute')
    // The revision is the pass this turn really lost, and the gate has to ask
    // the budget to find that out — see the `!signal.aborted` reordering.
    assert.equal(budget.admits('revising'), false)

    const notice = budget.notice()
    assert.ok(notice, 'the deadline still fired, and the pass it cost is still named')
    assert.doesNotMatch(
      notice.summary,
      /Not run:[^.]*the recomputation/,
      'measured: "Not run: the recomputation" directly under "🧮 Recomputed the stated figures in Python"'
    )
    // Which is the line the previous build got right on its own FR3 run
    // (`.h2h-runs/A10/FR3-20260827-233154`) — by luck of timing, not by rule.
    assert.match(notice.summary, /Ran: the code check, the recomputation\. Not run: the revision\./)
    budget.stop()
  })

  /**
   * And the reason the notice appears at all on that turn: the gates that
   * precede `admits` used to test `stopped()`, which is true the moment the
   * deadline fires. A pass the budget was about to refuse was skipped before
   * the budget could count it — so the expiry either named the wrong pass or,
   * once the recomputation stopped being misreported, named none and said
   * nothing.
   */
  test('a pass the deadline refuses is recorded, not skipped silently', () => {
    const source = readFileSync(USE_LM_STUDIO, 'utf-8')
    assert.ok(
      source.includes("!autoCorrect || signal.aborted || !budget.admits('revising')"),
      'the revision gate must reach `admits` when it is the deadline that stopped it'
    )
    assert.ok(
      !/!stopped\(\) &&\n\s*looksArithmetic/.test(source),
      'the recompute gate must not skip `admits` on an expired budget'
    )
  })

  /**
   * The true negative, and the reason the old guard existed at all: a pass the
   * deadline genuinely cut off must still be named. `runRecompute` swallows the
   * abort and returns, so its returning is not evidence — what it returns is.
   * It is named as cut short rather than as never run, which is the state it
   * was actually in: admitted, started, and stopped before it produced a line.
   */
  test('a pass the deadline actually cut off is still named', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const budget = createVerifyBudget()
    assert.equal(budget.admits('recompute'), true)
    t.mock.timers.tick(VERIFY_BUDGET_MS + 1)
    // The stream was aborted before a program came back, so nothing was run.
    const shown = describeRecompute({ ran: false, ok: false, note: 'cancelled' })
    assert.match(shown.summary, /Recompute skipped/)
    if (shown.ran) budget.ran('recompute')

    const notice = budget.notice()
    assert.ok(notice)
    assert.match(notice.summary, /Cut short: the recomputation/)
    assert.match(notice.summary, /Ran: nothing/)
    // One millisecond past the minute is not an overrun the reader can see —
    // it prints as `60.0s checking`, so the plain sentence is still the true one.
    assert.match(notice.summary, /^⏱ Checking stopped at its 60s limit\./)
    budget.stop()
  })

  test('the user pressing Stop is not a deadline, and leaves no notice', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const turn = new AbortController()
    const budget = createVerifyBudget(VERIFY_BUDGET_MS, turn.signal)
    assert.equal(budget.admits('claims'), true)
    turn.abort()
    assert.equal(budget.signal.aborted, true, 'Stop must still stop the checking')
    assert.equal(budget.admits('revising'), false, 'and nothing new may start')
    assert.equal(budget.expired(), false)
    assert.equal(budget.notice(), null, 'the reader who pressed Stop knows why it stopped')
    budget.stop()
  })

  test('a turn stopped before the tail begins never opens the budget', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const turn = new AbortController()
    turn.abort()
    const budget = createVerifyBudget(VERIFY_BUDGET_MS, turn.signal)
    assert.equal(budget.signal.aborted, true)
    assert.equal(budget.admits('claims'), false)
    budget.stop()
  })

  test('stop() disarms the clock, so a finished turn cannot expire behind it', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const budget = createVerifyBudget()
    budget.ran('claims')
    budget.stop()
    t.mock.timers.tick(VERIFY_BUDGET_MS * 2)
    assert.equal(budget.expired(), false)
    assert.equal(budget.signal.aborted, false)
    assert.equal(budget.notice(), null)
  })
})

/**
 * Round 13. TTU1, both arms, the single disagreeing pair each blind critic
 * found — one message carrying two app-written lines that cannot both be true:
 *
 *   ⏱ Checking stopped at its 60s limit. Ran: the code check. Not run: the revision.
 *   … 9.2s gathering · 54.3s answer · 114.1s checking · 177.7s total
 *
 * The recorded cause is in the same capture, four lines up: `∅ 🔍 deep_research
 * — … Searched 8×, read 3 page(s) across 1 domain(s) in 93s.` The revision pass
 * was admitted at ~1 s with the whole minute in front of it, asked the model for
 * a correction, and the model called `deep_research`. `window.api.executeTool`
 * is an IPC round trip with no cancellation path, so when the deadline fired
 * mid-campaign it aborted the model streams and refused everything that had not
 * started — and the campaign ran to its own end, 54 s later.
 *
 * The other arm is the same shape with a shorter campaign: `A12/TTU1`, 44 s of
 * `deep_research`, `81.3s checking`. So neither number was wrong. The sentence
 * was: nothing stopped at 60 s except the starting of new work.
 */
describe('a limit on what starts, said as a limit on what starts', () => {
  /** The two recorded overruns, and the two figures each must reconcile. */
  const RECORDED = [
    { run: 'judge-r12/TTU1/run-1 (B12)', tail: 114_100, printed: '114.1s' },
    { run: 'judge-r12/TTU1/run-2 (A12)', tail: 81_300, printed: '81.3s' }
  ] as const

  for (const { run, tail, printed } of RECORDED) {
    test(`${run}: the line says what stopped at the limit and what did not`, (t) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
      const budget = createVerifyBudget()
      budget.ran('code')
      assert.equal(budget.admits('revising'), true, 'the revision began inside the minute')
      // The revision's own deep_research, dispatched before the deadline and
      // uninterruptible after it.
      t.mock.timers.tick(tail)
      assert.equal(budget.expired(), true)
      const notice = budget.notice()
      assert.ok(notice)
      // The decision, stated as a decision.
      assert.match(
        notice.summary,
        /Checking stopped starting new work at its 60s limit/,
        notice.summary
      )
      // The wall clock, stated as the wall clock — and in the stat line's own
      // figure, so the reader comparing the two lines is comparing one number.
      assert.ok(
        notice.summary.includes(`carried it to ${printed}.`),
        `the notice must quote the same span the footer prints as "${printed} checking"; got: ${notice.summary}`
      )
      assert.match(notice.summary, /Ran: the code check\./, notice.summary)
      assert.match(notice.summary, /Cut short: the revision\./, notice.summary)
      assert.doesNotMatch(
        notice.summary,
        /Not run: the revision/,
        'the revision put a deep_research row on the screen; it ran and did not finish'
      )
      budget.stop()
    })
  }

  /**
   * The true negative, and it is a recorded one: a second critic on a different
   * task scored the very same pair of lines as AGREEING, because there the
   * checking figure really was 60.1 s.
   *
   *   ⏱ Checking stopped at its 60s limit. Ran: the code check. Not run: the
   *     revision, the recomputation.
   *   … 60.1s checking · 163.3s total          (.h2h-runs/judge-r12/V3/run-1)
   *
   * Nothing was in flight when the minute ran out there — both remaining passes
   * were refused at their gates — so the sentence that was wrong on TTU1 is the
   * right one here, word for word, and must not acquire an overrun clause it
   * has nothing to report.
   */
  test('V3: a tail that respects the limit keeps the plain sentence', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const budget = createVerifyBudget()
    budget.ran('code')
    t.mock.timers.tick(60_100)
    assert.equal(budget.admits('revising'), false)
    assert.equal(budget.admits('recompute'), false)
    const notice = budget.notice()
    assert.ok(notice)
    assert.equal(
      notice.summary,
      '⏱ Checking stopped at its 60s limit. Ran: the code check. ' +
        'Not run: the revision, the recomputation. The answer above is unchanged.',
      notice.summary
    )
    budget.stop()
  })

  /** The other recorded agreeing pair, also at 60.1 s (`.h2h-runs/B10/TH2`). */
  test('TH2: the second respected limit is word for word the sentence it had', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const budget = createVerifyBudget()
    budget.ran('claims')
    budget.ran('code')
    t.mock.timers.tick(60_100)
    assert.equal(budget.admits('revising'), false)
    const notice = budget.notice()
    assert.ok(notice)
    assert.equal(
      notice.summary,
      '⏱ Checking stopped at its 60s limit. Ran: the claim check, the code check. ' +
        'Not run: the revision. The answer above is unchanged.',
      notice.summary
    )
    budget.stop()
  })

  /**
   * The boundary between the two sentences, from the recorded spread. Every
   * honest tail in `.h2h-runs` lands at 60.0–60.3 s and reads as agreement; the
   * overruns are 62.2, 69.4, 81.3 and 114.1. A second is the gap.
   */
  test('the overrun clause appears exactly where the figures stop agreeing', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    for (const [ms, overrun] of [
      [60_000, false],
      [60_100, false],
      [60_300, false],
      [60_999, false],
      [61_000, true],
      [62_200, true],
      [69_400, true]
    ] as const) {
      const budget = createVerifyBudget()
      assert.equal(budget.admits('revising'), true)
      t.mock.timers.tick(ms)
      const notice = budget.notice()
      assert.ok(notice)
      assert.equal(
        notice.summary.startsWith('⏱ Checking stopped starting new work'),
        overrun,
        `${(ms / 1000).toFixed(1)}s: ${notice.summary}`
      )
      budget.stop()
    }
  })

  /**
   * The deadline counts the same span the stat line calls "checking".
   *
   * It used to count from the moment `runTurn` reached `createVerifyBudget`,
   * which is after the paced tail drain and the turn's end-of-stream
   * bookkeeping — a few hundred milliseconds the footer bills to checking and
   * the budget did not. That gap is the whole reason a tail that behaved
   * perfectly printed `60.1s checking` beside a `60s limit`.
   */
  test('the budget counts from the last token, not from where the code reaches it', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const lastToken = Date.now()
    // The paced drain (TAIL_DRAIN_MS) plus the ending patch, before the tail.
    t.mock.timers.tick(450)
    const budget = createVerifyBudget(VERIFY_BUDGET_MS, undefined, lastToken)
    assert.equal(budget.remainingMs(), VERIFY_BUDGET_MS - 450, 'the drain is part of the wait')
    assert.equal(budget.admits('revising'), true)
    // 59.55 s of checking after that: the minute is up, measured from the token.
    t.mock.timers.tick(VERIFY_BUDGET_MS - 450)
    assert.equal(budget.expired(), true, 'the deadline fires 60s after the answer ended')
    assert.equal(budget.elapsedMs(), VERIFY_BUDGET_MS)
    const notice = budget.notice()
    assert.ok(notice)
    assert.match(
      notice.summary,
      /^⏱ Checking stopped at its 60s limit\./,
      'measured from the same origin, an honest tail is not an overrun'
    )
    budget.stop()
  })

  /**
   * And the two figures are one measurement. `runVerificationTail` takes a
   * single stamp and hands it to both `notice()` and `turnMs`, so the notice
   * cannot quote 114.0 while the footer prints 114.1.
   */
  test('the notice and the stat line quote the same number, not two readings', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const turnOpenedAt = Date.now()
    const gather = 9_200
    const answer = 54_300
    const answerEndedAt = turnOpenedAt + gather + answer
    t.mock.timers.tick(gather + answer)
    const budget = createVerifyBudget(VERIFY_BUDGET_MS, undefined, answerEndedAt)
    assert.equal(budget.admits('revising'), true)
    t.mock.timers.tick(114_100)

    const tailEndedAt = Date.now()
    const notice = budget.notice(tailEndedAt)
    const line = formatTurnCost(
      stats({ gatherMs: gather, totalMs: answer, turnMs: tailEndedAt - turnOpenedAt })
    )
    assert.ok(notice)
    assert.ok(line.includes('114.1s checking'), line)
    assert.ok(notice.summary.includes('114.1s'), notice.summary)
    assert.ok(line.includes('177.6s total'), line)
    budget.stop()
  })

  /**
   * The other half of "the limit bounds what we start": it has to be true of
   * tool calls too, or the sentence over-claims again. The loop checked its
   * signal between rounds and never between the calls one round asked for, so
   * a round requesting three tools dispatched all three however long ago the
   * deadline had fired.
   */
  test('no further tool call is dispatched once the deadline has landed', () => {
    const loop = readFileSync(
      join(__dirname, '..', '..', 'src', 'renderer', 'src', 'lib', 'agentLoop.ts'),
      'utf-8'
    )
    const start = loop.indexOf('for (const tc of round.toolCalls)')
    assert.ok(start > 0, 'the per-call loop not found')
    const body = loop.slice(start, loop.indexOf('deps.executeTool', start))
    assert.ok(
      /if \(signal\.aborted\)/.test(body),
      'a spent deadline must refuse the calls of a round it has not yet sent'
    )
    assert.ok(body.includes('declinedCall('), 'nothing was contacted, so nothing broke')
  })
})

describe('the turn runs its tail under the budget', () => {
  const source = readFileSync(USE_LM_STUDIO, 'utf-8')

  test('one budget covers the whole tail, and it is disarmed', () => {
    assert.ok(
      /createVerifyBudget\(\s*VERIFY_BUDGET_MS,\s*signal,/.test(source),
      'the tail must open a budget bound to the turn signal'
    )
    // …counted from the last token, which is where the stat line starts its
    // "checking" span. Two origins were two clocks (round 13).
    assert.ok(
      /createVerifyBudget\([^)]*answerEndedAt/s.test(source),
      'the budget must count the same span the footer calls "checking"'
    )
    assert.ok(
      source.includes('answerEndedAt = Date.now()') && source.includes('totalMs: answerEndedAt - turnStartedAt'),
      'that origin must be the very stamp `totalMs` is measured to'
    )
    assert.equal(
      (source.match(/createVerifyBudget\(/g) ?? []).length,
      1,
      'one deadline over the tail — three passes each under their own is the same unbounded wait'
    )
    assert.ok(source.includes('budget.stop()'), 'the timer must be disarmed when the tail ends')
  })

  test('every costly pass asks the budget first and reports back', () => {
    for (const pass of ['claims', 'code', 'recompute', 'revising']) {
      assert.ok(source.includes(`budget.admits('${pass}')`), `${pass} must be gated by the budget`)
      assert.ok(source.includes(`budget.ran('${pass}')`), `${pass} must report completion`)
    }
  })

  /**
   * Round 11, FR3 (`.h2h-runs/B10/FR3-20260827-224622`), two lines apart:
   *
   *   🧮 Recomputed the stated figures in Python; the reply's numbers were
   *      compared against that output.
   *   ⏱ Checking stopped at its 60s limit. Ran: the code check. Not run: the
   *      recomputation.
   *
   * The program, its stdout and the comparison were all on screen, above a line
   * saying the pass had not run. The capture's own footer reads `62.2s
   * checking` against a 60 s budget: the recomputation's `run_python` — which
   * is not wired to the budget signal, so it always finishes — started inside
   * the deadline and printed 2.2 s after it. `if (!budget.signal.aborted)
   * budget.ran('recompute')` then withheld the completion, because it asks the
   * clock what the pass did.
   *
   * A10/FR3 got the same line right (`Ran: the code check, the recomputation`)
   * for one reason: its recompute finished a moment inside the budget. The
   * difference between the two arms was timing, not code.
   */
  test('no pass reports its completion by asking the clock', () => {
    assert.ok(
      !/if \(!budget\.signal\.aborted\) budget\.ran\(/.test(source),
      'the deadline notice must be composed from what each pass did, not from when it returned'
    )
  })

  test('each pass hands the budget its own account of what it got done', () => {
    assert.ok(source.includes("if (recompute.ran) budget.ran('recompute')"), 'the recomputation reports itself')
    assert.ok(source.includes("if (revised.trim()) budget.ran('revising')"), 'the revision is its own evidence')
    assert.ok(source.includes("if (checked) budget.ran('claims')"), 'the claim check reports itself')
  })

  test('a pass already in flight is handed the budget signal, not just the turn signal', () => {
    // runClaimCheck / runAutoCritic / runRecompute / reviseAgainstFindings all
    // take an AbortSignal; gating alone would leave the pass that is already
    // running to run forever.
    assert.ok(
      (source.match(/budget\.signal/g) ?? []).length >= 4,
      'the four passes that call out must all abort on the deadline'
    )
  })

  test('the expiry reaches the reader as a check, and the turn still finishes', () => {
    assert.ok(source.includes('budget.notice(tailEndedAt)'), 'the expiry must be read')
    assert.ok(source.includes('checks.push(notice)'), 'and disclosed on the message')
    // Whatever the tail did, the turn is measured end to end and the stat line
    // gets the real number. Round 6 moves the origin back: "end to end" now
    // means from the turn opening, not from the first request — see below.
    assert.ok(
      source.includes('turnMs: tailEndedAt - turnOpenedAt'),
      'the turn must be measured to the moment the composer is released, from the moment it opened'
    )
    assert.ok(
      !/turnMs: Date\.now\(\) - turnStartedAt/.test(source),
      'turnStartedAt is stamped after the providers have run, so it cannot be the turn’s origin'
    )
    // Round 13: one stamp feeds both, so the notice's figure and the stat
    // line's "Ns checking" cannot round to different tenths of the same span.
    assert.ok(
      source.includes('const tailEndedAt = Date.now()'),
      'the tail must be stamped once and read twice, not read twice from the clock'
    )
  })
})

/**
 * Round 6: the wait BEFORE the model, which round 5's "total" started after.
 *
 * A factual turn runs the app's own web_search as a serial context provider
 * before the model is asked anything (lib/contextProviders). `turnStartedAt` —
 * the origin of both `totalMs` and round 5's `turnMs` — is stamped AFTER that
 * whole sequence returns, so every figure on the line began counting once the
 * gather was already over.
 *
 * Measured, replaying runTurn's own ordering against the real gatherTurnContext
 * with the search fixture's 8000 ms sleep: the clock's origin lands at t+8002 ms,
 * and a 39.5 s wait reports as 31.5 s — 20% of it outside every number shown.
 *
 * The recorded runs (.h2h-runs/judge-r5/TTU1) are the same shape and are what
 * the figures below reproduce:
 *
 *   run-1  sendToTurnEndMs 40286   on screen "…31.5s total"   hidden 8786 ms
 *   run-2  sendToTurnEndMs 39791   on screen "…30.9s total"   hidden 8891 ms
 *
 * and the fixture in both: "slept 8000ms then ok".
 */
describe('the stat line accounts for the gather, the way it accounts for checking', () => {
  test('TTU1 run-1: the 8.8s search the footer started after', () => {
    const line = formatTurnCost(
      stats({
        completionTokens: 240,
        tokensPerSecond: 7.6,
        ttftMs: 13_450,
        totalMs: 31_500,
        gatherMs: 8_786,
        turnMs: 40_286
      })
    )
    assert.ok(line.includes('40.3s total'), `the reader waited 40.3s; line was: ${line}`)
    assert.ok(line.includes('8.8s gathering'), `the pre-model search must be named; line was: ${line}`)
    assert.ok(line.includes('31.5s answer'), `the stream is 31.5s and must say so; line was: ${line}`)
    assert.ok(!line.includes('31.5s total'), 'the stream must never be presented as the total')
  })

  test('TTU1 run-2: the same hole, the same size', () => {
    const line = formatTurnCost(
      stats({ completionTokens: 252, tokensPerSecond: 8.1, ttftMs: 7_710, totalMs: 30_900, gatherMs: 8_891, turnMs: 39_791 })
    )
    assert.ok(line.includes('39.8s total'), line)
    assert.ok(line.includes('8.9s gathering'), line)
    assert.ok(!line.includes('30.9s total'), line)
  })

  test('a turn with both waits names both, in the order they happened', () => {
    // TTU1's gather in front of V1's tail: nothing about the turn is unaccounted.
    const line = formatTurnCost(stats({ totalMs: 25_700, gatherMs: 8_786, turnMs: 88_818 }))
    assert.match(line, /8\.8s gathering · 25\.7s answer · 54\.3s checking · 88\.8s total$/, line)
  })

  test('the segments add up to the total — that is what makes them checkable', () => {
    for (const [gather, total, turn] of [
      [8_786, 31_500, 40_286],
      [8_891, 30_900, 39_791],
      [8_786, 25_700, 88_818],
      [1_200, 19_600, 42_640]
    ] as const) {
      const s = stats({ gatherMs: gather, totalMs: total, turnMs: turn })
      assert.equal(
        gatherMs(s) + s.totalMs + tailMs(s),
        turn,
        `gathering + answer + checking must be the total (${gather}/${total}/${turn})`
      )
    }
  })

  test('the gather is not checking — the tail keeps its own meaning', () => {
    // Round 5 read every unaccounted millisecond as post-answer checking. With
    // the origin moved back, the pre-model 8.8s must not be relabelled as a
    // check that never ran.
    const s = stats({ totalMs: 31_500, gatherMs: 8_786, turnMs: 40_286 })
    assert.equal(tailMs(s), 0, 'nothing ran after this answer, so nothing may be called checking')
    assert.ok(!formatTurnCost(s).includes('checking'), 'no tail, no checking figure')
    assert.equal(gatherMs(stats({ totalMs: 31_500, turnMs: 40_286 })), 0, 'an unmeasured gather claims nothing')
  })

  test('a gather too short to matter keeps the line it had', () => {
    // No providers ran, or all of them were disabled: there is no wait to name.
    const line = formatTurnCost(stats({ totalMs: 12_300, gatherMs: 40, turnMs: 12_340 }))
    assert.ok(line.endsWith('12.3s total'), line)
    assert.ok(!line.includes('gathering'), 'a 40 ms gather is not a wait')
  })

  test('the gather is measured, never inferred, and never negative', () => {
    assert.equal(gatherMs(stats({ totalMs: 31_500, gatherMs: 8_786, turnMs: 40_286 })), 8_786)
    // A clock that ran backwards must not put a negative wait on screen.
    assert.equal(gatherMs(stats({ totalMs: 100, gatherMs: -5, turnMs: 100 })), 0)
    assert.equal(tailMs(stats({ totalMs: 31_500, gatherMs: 40_000, turnMs: 40_286 })), 0)
  })
})

describe('the turn clock starts before the providers, not after them', () => {
  const source = readFileSync(USE_LM_STUDIO, 'utf-8')

  test('the origin is stamped ahead of the gather', () => {
    const opened = source.indexOf('const turnOpenedAt = Date.now()')
    const gather = source.indexOf('await gatherTurnContext(')
    const stream = source.indexOf('const turnStartedAt = Date.now()')
    assert.ok(opened > 0, 'the turn must stamp when it opened')
    assert.ok(gather > 0 && stream > 0, 'gather and stream clock not found')
    assert.ok(
      opened < gather,
      'the turn clock must start before the context providers run, or "total" starts after the wait'
    )
    assert.ok(
      gather < stream,
      'the stream clock is stamped after the gather — which is exactly why it cannot be the turn’s origin'
    )
  })

  test('the pre-model wait is measured and put on the stats', () => {
    assert.ok(
      source.includes('const gatherMs = turnStartedAt - turnOpenedAt'),
      'the gather is the distance between the two origins — measured, not estimated'
    )
    assert.ok(source.includes('gatherMs,'), 'and it must reach the stat line through ResponseStats')
  })
})
