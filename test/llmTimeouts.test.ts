import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './harness'

const llm = load<typeof import('../src/main/ipc/llm')>('llm')

/**
 * Through v1.3 a single 120s constant governed every main-process model call.
 * A 12B model writing a 1400-token research brief on laptop hardware does not
 * finish in that, so runs that had already fetched and ranked eight pages
 * threw all of it away at the final step. The timeout now scales with what the
 * model was asked to write.
 */

describe('timeoutForTokens', () => {
  test('a long generation gets more room than the old flat 120s', () => {
    // The research brief: the call that was actually failing.
    assert.ok(llm.timeoutForTokens(1400) > 120_000)
  })

  test('longer requests get proportionally longer ceilings', () => {
    assert.ok(llm.timeoutForTokens(1400) > llm.timeoutForTokens(400))
  })

  test('a short request still gets a usable floor', () => {
    assert.ok(llm.timeoutForTokens(10) >= 90_000)
  })

  test('nothing waits forever — the ceiling is bounded', () => {
    assert.ok(llm.timeoutForTokens(100_000) <= 300_000)
  })

  test('an unspecified budget is treated as a middling one', () => {
    assert.ok(llm.timeoutForTokens(undefined) >= 90_000)
    assert.ok(llm.timeoutForTokens(undefined) <= 300_000)
  })
})

describe('parseSseDeltas', () => {
  test('reads content out of completion frames', () => {
    const buffer =
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n' +
      'data: {"choices":[{"delta":{"content":" world"}}]}\n'
    assert.deepEqual(llm.parseSseDeltas(buffer), { text: 'Hello world', rest: '' })
  })

  test('an incomplete trailing frame is carried, not dropped', () => {
    // A delta can split across chunk boundaries; losing the remainder loses
    // tokens silently, which is the bug this return shape exists to prevent.
    const buffer = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\ndata: {"choices":[{"delt'
    const out = llm.parseSseDeltas(buffer)
    assert.equal(out.text, 'Hi')
    assert.equal(out.rest, 'data: {"choices":[{"delt')
  })

  test('[DONE] and blank frames are skipped', () => {
    const buffer = 'data: [DONE]\n\ndata: {"choices":[{"delta":{"content":"x"}}]}\n'
    assert.equal(llm.parseSseDeltas(buffer).text, 'x')
  })

  test('a malformed frame does not fail the stream', () => {
    const buffer = 'data: {not json}\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n'
    assert.equal(llm.parseSseDeltas(buffer).text, 'ok')
  })

  test('non-streaming message frames are read too', () => {
    const buffer = 'data: {"choices":[{"message":{"content":"whole"}}]}\n'
    assert.equal(llm.parseSseDeltas(buffer).text, 'whole')
  })

  test('a buffer with no line break yields nothing yet', () => {
    assert.deepEqual(llm.parseSseDeltas('data: {"cho'), { text: '', rest: 'data: {"cho' })
  })
})

describe('PartialCompletionError', () => {
  test('carries what the model had already written', () => {
    const err = new llm.PartialCompletionError('Request timed out after 300s.', 'four paragraphs')
    assert.equal(err.partial, 'four paragraphs')
    assert.equal(err.name, 'PartialCompletionError')
    assert.ok(err instanceof Error)
  })
})
