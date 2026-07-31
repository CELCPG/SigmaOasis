import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  budgetContextLength,
  effectiveContextLength,
  formatContextLength
} from '../src/renderer/src/lib/modelInfo'
import type { ModelInfo } from '../src/renderer/src/types'

/**
 * budgetContextLength decides when history compaction fires. If the override
 * precedence regresses, compaction triggers at the wrong point and long
 * conversations silently lose their beginning — pinned here.
 */

describe('formatContextLength', () => {
  test('formats thousands as K (decimal, not binary)', () => {
    assert.equal(formatContextLength(32000), '32K')
    assert.equal(formatContextLength(32768), '33K')
    assert.equal(formatContextLength(4500), '4.5K')
    assert.equal(formatContextLength(900), '900')
  })
})

describe('effectiveContextLength', () => {
  test('prefers the loaded window over the maximum', () => {
    const model: ModelInfo = { id: 'm', loadedContextLength: 4096, maxContextLength: 131072 }
    assert.equal(effectiveContextLength(model), 4096)
  })

  test('falls back to the maximum, then to undefined', () => {
    assert.equal(effectiveContextLength({ id: 'm', maxContextLength: 8192 }), 8192)
    assert.equal(effectiveContextLength({ id: 'm' }), undefined)
    assert.equal(effectiveContextLength(undefined), undefined)
  })
})

describe('budgetContextLength', () => {
  const catalog: ModelInfo = { id: 'm', loadedContextLength: 4096 }

  test('a per-slot override wins over whatever the server reports', () => {
    assert.equal(budgetContextLength({ contextWindow: 32768 }, catalog), 32768)
  })

  test('null means auto: defer to the server', () => {
    assert.equal(budgetContextLength({ contextWindow: null }, catalog), 4096)
  })

  test('no slot and no catalog means no budget, which triggers the fallback path', () => {
    assert.equal(budgetContextLength(undefined, undefined), undefined)
    assert.equal(budgetContextLength({ contextWindow: null }, undefined), undefined)
  })
})
