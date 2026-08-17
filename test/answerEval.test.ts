import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  citesSource,
  measurementsIn,
  numbersIn,
  scoreLibrary,
  scoreQuantitative,
  statesValue,
  summarizeLibrary,
  summarizeQuant,
  unsupportedMeasurements
} from '../src/renderer/src/lib/answerEval'

/**
 * v1.6 answer-quality eval scoring. Every judgement is mechanical, so every
 * judgement is pinnable — including the fixtures themselves, which are the
 * ground truth the suites are measured against and must stay well-formed.
 */
describe('numbers and values', () => {
  test('reads separators and currency, ignores word-joined digits', () => {
    assert.deepEqual(numbersIn('$31,997.12 and 1436.05 plus 7 items (v2 build)'), [31997.12, 1436.05, 7])
  })
  test('a difference of exactly the tolerance passes despite binary floating point', () => {
    // |31997.13 - 31997.12| is 0.010000000002 in binary: the naive compare
    // failed a model that had answered correctly (measured, v1.6).
    assert.equal(statesValue('The total out the door is $31,997.13.', 31997.12, 0.01), true)
    assert.equal(statesValue('The total out the door is $31,997.13.', 31997.125, 0.01), true)
    assert.equal(statesValue('The total out the door is $31,997.12.', 31997.125, 0.01), true)
    // Still strict past the tolerance.
    assert.equal(statesValue('The total out the door is $31,997.99.', 31997.125, 0.01), false)
  })

  test('statesValue tolerates formatting and rounding, not wrong answers', () => {
    assert.equal(statesValue('The total is $31,997.12.', 31997.12), true)
    assert.equal(statesValue('about 1436.0483 a month', 1436.05, 0.05), true)
    assert.equal(statesValue('The total is $31,796.25.', 31997.12), false)
    assert.equal(statesValue('no numbers at all', 5), false)
  })
  test('scoreQuantitative names what is missing', () => {
    const s = scoreQuantitative('Simple interest is $2,400.00.', [
      { label: 'simple interest', value: 2400 },
      { label: 'compound interest', value: 2721.03, tolerance: 0.05 }
    ])
    assert.equal(s.hit, false)
    assert.deepEqual(s.missing, ['compound interest'])
  })
})

describe('measurements and support', () => {
  test('only numbers carrying a unit count', () => {
    assert.deepEqual(
      measurementsIn('Cool for 20 minutes, cook to 165°F, take 400 mg — 7 people watched').map((m) => m.raw),
      ['20 minutes', '165°F', '400 mg']
    )
  })
  test('a measurement absent from the passages is flagged; a present or rounded one is not', () => {
    const corpus = 'Hold the burn under cool running water for 15 to 30 minutes. Cook poultry to 165°F.'
    assert.deepEqual(unsupportedMeasurements('Cool it for 45 minutes and cook to 165°F.', corpus), ['45 minutes'])
    assert.deepEqual(unsupportedMeasurements('Cool it for 20 minutes.', corpus), ['20 minutes'])
    assert.deepEqual(unsupportedMeasurements('Cool for 15 minutes, up to 30 minutes.', corpus), [])
  })
  test('citesSource needs a bracket or a real title, not "the manual"', () => {
    assert.equal(citesSource('As [1] says, cool the burn.', []), true)
    assert.equal(citesSource('According to Burns and scalds, cool it.', ['Burns and scalds']), true)
    assert.equal(citesSource('The manual says to cool it.', ['Burns and scalds']), false)
  })
  test('scoreLibrary combines answered / cited / unsupported / forbidden', () => {
    const s = scoreLibrary('Hold it under cool running water for 45 minutes. Do not use ice. — Burns and scalds', {
      mustInclude: ['cool(ing)? (running )?water'],
      mustNotInclude: ['butter'],
      passages: 'Hold the burn under cool running water for 15 to 30 minutes. Do not apply butter.',
      titles: ['Burns and scalds']
    })
    assert.equal(s.answered, true)
    assert.equal(s.cited, true)
    assert.deepEqual(s.unsupported, ['45 minutes'])
    assert.deepEqual(s.forbidden, [])
  })
})

describe('summaries', () => {
  test('errored arms are excluded from rates, not counted as failures', () => {
    const q = summarizeQuant([
      { file: 'a', prompt: '', bare: { hit: false, missing: ['x'], ms: 1000 }, workbench: { hit: true, missing: [], ms: 2000, toolCalls: 1 } },
      { file: 'b', prompt: '', bare: { hit: true, missing: [], ms: 3000 }, workbench: { hit: false, missing: [], ms: 0, toolCalls: 0, error: 'HTTP 500' } }
    ])
    assert.deepEqual(q.bare, { hit: 1, of: 2 })
    assert.deepEqual(q.workbench, { hit: 1, of: 1 })
    assert.equal(q.seconds.bare, 2)
  })
  test('library summary counts unsupported cases (lower is better)', () => {
    const l = summarizeLibrary([
      { file: 'a', prompt: '', passagesFound: 3, ms: 1000, score: { answered: true, missing: [], cited: true, unsupported: [], forbidden: [] } },
      { file: 'b', prompt: '', passagesFound: 0, ms: 1000, score: { answered: false, missing: ['x'], cited: false, unsupported: ['45 minutes'], forbidden: [] } }
    ])
    assert.deepEqual(l.retrieved, { hit: 1, of: 2 })
    assert.deepEqual(l.answered, { hit: 1, of: 2 })
    assert.deepEqual(l.unsupported, { hit: 1, of: 2 })
  })
})

describe('the fixtures themselves', () => {
  const root = join(__dirname, '..', '..', 'test', 'fixtures')
  test('quantitative fixtures are well-formed and name their data files', () => {
    const dir = join(root, 'quant')
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    assert.ok(files.length >= 15, `${files.length} quant fixtures`)
    const data = new Set(readdirSync(join(dir, 'data')))
    for (const f of files) {
      const fx = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as { prompt?: string; expect?: unknown[]; data?: string }
      assert.ok(fx.prompt && fx.prompt.length > 20, `${f}: prompt`)
      assert.ok(Array.isArray(fx.expect) && fx.expect.length > 0, `${f}: expect`)
      for (const e of fx.expect as { label?: string; value?: unknown }[]) {
        assert.ok(e.label, `${f}: expectation needs a label`)
        assert.equal(typeof e.value, 'number', `${f}: expectation needs a numeric value`)
      }
      if (fx.data) assert.ok(data.has(fx.data), `${f}: missing data file ${fx.data}`)
    }
  })
  test('library fixtures are well-formed and their patterns compile', () => {
    const dir = join(root, 'library')
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    assert.ok(files.length >= 20, `${files.length} library fixtures`)
    for (const f of files) {
      const fx = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as { prompt?: string; mustInclude?: string[]; mustNotInclude?: string[] }
      assert.ok(fx.prompt && fx.prompt.length > 15, `${f}: prompt`)
      assert.ok(Array.isArray(fx.mustInclude) && fx.mustInclude.length > 0, `${f}: mustInclude`)
      for (const p of [...(fx.mustInclude ?? []), ...(fx.mustNotInclude ?? [])]) {
        assert.doesNotThrow(() => new RegExp(p, 'i'), `${f}: bad pattern ${p}`)
      }
    }
  })
})
