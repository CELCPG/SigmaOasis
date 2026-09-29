import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseNvidiaCsv, parseReplays } from '../src/main/ipc/gpu'
import { machineMoved } from '../scripts/gpuHealth'
import { bytesPerWeight, fitSentence, fitVerdict, paramsFromId } from '../src/renderer/src/lib/modelFit'

/** v4.0 (E1, E9): the GPU read from its own tool, and a model's fit judged before the first reply. */

const GB = 1024 ** 3

describe('nvidia-smi parsing', () => {
  test('the CSV line: name and memory', () => {
    assert.deepEqual(parseNvidiaCsv('NVIDIA GeForce RTX 5070, 12227 MiB\n'), { name: 'NVIDIA GeForce RTX 5070', memoryBytes: 12227 * 1024 * 1024 })
    assert.equal(parseNvidiaCsv(''), null)
    assert.equal(parseNvidiaCsv('garbage'), null)
  })

  test('the replay counter out of -q -d PCIE', () => {
    assert.equal(parseReplays('    PCIe\n        Replays Since Reset  : 7312\n'), 7312)
    assert.equal(parseReplays('no such line'), null)
  })

  test('a counter that rose during a case names the machine; no counter says nothing', () => {
    const before = { name: 'x', memoryBytes: 1, pcieReplays: 10 }
    assert.deepEqual(machineMoved(before, { ...before, pcieReplays: 7300 }), { moved: true, delta: 7290 })
    assert.deepEqual(machineMoved(before, { ...before, pcieReplays: 10 }), { moved: false, delta: 0 })
    assert.deepEqual(machineMoved(null, before), { moved: false, delta: 0 })
    assert.deepEqual(machineMoved({ ...before, pcieReplays: null }, before), { moved: false, delta: 0 })
  })
})

describe('fitVerdict on the bench card (12 GB)', () => {
  const card = 12 * GB

  test('reads parameters and quant from what LM Studio lists', () => {
    assert.equal(paramsFromId('qwen3.8-9b-distill'), 9)
    assert.equal(paramsFromId('qwen3.8-35b-a3b-distill'), 35)
    assert.equal(paramsFromId('prism-ml/bonsai-27b'), 27)
    assert.equal(paramsFromId('text-embedding-nomic-embed-text-v1.5'), null)
    assert.equal(bytesPerWeight('Q4_K_M'), 0.6)
    assert.equal(bytesPerWeight('Q1_0'), 0.22)
    assert.equal(bytesPerWeight('F16'), 2)
  })

  test('the 9B at a 64K window fits — the bench’s own fast model', () => {
    const v = fitVerdict({ id: 'qwen3.8-9b-distill', quantization: 'Q4_K_M', loadedContextLength: 65536 }, card)!
    assert.equal(v.kind, 'fits')
    assert.match(fitSentence(v, 'qwen3.8-9b-distill'), /^Fits/)
  })

  test('the 35B-A3B does not fit a 12 GB card at any window', () => {
    const v = fitVerdict({ id: 'qwen3.8-35b-a3b-distill', quantization: 'Q4_K_M', loadedContextLength: 262144 }, card)!
    assert.equal(v.kind, 'no')
    assert.equal(v.windowThatFits, null)
    assert.match(fitSentence(v, 'x'), /smaller model or quant/)
  })

  test('the 27B 1-bit quant at 262K does not fit, and the sentence names a window that would', () => {
    const v = fitVerdict({ id: 'bonsai-27b', quantization: 'Q1_0', loadedContextLength: 262144 }, card)!
    assert.equal(v.kind, 'no')
    assert.ok(v.windowThatFits !== null && v.windowThatFits < 262144, String(v.windowThatFits))
    assert.match(fitSentence(v, 'bonsai-27b'), /lms load bonsai-27b --context-length \d+/)
  })

  test('a model with no size in its name has no verdict', () => {
    assert.equal(fitVerdict({ id: 'nomic-embed-text-v1.5' }, card), null)
    assert.equal(fitVerdict({ id: 'qwen3.8-9b' }, 0), null)
  })
})
