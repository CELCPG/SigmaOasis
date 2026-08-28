import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  makeTailStream,
  TAIL_DRAIN_MS,
  TAIL_FLUSH_MS
} from '../src/renderer/src/hooks/chatTransport'
import { useAppStore } from '../src/renderer/src/stores/appStore'
import type { ChatMessage } from '../src/renderer/src/types'

/**
 * The streaming tail pacer, and the one property it did not have: that the turn
 * is not over until the last character is on screen.
 *
 * v2.1 introduced a display cursor that glides toward the buffered content a
 * fraction of the backlog per frame, and `finish()` returned the instant the
 * *stream* ended rather than when the drain did. The caller went straight on to
 * clear `streaming` — releasing the composer and turning Stop back into Send —
 * while text was still being painted. Both recorded arms produced answers cut
 * mid-word in a capture taken at turn end: `…unique needs (pet` against a model
 * that wrote `(pets, seniors, infants).`, and `…and inspection require` against
 * `requirements.`
 *
 * These tests hold the fix from both sides: the promise must not resolve early
 * (the defect), and the glide must still be a glide (the animation this round
 * is explicitly not allowed to delete). Stop is its own case, because a user who
 * pressed Stop asked for the turn to be over, not to watch the rest of it type.
 */

interface FrameHook {
  requestAnimationFrame: (cb: () => void) => number
  cancelAnimationFrame: (h: number) => void
}
const g = globalThis as unknown as FrameHook & { requestAnimationFrame?: unknown }

let timers: NodeJS.Timeout[] = []
let savedRaf: unknown
let savedCaf: unknown

beforeEach(() => {
  useAppStore.setState({ streamingTail: null })
  savedRaf = g.requestAnimationFrame
  savedCaf = (globalThis as Record<string, unknown>).cancelAnimationFrame
  // Node has no rAF. A 16 ms timer is the same contract the pacer needs: a
  // callback that fires roughly once a frame while the page is visible.
  g.requestAnimationFrame = (cb: () => void): number => {
    const t = setTimeout(cb, 16)
    timers.push(t)
    return t as unknown as number
  }
  g.cancelAnimationFrame = (h: number): void => clearTimeout(h as unknown as NodeJS.Timeout)
})

afterEach(() => {
  for (const t of timers) clearTimeout(t)
  timers = []
  ;(globalThis as Record<string, unknown>).requestAnimationFrame = savedRaf
  ;(globalThis as Record<string, unknown>).cancelAnimationFrame = savedCaf
})

function assistant(): ChatMessage {
  return { id: 'a1', role: 'assistant', content: '', createdAt: Date.now() }
}

/**
 * Every text the tail ever published, in order.
 *
 * Reading `streamingTail` after the fact would report nothing: the slice is
 * released when the drain completes and MessageBubble falls back to the
 * message's own content from there. What these tests are about is the last
 * thing the streaming bubble was given to draw, so that is what is recorded.
 */
function recorder(): { steps: () => string[]; stop: () => void } {
  const steps: string[] = []
  const unsubscribe = useAppStore.subscribe((s) => {
    if (s.streamingTail && s.streamingTail.messageId === 'a1') steps.push(s.streamingTail.text)
  })
  return { steps: () => steps, stop: unsubscribe }
}

/** The last text the tail published — the final frame the reader saw. */
function lastPainted(steps: string[]): string {
  return steps.length === 0 ? '' : steps[steps.length - 1]
}

