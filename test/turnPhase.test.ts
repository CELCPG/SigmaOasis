import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  VERIFY_WAITS,
  actionsReady,
  gatheringPhase,
  verifyingPhase,
  waitElapsed,
  type TurnPhase
} from '../src/renderer/src/lib/turnPhase'
import { replyAffordances } from '../src/renderer/src/lib/replyRecovery'
import {
  TURN_CONTEXT_PROVIDERS,
  gatherTurnContext,
  type ContextProvider,
  type ProviderIO,
  type TurnInput
} from '../src/renderer/src/lib/contextProviders'
import { useAppStore } from '../src/renderer/src/stores/appStore'

/**
 * Time-to-useful-output: a finished answer must be usable the moment it is
 * finished, and no wait may be anonymous.
 *
 * The turn stays "streaming" for seconds after the last token — unverified
 * flag, claim check (a whole extra model round trip), code check, grounding
 * report. The action row used to be gated on exactly that flag, so Copy,
 * Regenerate, Think harder, Branch and the timestamp were hidden on an answer
 * that was complete and on screen.
 */

const MESSAGE_BUBBLE = join(
  __dirname,
  '..',
  '..',
  'src',
  'renderer',
  'src',
  'components',
  'MessageBubble.tsx'
)

describe('actionsReady — the answer, not the turn', () => {
  const args = (over: Partial<Parameters<typeof actionsReady>[0]> = {}): Parameters<typeof actionsReady>[0] => ({
    content: 'The answer.',
    isStreaming: true,
    phase: null,
    messageId: 'm1',
    ...over
  })

  test('the verification tail does not hide a finished answer', () => {
    for (const step of ['claims', 'grounding', 'revising'] as const) {
      assert.equal(
        actionsReady(args({ phase: verifyingPhase('m1', step) })),
        true,
        `${step} should leave the finished answer actionable`
      )
    }
  })

  test('a composing reply is not actionable — no phase, or a pre-model one', () => {
    assert.equal(actionsReady(args({ phase: null })), false)
    assert.equal(
      actionsReady(args({ phase: gatheringPhase('m1', { label: 'Searching the web', detail: 'x' }) })),
      false
    )
    assert.equal(actionsReady(args({ content: '', phase: verifyingPhase('m1', 'claims') })), false)
  })

  test('another message being verified does not unlock this one', () => {
    assert.equal(actionsReady(args({ phase: verifyingPhase('other', 'grounding') })), false)
  })

  test('a settled turn needs no phase at all', () => {
    assert.equal(actionsReady(args({ isStreaming: false, phase: null })), true)
    assert.equal(actionsReady(args({ isStreaming: false, content: '' })), false)
  })
})

describe('the action row is wired to the answer', () => {
  const source = readFileSync(MESSAGE_BUBBLE, 'utf-8')

  test('the row is gated by the answer-settled rule, not by the streaming flag', () => {
    // v1.12.2: the gate moved from `canAct` to `affordances`, which asks the
    // same question through the same rule (lib/turnPhase.ts `answerSettled`,
    // shared with `actionsReady`) and additionally opens the row for a reply
    // that came back empty. Same wiring, one more reason to open.
    assert.match(source, /const affordances = replyAffordances\(message, isLast, isStreaming, phaseHere\)/)
    assert.ok(source.includes('{affordances.actions && ('), 'the action row must open on affordances.actions')
    assert.ok(
      !source.includes('{!isStreaming && message.content && ('),
      'the old gate held Copy/Regenerate/Think harder/Branch hostage to the verification tail'
    )
  })

  test('no button inside the row re-introduces the streaming gate', () => {
    const start = source.indexOf('{affordances.actions && (')
    const end = source.indexOf('{oasisState.mode !==', start)
    assert.ok(start > 0 && end > start, 'action row not found')
    const row = source.slice(start, end)
    assert.ok(!row.includes('isStreaming'), 'the action row must not read isStreaming')
    // The affordances the gap named, all inside that row.
    for (const affordance of ['📋 Copy', '↻ Regenerate', '🧠 Think harder', '<BranchMenu', 'formatTime(message.createdAt)']) {
      assert.ok(row.includes(affordance), `${affordance} must live in the row that affordances.actions opens`)
    }
    // Starting a NEW turn still waits for the current one — visibly disabled,
    // never hidden.
    assert.ok(row.includes('disabled={streaming}'))
  })

  test('the continuing work is on screen, not invisible', () => {
    assert.ok(source.includes('{phaseHere && <TurnPhaseLine phase={phaseHere} />}'))
    assert.match(source, /function TurnPhaseLine/)
    assert.match(source, /aria-live="polite"/)
  })
})

