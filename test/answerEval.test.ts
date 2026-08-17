import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  stabilityAcrossPasses,
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
      mustNotAssert: ['butter'],
      passages: 'Hold the burn under cool running water for 15 to 30 minutes. Do not apply butter.',
      titles: ['Burns and scalds']
    })
    assert.equal(s.answered, true)
    assert.equal(s.cited, true)
    assert.deepEqual(s.unsupported, ['45 minutes'])
    assert.deepEqual(s.forbidden, [])
  })
})

describe('assertedPatterns — negation-aware "must not"', () => {
  const { assertedPatterns } = require('../src/renderer/src/lib/answerEval') as typeof import('../src/renderer/src/lib/answerEval')
  // The two replies below are verbatim from the 2026-08 run, where the naive
  // regex form scored both as failures. They are the reason this exists.
  const thaw =
    '**Safe ways to thaw frozen food:**\n\n1. **Refrigerator** — safest method.\n2. **Cold water** — faster.\n3. **Microwave** — fastest.\n\nNever thaw food on the counter or at room temperature.'
  const tornado =
    'Go to a public shelter if you can\'t stay at home. Stay away from windows, doors, and outside walls. Use your arms to protect your head and neck.'
  test('a warning against the thing is not an assertion of it', () => {
    assert.deepEqual(assertedPatterns(thaw, ['\\bcounter\\b', 'room temperature']), [])
    assert.deepEqual(assertedPatterns(tornado, ['\\bwindows?\\b']), [])
  })
  test('recommending it still fails', () => {
    assert.deepEqual(assertedPatterns('You can thaw it on the counter overnight.', ['\\bcounter\\b']), ['\\bcounter\\b'])
    assert.deepEqual(assertedPatterns('Open the windows and watch the storm.', ['\\bwindows?\\b']), ['\\bwindows?\\b'])
  })
  test('a corrected figure passes, a wrong one does not', () => {
    assert.deepEqual(assertedPatterns('Cook poultry to 165°F, not 145°F.', ['\\b(?:145|155|175)\\s*°?\\s*F\\b']), [])
    assert.deepEqual(assertedPatterns('Cook poultry to 145°F.', ['\\b(?:145|155|175)\\s*°?\\s*F\\b']), ['\\b(?:145|155|175)\\s*°?\\s*F\\b'])
  })
  test('negation in a neighbouring sentence does not excuse an assertion', () => {
    assert.deepEqual(
      assertedPatterns('Do not leave food out. Thaw it on the counter for a few hours.', ['\\bcounter\\b']),
      ['\\bcounter\\b']
    )
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
      const fx = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as { prompt?: string; mustInclude?: string[]; mustNotAssert?: string[]; mustNotInclude?: string[] }
      assert.equal(fx.mustNotInclude, undefined, `${f}: mustNotInclude was replaced by mustNotAssert`)
      assert.ok(fx.prompt && fx.prompt.length > 15, `${f}: prompt`)
      assert.ok(Array.isArray(fx.mustInclude) && fx.mustInclude.length > 0, `${f}: mustInclude`)
      for (const p of [...(fx.mustInclude ?? []), ...(fx.mustNotAssert ?? [])]) {
        assert.doesNotThrow(() => new RegExp(p, 'i'), `${f}: bad pattern ${p}`)
      }
    }
  })
})

describe('stabilityAcrossPasses (v1.7.1)', () => {
  const p = (file: string, pass: boolean | null): { file: string; pass: boolean | null } => ({ file, pass })

  test('classifies stable-pass, stable-fail and flaky; median over passes', () => {
    const report = stabilityAcrossPasses([
      [p('a', true), p('b', false), p('c', true), p('d', true)],
      [p('a', true), p('b', false), p('c', false), p('d', true)],
      [p('a', true), p('b', false), p('c', true), p('d', false)]
    ])
    assert.equal(report.of, 4)
    assert.equal(report.stablePass, 1) // a
    assert.equal(report.stableFail, 1) // b
    assert.deepEqual(report.flaky, ['c', 'd'])
    assert.deepEqual(report.perPass, [3, 2, 2])
    assert.equal(report.median, 2)
  })

  test('an even pass count takes the mean of the two middles', () => {
    const report = stabilityAcrossPasses([
      [p('a', true), p('b', true)],
      [p('a', true), p('b', false)],
      [p('a', false), p('b', false)],
      [p('a', true), p('b', true)]
    ])
    assert.deepEqual([...report.perPass].sort(), [0, 1, 2, 2].sort())
    assert.equal(report.median, 1.5)
  })

  test('null (errored) outcomes are no-data, not failures', () => {
    const report = stabilityAcrossPasses([
      [p('a', true), p('b', null)],
      [p('a', true), p('b', true)]
    ])
    assert.equal(report.stablePass, 2, 'b passed in every pass that has data')
    assert.deepEqual(report.flaky, [])
    // A case with no data in any pass is not classified at all.
    const empty = stabilityAcrossPasses([[p('x', null)], [p('x', null)]])
    assert.equal(empty.stablePass + empty.stableFail + empty.flaky.length, 0)
    assert.equal(empty.of, 1)
  })
})