describe('the turn is not over until the last character is painted', () => {
  test('finish() resolves only once the whole reply has been published', async () => {
    const msg = assistant()
    const rec = recorder()
    const tail = makeTailStream(msg, () => {})
    // A burst that arrives all at once: the pacer has published nothing of it.
    msg.content = 'Customize based on your household’s unique needs (pets, seniors, infants).'
    tail.schedule()
    assert.equal(rec.steps().length, 0, 'nothing is published synchronously')

    let resolved = false
    const settled = tail.finish().then(() => {
      resolved = true
    })
    // The exact defect: v2.1's finish() was already done here, with the reply
    // short by however much the pacer had left to draw.
    assert.equal(resolved, false, 'finish() must not resolve while text is still to paint')

    await settled
    rec.stop()
    assert.equal(lastPainted(rec.steps()), msg.content)
    assert.equal(useAppStore.getState().streamingTail, null, 'the slice is released at the end')
  })

  test('the last word of the reply is on screen when the promise resolves', async () => {
    const msg = assistant()
    const rec = recorder()
    const tail = makeTailStream(msg, () => {})
    msg.content = 'Refrigerate leftovers within two hours to keep them safe'
    tail.schedule()
    await tail.finish()
    rec.stop()
    // Not a length check: the recorded failures were all a truncated final
    // token, and "safe" is the word a critic could not read on one of them.
    const painted = lastPainted(rec.steps())
    assert.ok(painted.endsWith('safe'), `ended with: ${JSON.stringify(painted.slice(-24))}`)
  })

  test('a reply that finishes with nothing outstanding still resolves', async () => {
    const msg = assistant()
    const rec = recorder()
    const tail = makeTailStream(msg, () => {})
    msg.content = 'ok'
    tail.schedule()
    await tail.finish()
    rec.stop()
    assert.equal(lastPainted(rec.steps()), 'ok')
  })

  test('the drain lands inside its deadline, however big the backlog', async () => {
    // The reason the drain is keyed to a deadline rather than to a per-frame
    // fraction: the fraction is open-ended, and a large backlog turned into
    // seconds of typewriter with the composer held the whole time.
    for (const size of [40, 400, 4000]) {
      useAppStore.setState({ streamingTail: null })
      const msg = assistant()
      const rec = recorder()
      const tail = makeTailStream(msg, () => {})
      msg.content = 'x'.repeat(size)
      tail.schedule()
      const started = Date.now()
      await tail.finish()
      const took = Date.now() - started
      rec.stop()
      assert.equal(lastPainted(rec.steps()).length, size)
      // Deadline plus one frame of slack for the timer this test substitutes
      // for rAF. Strictly bounded is the property; the exact slack is not.
      assert.ok(
        took <= TAIL_DRAIN_MS + 4 * TAIL_FLUSH_MS,
        `${size} chars drained in ${took} ms, over the ${TAIL_DRAIN_MS} ms deadline`
      )
    }
  })
})

describe('the glide survives the fix', () => {
  test('a finished tail is still published in more than one step', async () => {
    // The true negative for the round: making the composer wait for the paint
    // would also be satisfied by deleting the pacing and drawing everything in
    // one jump, which is the jerky load v2.1 set out to fix. It must not be.
    const msg = assistant()
    const rec = recorder()
    const tail = makeTailStream(msg, () => {})
    msg.content = 'y'.repeat(600)
    tail.schedule()
    await tail.finish()
    rec.stop()
    const steps = rec.steps().map((t) => t.length)
    assert.ok(steps.length >= 3, `published in ${steps.length} step(s); expected a glide`)
    // Monotonic, and never past the end of the buffer.
    for (let i = 1; i < steps.length; i++) assert.ok(steps[i] >= steps[i - 1])
    assert.ok(Math.max(...steps) <= 600)
  })

  test('the first publish of a burst is a fraction of it, not the whole thing', async () => {
    const msg = assistant()
    const rec = recorder()
    const tail = makeTailStream(msg, () => {})
    msg.content = 'z'.repeat(400)
    tail.schedule()
    await new Promise((r) => setTimeout(r, 40))
    const first = rec.steps().length === 0 ? 0 : rec.steps()[0].length
    assert.ok(first > 0, 'the pacer published nothing at all')
    assert.ok(first < 400, `the whole burst landed in one publish (${first} chars)`)
    await tail.finish()
    rec.stop()
  })
})

describe('Stop means stop', () => {
  test('finish(immediate) publishes the rest at once and resolves', async () => {
    const msg = assistant()
    const rec = recorder()
    const tail = makeTailStream(msg, () => {})
    msg.content = 'w'.repeat(2000)
    tail.schedule()
    const started = Date.now()
    await tail.finish(true)
    rec.stop()
    // Everything that had streamed is kept — Stop must not cost the user the
    // text that already arrived — and the wait is not the drain deadline.
    assert.equal(lastPainted(rec.steps()).length, 2000)
    assert.ok(Date.now() - started < TAIL_DRAIN_MS, `Stop waited ${Date.now() - started} ms`)
  })
})

describe('the caller can never be stranded', () => {
  test('a tail usurped by a newer message still resolves', async () => {
    const msg = assistant()
    const tail = makeTailStream(msg, () => {})
    msg.content = 'q'.repeat(800)
    tail.schedule()
    // A second turn's stream takes the slice over mid-drain. Before the fix
    // this path returned from the frame loop without resolving anything; with
    // an awaited finish() that would have hung the turn forever.
    useAppStore.getState().setStreamingTail({ messageId: 'a2', text: 'another reply' })
    await tail.finish()
    assert.equal(
      useAppStore.getState().streamingTail?.messageId,
      'a2',
      'the newer stream must keep the slice'
    )
  })

  test('finish() with frames stopped resolves off the occlusion path', async () => {
    const msg = assistant()
    const rec = recorder()
    const tail = makeTailStream(msg, () => {})
    msg.content = 'e'.repeat(500)
    // Frames stale by more than OCCLUDED_AFTER_MS: the pacer degrades to the
    // whole-chunk flush, and finish() has to resolve from there too.
    await new Promise((r) => setTimeout(r, 320))
    await tail.finish()
    rec.stop()
    assert.equal(lastPainted(rec.steps()).length, 500)
  })
})
