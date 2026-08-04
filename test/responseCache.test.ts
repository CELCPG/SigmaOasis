import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearCache,
  getCacheStats,
  getFromCache,
  setInCache
} from '../src/renderer/src/lib/responseCache'
import type { ApiMessage } from '../src/renderer/src/lib/agentLoop'

/**
 * The response cache trades correctness risk for latency, so the guards matter
 * more than the hits. A wrong hit surfaces as the model "remembering" something
 * it was never asked, which is indistinguishable from a confabulation — the
 * exact failure mode the grounding work exists to catch.
 */

function msgs(...contents: string[]): ApiMessage[] {
  return contents.map((content) => ({ role: 'user' as const, content }))
}

describe('response cache', () => {
  beforeEach(() => clearCache())

  test('a miss on an empty cache', () => {
    assert.deepEqual(getFromCache(msgs('hello'), 'm1'), { hit: false })
  })

  test('round-trips an exact message + model pair', () => {
    setInCache(msgs('hello'), 'm1', 'hi there')
    const hit = getFromCache(msgs('hello'), 'm1')
    assert.equal(hit.hit, true)
    assert.equal(hit.hit && hit.response, 'hi there')
  })

  test('the model id is part of the key', () => {
    setInCache(msgs('hello'), 'm1', 'from m1')
    assert.deepEqual(getFromCache(msgs('hello'), 'm2'), { hit: false })
  })

  test('a different history is a different key', () => {
    setInCache(msgs('hello'), 'm1', 'hi')
    assert.deepEqual(getFromCache(msgs('hello', 'and again'), 'm1'), { hit: false })
  })

  test('message order is part of the key', () => {
    setInCache(msgs('a', 'b'), 'm1', 'ab')
    assert.deepEqual(getFromCache(msgs('b', 'a'), 'm1'), { hit: false })
  })

  test('reasoning round-trips alongside the answer', () => {
    setInCache(msgs('q'), 'm1', 'answer', 'thinking')
    const hit = getFromCache(msgs('q'), 'm1')
    assert.equal(hit.hit && hit.reasoning, 'thinking')
  })

  test('an empty response is never stored', () => {
    setInCache(msgs('q'), 'm1', '')
    assert.deepEqual(getFromCache(msgs('q'), 'm1'), { hit: false })
    assert.equal(getCacheStats().size, 0)
  })

  test('re-caching a key does not grow the cache', () => {
    setInCache(msgs('q'), 'm1', 'first')
    setInCache(msgs('q'), 'm1', 'second')
    assert.equal(getCacheStats().size, 1)
    const hit = getFromCache(msgs('q'), 'm1')
    assert.equal(hit.hit && hit.response, 'second')
  })

  test('the cache is bounded and evicts oldest-first', () => {
    for (let i = 0; i < 150; i++) setInCache(msgs(`q${i}`), 'm1', `a${i}`)
    assert.ok(getCacheStats().size <= 100, 'cache should stay at or under its cap')
    // The first entries are gone; the most recent survive.
    assert.deepEqual(getFromCache(msgs('q0'), 'm1'), { hit: false })
    const recent = getFromCache(msgs('q149'), 'm1')
    assert.equal(recent.hit, true)
  })

  test('clearCache empties it', () => {
    setInCache(msgs('q'), 'm1', 'a')
    clearCache()
    assert.equal(getCacheStats().size, 0)
    assert.deepEqual(getFromCache(msgs('q'), 'm1'), { hit: false })
  })

  test('stats report no oldest entry when empty', () => {
    assert.deepEqual(getCacheStats(), { size: 0 })
  })

  test('structured content is keyed by value, not identity', () => {
    const withParts: ApiMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'describe' }] }
    ]
    setInCache(withParts, 'm1', 'a description')
    const again: ApiMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'describe' }] }
    ]
    const hit = getFromCache(again, 'm1')
    assert.equal(hit.hit, true, 'an equal-by-value payload should hit')
  })
})