describe('the two reasons the row opens (v1.12.2)', () => {
  const reply = (over: Record<string, unknown> = {}) =>
    ({ content: 'The answer.', toolCalls: [], plan: undefined, reasoning: '', ...over }) as Parameters<
      typeof replyAffordances
    >[0]

  test('a finished answer is actionable through the whole verification tail', () => {
    for (const step of ['claims', 'grounding', 'revising'] as const) {
      const a = replyAffordances(reply(), true, true, verifyingPhase('m1', step))
      assert.equal(a.actions, true, `${step}: the row must be open`)
      assert.equal(a.onText, true, `${step}: Copy and Listen must work`)
    }
  })

  test('a reply still being composed offers nothing', () => {
    const a = replyAffordances(reply(), true, true, null)
    assert.equal(a.actions, false)
    assert.equal(a.onText, false)
    const g = replyAffordances(reply(), true, true, gatheringPhase('m1', { label: 'Searching the web', detail: 'x' }))
    assert.equal(g.actions, false, 'a pre-model wait is not a finished answer')
  })

  test('an empty failed reply still gets a way forward', () => {
    const a = replyAffordances(reply({ content: '' }), true, false, null)
    assert.equal(a.empty, true)
    assert.equal(a.actions, true, 'Regenerate must be reachable on the reply that most needs it')
    assert.equal(a.onText, false, 'there is no text to copy, speak or review')
  })

  test('an empty reply that is not the last one stays quiet', () => {
    assert.equal(replyAffordances(reply({ content: '' }), false, false, null).actions, false)
  })
})

describe('every wait has a name', () => {
  test('the serial providers that can block the turn declare one', () => {
    const named = TURN_CONTEXT_PROVIDERS.filter((p) => p.wait).map((p) => p.id)
    assert.deepEqual(named, ['autoSearch', 'libraryPassages', 'shoppingPrice'])
    for (const p of TURN_CONTEXT_PROVIDERS) {
      if (!p.wait) continue
      assert.equal(p.phase, 'serial', `${p.id}: only a serial wait is worth naming`)
      assert.ok(p.wait.label.length > 3 && p.wait.detail.length > 10, `${p.id}: name the wait`)
    }
  })

  test('the post-answer passes are named too, and say the answer is done', () => {
    assert.deepEqual(Object.keys(VERIFY_WAITS), ['claims', 'grounding', 'revising'])
    for (const wait of Object.values(VERIFY_WAITS)) {
      assert.ok(wait.label.length > 3 && wait.detail.length > 10)
    }
  })
})

/**
 * Round 6: the pre-model wait, while it is happening.
 *
 * The name reaches the reader — `gatherTurnContext` announces the serial
 * provider before its await, the store carries it, and the bubble renders the
 * line. What never reaches them is the wait itself: the line says WHAT is being
 * waited on and never that it is STILL being waited on, or for how long. Worse,
 * the label changes as the walk moves from provider to provider, so what the
 * reader can see resets while their wait does not.
 *
 * TTU1 is the shape: the search fixture slept 8000 ms in both recorded runs
 * (.h2h-runs/judge-r5/TTU1, "slept 8000ms then ok"), the library provider
 * followed it, and the whole window went by with nothing on screen that a
 * mid-wait screenshot could have counted. That is why neither capture could
 * settle the question — there was no number in the picture to read.
 */
