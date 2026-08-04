import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  budgetContextLength,
  describeEvalScore,
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


describe('describeEvalScore (Layer 0c)', () => {
  test('a full summary reads as one compact line', () => {
    const line = describeEvalScore({
      model: 'm',
      ranAt: '2026-08-03T12:00:00Z',
      correctTool: { hit: 15, of: 15 },
      spuriousCall: { hit: 0, of: 3 },
      argValidity: { hit: 16, of: 16 },
      loop: { hit: 0, of: 18 }
    })
    assert.equal(line, 'tool-choice 15/15 · args 100% · no spurious calls · no loops')
  })

  test('nonzero spurious and loop counts are stated plainly', () => {
    const line = describeEvalScore({
      model: 'm',
      ranAt: '2026-08-03T12:00:00Z',
      correctTool: { hit: 9, of: 16 },
      spuriousCall: { hit: 1, of: 3 },
      argValidity: { hit: 9, of: 9 },
      loop: { hit: 2, of: 19 }
    })
    assert.equal(line, 'tool-choice 9/16 · args 100% · spurious calls 1/3 · looped 2/19')
  })

  test('a rate with nothing behind it is omitted, not shown as 100%', () => {
    const line = describeEvalScore({
      model: 'm',
      ranAt: '2026-08-03T12:00:00Z',
      correctTool: { hit: 0, of: 0 },
      spuriousCall: { hit: 0, of: 0 },
      argValidity: { hit: 0, of: 0 },
      loop: { hit: 0, of: 0 }
    })
    assert.equal(line, '')
  })
})
