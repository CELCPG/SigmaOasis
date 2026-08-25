import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join } from 'path'
import { formatTurnCost, gatherMs, tailMs } from '../src/renderer/src/lib/turnCost'
import { VERIFY_BUDGET_MS, createVerifyBudget } from '../src/renderer/src/lib/turnPhase'
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

  test('a pass still running when the deadline fires counts as not run', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const budget = createVerifyBudget()
    assert.equal(budget.admits('revising'), true)
    t.mock.timers.tick(VERIFY_BUDGET_MS)
    // The revision never returned, so `ran` is never called for it.
    const notice = budget.notice()
    assert.ok(notice)
    assert.match(notice.summary, /Ran: nothing/)
    assert.match(notice.summary, /Not run: the revision/)
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

describe('the turn runs its tail under the budget', () => {
  const source = readFileSync(USE_LM_STUDIO, 'utf-8')

  test('one budget covers the whole tail, and it is disarmed', () => {
    assert.ok(
      source.includes('createVerifyBudget(VERIFY_BUDGET_MS, signal)'),
      'the tail must open a budget bound to the turn signal'
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
    assert.ok(source.includes('budget.notice()'), 'the expiry must be read')
    assert.ok(source.includes('checks.push(notice)'), 'and disclosed on the message')
    // Whatever the tail did, the turn is measured end to end and the stat line
    // gets the real number. Round 6 moves the origin back: "end to end" now
    // means from the turn opening, not from the first request — see below.
    assert.ok(
      source.includes('turnMs: Date.now() - turnOpenedAt'),
      'the turn must be measured to the moment the composer is released, from the moment it opened'
    )
    assert.ok(
      !source.includes('turnMs: Date.now() - turnStartedAt'),
      'turnStartedAt is stamped after the providers have run, so it cannot be the turn’s origin'
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
