import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  TEMPERATURE_PRESETS,
  activePreset,
  recommendedSampling,
  resolveSampling
} from '../src/renderer/src/lib/sampling'
import type { SamplingSettings } from '../src/renderer/src/types'

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

/**
 * v1.5: top-k and min-p reach the wire at all, and `-1` means "use the
 * family's own recipe". The failure being fixed is quiet: through v1.4 every
 * model ran with top-k disabled, and Qwen3 without top-k falls into repetition
 * loops — which read to the user as the model being slow rather than as a
 * sampling problem.
 */
describe('recommendedSampling', () => {
  test('recognizes the qwen3 family, including point releases', () => {
    assert.equal(recommendedSampling('qwen3.5-9b-mlx')?.label, 'Qwen3')
    assert.equal(recommendedSampling('Qwen/Qwen3-8B')?.label, 'Qwen3')
  })

  test('qwen3 gets the top-k it is tuned around', () => {
    assert.equal(recommendedSampling('qwen3.5-9b-mlx')?.recipe.topK, 20)
  })

  test('other known families get their own numbers, not qwen3\'s', () => {
    assert.equal(recommendedSampling('google/gemma-4-12b-qat')?.recipe.topK, 64)
  })

  test('an unknown model has no recipe to apply', () => {
    assert.equal(recommendedSampling('some-experimental-merge-v3'), null)
  })
})

describe('resolveSampling', () => {
  const settings = (over: Partial<SamplingSettings> = {}): SamplingSettings => ({
    temperature: 0.3,
    topP: 1,
    maxTokens: -1,
    seed: null,
    topK: -1,
    minP: -1,
    ...over
  })

  test('auto follows the family recipe', () => {
    assert.equal(resolveSampling(settings(), 'qwen3.5-9b-mlx').topK, 20)
  })

  test('an explicit value always beats the recipe', () => {
    assert.equal(resolveSampling(settings({ topK: 5 }), 'qwen3.5-9b-mlx').topK, 5)
  })

  test('zero is a real setting — off, not unset', () => {
    assert.equal(resolveSampling(settings({ topK: 0 }), 'qwen3.5-9b-mlx').topK, 0)
  })

  test('an unknown family resolves auto to off, exactly as v1.4 behaved', () => {
    assert.equal(resolveSampling(settings(), 'some-experimental-merge-v3').topK, 0)
    assert.equal(resolveSampling(settings(), 'some-experimental-merge-v3').minP, 0)
  })

  test('temperature and top_p are never rewritten by a recipe', () => {
    // The app runs colder than any published recipe on purpose (v1.1): warmer
    // sampling measurably confabulates more on small local models.
    const out = resolveSampling(settings(), 'qwen3.5-9b-mlx')
    assert.equal(out.temperature, 0.3)
    assert.equal(out.topP, 1)
  })
})
