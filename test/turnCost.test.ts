import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join } from 'path'
import { formatTurnCost, tailMs } from '../src/renderer/src/lib/turnCost'
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
    // gets the real number.
    assert.ok(
      source.includes('turnMs: Date.now() - turnStartedAt'),
      'the turn must be measured to the moment the composer is released'
    )
  })
})
