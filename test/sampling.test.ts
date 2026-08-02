import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { TEMPERATURE_PRESETS, activePreset } from '../src/renderer/src/lib/sampling'

/**
 * Temperature presets exist to make the factual/creative trade-off legible.
 * The one guarantee that matters: a hand-tuned value matches no preset —
 * calling 0.42 "Balanced" would misdescribe what the user set.
 */

describe('TEMPERATURE_PRESETS', () => {
  test('offers factual, balanced, and creative in ascending order', () => {
    assert.deepEqual(
      TEMPERATURE_PRESETS.map((p) => p.label),
      ['Factual', 'Balanced', 'Creative']
    )
    const values = TEMPERATURE_PRESETS.map((p) => p.value)
    assert.ok(values[0]! < values[1]! && values[1]! < values[2]!)
  })

  test('factual is the confabulation-reducing 0.3 from the grounding work', () => {
    assert.equal(TEMPERATURE_PRESETS[0]!.value, 0.3)
  })

  test('every preset explains its trade-off', () => {
    for (const p of TEMPERATURE_PRESETS) assert.ok(p.hint.length > 20, `${p.label} needs a real hint`)
  })
})

describe('activePreset', () => {
  test('exact values highlight their preset', () => {
    assert.equal(activePreset(0.3)?.label, 'Factual')
    assert.equal(activePreset(0.5)?.label, 'Balanced')
    assert.equal(activePreset(0.8)?.label, 'Creative')
  })

  test('a custom value highlights nothing', () => {
    assert.equal(activePreset(0.42), null)
    assert.equal(activePreset(0), null)
    assert.equal(activePreset(1.5), null)
  })
})
