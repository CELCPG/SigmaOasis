import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { describeProfile, parseSizeB, profileFor, toolCallingFromEval } from '../src/renderer/src/lib/modelProfiles'
import type { EvalScoreSummary } from '../src/renderer/src/types'

/**
 * v1.5.1 model profiles: family/size parsing, the measured-beats-prior rule,
 * and the one-line description the picker shows.
 */
const rate = (hit: number, of: number): { hit: number; of: number } => ({ hit, of })
const score = (o: Partial<EvalScoreSummary>): EvalScoreSummary => ({
  model: 'x',
  ranAt: '2026-08-16T00:00:00Z',
  correctTool: rate(0, 0),
  spuriousCall: rate(0, 0),
  argValidity: rate(0, 0),
  loop: rate(0, 0),
  ...o
})

describe('parseSizeB', () => {
  test('reads common id shapes', () => {
    assert.equal(parseSizeB('qwen/qwen3.5-9b'), 9)
    assert.equal(parseSizeB('google/gemma-4-12b-qat'), 12)
    assert.equal(parseSizeB('google/gemma-4-e4b'), 4)
    assert.equal(parseSizeB('mistralai/mixtral-8x7b-instruct'), 7)
    assert.equal(parseSizeB('llama-3.1-70B-Instruct-Q4_K_M'), 70)
    assert.equal(parseSizeB('phi-4-mini'), null)
    assert.equal(parseSizeB('text-embedding-nomic-embed-text-v1.5'), null)
  })
})

describe('profileFor', () => {
  test('a Qwen3 9B: family, reasoning, closed-think, recipe, prior tool calling', () => {
    const p = profileFor('qwen/qwen3.5-9b')
    assert.equal(p.family, 'Qwen3')
    assert.equal(p.sizeB, 9)
    assert.equal(p.reasoning, true)
    assert.equal(p.thinkingControl, 'closed-think')
    assert.equal(p.samplingRecipe, 'Qwen3')
    assert.equal(p.toolCalling.level, 'reliable')
    assert.equal(p.toolCalling.basis, 'prior')
    assert.equal(p.deliberationWorthwhile, true)
    assert.match(describeProfile(p), /^Qwen3 · 9B · reasoning · tools: reliable \(prior\)$/)
  })
  test('a Gemma 4 e4b: native thinking, small-model note, mixed prior', () => {
    const p = profileFor('google/gemma-4-e4b')
    assert.equal(p.family, 'Gemma 4')
    assert.equal(p.thinkingControl, 'native')
    assert.equal(p.toolCalling.level, 'mixed')
    assert.ok(p.notes.some((n) => /Small model/.test(n)))
  })
  test('unknown family and size → unknown, no invented prior', () => {
    const p = profileFor('mystery-model')
    assert.equal(p.family, null)
    assert.equal(p.sizeB, null)
    assert.equal(p.toolCalling.level, 'unknown')
    assert.equal(p.toolCalling.basis, 'none')
    assert.equal(describeProfile(p), '')
  })
  test('a measured eval beats the prior, and says so', () => {
    const measured = profileFor('qwen/qwen3.5-9b', score({ correctTool: rate(6, 15), spuriousCall: rate(4, 8) }))
    assert.equal(measured.toolCalling.level, 'unreliable')
    assert.equal(measured.toolCalling.basis, 'measured')
    assert.match(measured.toolCalling.detail, /measured: tool-choice 6\/15/)
    assert.match(describeProfile(measured), /tools: unreliable \(measured\)/)
  })
  test('an eval with no fixtures does not override the prior', () => {
    const p = profileFor('qwen/qwen3.5-9b', score({}))
    assert.equal(p.toolCalling.basis, 'prior')
  })
  test('a large reasoning model does not get the deliberation recommendation', () => {
    assert.equal(profileFor('deepseek-r1-distill-qwen-32b').deliberationWorthwhile, false)
    assert.equal(profileFor('llama-3.1-70b').deliberationWorthwhile, true)
  })
})

describe('toolCallingFromEval', () => {
  test('thresholds', () => {
    assert.equal(toolCallingFromEval(score({ correctTool: rate(15, 15) })).level, 'reliable')
    assert.equal(toolCallingFromEval(score({ correctTool: rate(10, 15) })).level, 'mixed')
    assert.equal(toolCallingFromEval(score({ correctTool: rate(15, 15), loop: rate(3, 10) })).level, 'mixed')
    assert.equal(toolCallingFromEval(score({ correctTool: rate(5, 15) })).level, 'unreliable')
  })
})