describe('the reader is shown the pre-model wait while it is happening', () => {
  const io = {} as ProviderIO
  const turn = (): TurnInput => ({ signal: new AbortController().signal }) as TurnInput

  const sleeps = (id: string, ms: number, label: string): ContextProvider => ({
    id,
    phase: 'serial',
    wait: { label, detail: 'before the model is asked' },
    enabled: () => true,
    gather: () => new Promise((resolve) => setTimeout(() => resolve({ blocks: [id] }), ms))
  })

  test('TTU1: the count runs to 8s, and a new provider does not restart it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    const turnOpenedAt = Date.now()
    let phase: TurnPhase | null = null
    const onScreen: string[] = []

    const walk = gatherTurnContext(
      [sleeps('autoSearch', 8_000, 'Searching the web'), sleeps('libraryPassages', 2_000, 'Reading the reference library')],
      turn(),
      io,
      (wait) => {
        phase = wait ? gatheringPhase('m1', wait, turnOpenedAt) : null
      }
    )

    // A second of wall clock per sample, exactly as the reader experiences it.
    for (let second = 0; second <= 9; second += 1) {
      onScreen.push(phase ? `${(phase as TurnPhase).label} ${waitElapsed(phase, Date.now())}` : 'nothing')
      t.mock.timers.tick(1_000)
      await new Promise((resolve) => setImmediate(resolve))
    }
    await walk

    assert.deepEqual(onScreen, [
      'Searching the web 0s',
      'Searching the web 1s',
      'Searching the web 2s',
      'Searching the web 3s',
      'Searching the web 4s',
      'Searching the web 5s',
      'Searching the web 6s',
      'Searching the web 7s',
      // The search returned at 8s and the library took over. The reader has
      // still been waiting eight seconds, so the count must not go back to 0s.
      'Reading the reference library 8s',
      'Reading the reference library 9s'
    ])
  })

  test('the count is of the whole pre-model wait, not of the current provider', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const turnOpenedAt = Date.now()
    t.mock.timers.tick(8_786) // TTU1 run-1's measured gather
    const phase = gatheringPhase('m1', { label: 'Reading the reference library', detail: 'x' }, turnOpenedAt)
    assert.equal(phase.since, turnOpenedAt, 'the phase carries the turn’s origin, not this provider’s')
    assert.equal(waitElapsed(phase, Date.now()), '8s')
    // A minute-long gather reads as a clock, not as a four-digit millisecond count.
    t.mock.timers.tick(60_000)
    assert.equal(waitElapsed(phase, Date.now()), '1:08')
  })

  test('a clock that runs backwards shows no wait rather than a negative one', () => {
    const phase = gatheringPhase('m1', { label: 'Searching the web', detail: 'x' }, 10_000)
    assert.equal(waitElapsed(phase, 9_000), '0s')
  })

  test('the line the reader sees renders that count, and keeps it running', () => {
    const source = readFileSync(MESSAGE_BUBBLE, 'utf-8')
    const start = source.indexOf('function TurnPhaseLine')
    assert.ok(start > 0, 'TurnPhaseLine not found')
    const line = source.slice(start, start + 2_600)
    assert.ok(line.includes('waitElapsed'), 'the pre-model wait must show how long it has run')
    assert.ok(
      line.includes('startWaitClock'),
      'and keep counting on its own — a number stamped once is not a wait being shown'
    )
  })
})

describe('a phase never outlives its turn', () => {
  test('ending the turn clears it', () => {
    const phase: TurnPhase = verifyingPhase('m1', 'grounding')
    useAppStore.getState().setStreaming(true)
    useAppStore.getState().setTurnPhase(phase)
    assert.deepEqual(useAppStore.getState().turnPhase, phase)
    useAppStore.getState().setStreaming(false)
    assert.equal(useAppStore.getState().turnPhase, null)
  })
})
