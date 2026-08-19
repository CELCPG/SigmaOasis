import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  stabilityAcrossPasses,
  codeReadsData,
  summarizeMultiTurn,
  summarizeLedger,
  summarizeProjectRecall,
  summarizeReasoning,
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

describe('multi-turn suite (v1.8)', () => {
  test('codeReadsData recognizes readers and data-path opens, not ordinary code', () => {
    assert.equal(codeReadsData('df = pd.read_csv("/work/sales.csv")'), true)
    assert.equal(codeReadsData('x = pd.read_excel("book.xlsx")'), true)
    assert.equal(codeReadsData('rows = list(csv.reader(open("/work/a.csv")))'), true)
    assert.equal(codeReadsData('west = df[df.region == "West"]\nprint(west.units.mean())'), false)
    assert.equal(codeReadsData('open("out.txt", "w").write("done")'), false)
  })

  test('summarizeMultiTurn splits first vs follow-up and counts re-reads per arm', () => {
    const t = (hit: boolean, reread: boolean, ms = 10_000, toolCalls = 1) => ({
      prompt: 'p', hit, missing: [], ms, toolCalls, reread
    })
    const s = summarizeMultiTurn([
      { file: 'a', session: [t(true, true), t(true, false), t(true, false)], stateless: [t(true, true), t(false, true), t(true, true)] },
      { file: 'b', session: [t(false, true), t(true, false), t(true, true)], stateless: [t(true, true), t(true, true), t(false, false)] }
    ])
    assert.deepEqual(s.session.first, { hit: 1, of: 2 })
    assert.deepEqual(s.session.followup, { hit: 4, of: 4 })
    assert.deepEqual(s.session.followupRereads, { hit: 1, of: 4 })
    assert.deepEqual(s.stateless.first, { hit: 2, of: 2 })
    assert.deepEqual(s.stateless.followup, { hit: 2, of: 4 })
    assert.deepEqual(s.stateless.followupRereads, { hit: 3, of: 4 })
  })

  test('errored turns are excluded from rates, not counted as misses', () => {
    const good = { prompt: 'p', hit: true, missing: [], ms: 1000, toolCalls: 1, reread: false }
    const bad = { ...good, hit: false, error: 'fetch failed' }
    const s = summarizeMultiTurn([{ file: 'a', session: [good, bad], stateless: [good, good] }])
    assert.deepEqual(s.session.followup, { hit: 0, of: 0 })
    assert.deepEqual(s.stateless.followup, { hit: 1, of: 1 })
  })

  test('the multiturn fixtures are well-formed with computable expectations', () => {
    const dir = join(__dirname, '..', '..', 'test', 'fixtures', 'multiturn')
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    assert.ok(files.length >= 5)
    for (const f of files) {
      const fx = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as {
        data?: string
        turns?: { prompt?: string; expect?: { label?: string; value?: number; tolerance?: number }[] }[]
      }
      assert.ok(typeof fx.data === 'string' && fx.data, `${f}: data file`)
      assert.ok(Array.isArray(fx.turns) && fx.turns.length >= 2, `${f}: at least two turns`)
      for (const t of fx.turns ?? []) {
        assert.ok(typeof t.prompt === 'string' && t.prompt, `${f}: prompt`)
        assert.ok(Array.isArray(t.expect) && t.expect.length > 0, `${f}: expectations`)
        for (const e of t.expect ?? []) assert.ok(typeof e.value === 'number' && Number.isFinite(e.value), `${f}: numeric value`)
      }
      // The referenced data file exists.
      assert.ok(readdirSync(join(dir, 'data')).includes(fx.data!), `${f}: ${fx.data} present`)
    }
  })
})

describe('ledger suite (v1.9)', () => {
  const t = (kind: 'establish' | 'filler' | 'recall', hit: boolean, error?: string) => ({
    prompt: 'p', kind, hit, missing: [], ms: 5000, ledgerInjected: kind === 'recall', ...(error ? { error } : {})
  })

  test('recall is judged only where the fact was established; filler never counts', () => {
    const s = summarizeLedger([
      { file: 'a', ledger: [t('establish', true), t('filler', false), t('recall', true), t('recall', true)], bare: [t('establish', true), t('filler', false), t('recall', false), t('recall', true)] },
      { file: 'b', ledger: [t('establish', false), t('filler', false), t('recall', true)], bare: [t('establish', true), t('filler', false), t('recall', false)] }
    ])
    assert.deepEqual(s.ledger.established, { hit: 1, of: 2 })
    assert.deepEqual(s.ledger.recall, { hit: 2, of: 2 }, "b's recall is not counted: nothing was established to recall")
    assert.deepEqual(s.bare.established, { hit: 2, of: 2 })
    assert.deepEqual(s.bare.recall, { hit: 1, of: 3 })
  })

  test('errored turns are excluded, not failed', () => {
    const s = summarizeLedger([{ file: 'a', ledger: [t('establish', true), t('recall', false, 'fetch failed'), t('recall', true)], bare: [t('establish', true), t('recall', true)] }])
    assert.deepEqual(s.ledger.recall, { hit: 1, of: 1 })
  })

  test('the ledger fixtures are well-formed: an establishing turn, filler, and recall turns', () => {
    const dir = join(__dirname, '..', '..', 'test', 'fixtures', 'ledger')
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    assert.ok(files.length >= 3)
    for (const f of files) {
      const fx = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as { data?: string; turns?: { recall?: boolean; filler?: boolean; expect?: unknown[] }[] }
      assert.ok(fx.data && readdirSync(join(dir, 'data')).includes(fx.data), `${f}: data present`)
      const turns = fx.turns ?? []
      assert.ok(turns.length >= 4, `${f}: enough turns to bury the fact`)
      assert.ok(!turns[0].recall && !turns[0].filler && (turns[0].expect?.length ?? 0) > 0, `${f}: turn 1 establishes`)
      assert.ok(turns.some((x) => x.filler), `${f}: has filler`)
      assert.ok(turns.some((x) => x.recall && ((x.expect?.length ?? 0) > 0 || ((x as { mustInclude?: string[] }).mustInclude?.length ?? 0) > 0)), `${f}: has a scored recall`)
    }
  })
})

describe('ledger suite · long regime (v1.9)', () => {
  const t = (kind: 'establish' | 'filler' | 'recall', hit: boolean, compacted = false) => ({
    prompt: 'p', kind, hit, missing: [], ms: 5000, ledgerInjected: kind === 'recall', compacted
  })
  test('summary splits short and long regimes; long is where the arms may differ', () => {
    const s = summarizeLedger([
      { file: 'short', regime: 'short', ledger: [t('establish', true), t('recall', true)], bare: [t('establish', true), t('recall', true)] },
      { file: 'long', regime: 'long', ledger: [t('establish', true), t('recall', true, true)], bare: [t('establish', true), t('recall', false, true)] }
    ])
    assert.equal(s.long.cases, 1)
    assert.equal(s.short.cases, 1)
    assert.deepEqual(s.long.ledger.recall, { hit: 1, of: 1 })
    assert.deepEqual(s.long.bare.recall, { hit: 0, of: 1 })
    assert.deepEqual(s.short.bare.recall, { hit: 1, of: 1 })
    assert.deepEqual(s.ledger.recall, { hit: 2, of: 2 })
  })
  test('the long fixtures mark their recall turns compact and declare the regime', () => {
    const dir = join(__dirname, '..', '..', 'test', 'fixtures', 'ledger')
    const longs = readdirSync(dir).filter((f) => f.endsWith('-long.json'))
    assert.ok(longs.length >= 3)
    for (const f of longs) {
      const fx = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as { regime?: string; turns?: { recall?: boolean; compact?: boolean; filler?: boolean }[] }
      assert.equal(fx.regime, 'long', `${f}: regime`)
      const turns = fx.turns ?? []
      assert.ok(turns.filter((x) => x.filler).length >= 5, `${f}: enough filler to bury the fact`)
      for (const x of turns) if (x.recall) assert.equal(x.compact, true, `${f}: recall turns compact`)
    }
  })
})

describe('research fixtures (v1.9)', () => {
  test('cases are well-formed and every decoy regex misses the corpus facts it sits beside', () => {
    const dir = join(__dirname, '..', '..', 'test', 'fixtures', 'research')
    const corpusOf = (sub: string): string =>
      readdirSync(join(dir, sub)).filter((f) => f.endsWith('.html'))
        .map((f) => readFileSync(join(dir, sub, f), 'utf-8').replace(/<[^>]+>/g, ' ')).join('\n')
    const corpora = { clean: corpusOf('corpus'), thin: corpusOf('corpus-thin') }
    const files = readdirSync(join(dir, 'cases')).filter((f) => f.endsWith('.json'))
    assert.ok(files.length >= 4)
    for (const f of files) {
      const fx = JSON.parse(readFileSync(join(dir, 'cases', f), 'utf-8')) as { question?: string; corpus?: 'clean' | 'thin'; mustInclude?: string[]; decoys?: string[] }
      assert.ok(fx.question && (fx.mustInclude?.length ?? 0) > 0, `${f}: question + facts`)
      const corpus = corpora[fx.corpus ?? 'clean']
      // Every required fact must actually be findable in the case's own corpus,
      // or the case is unanswerable and measures nothing.
      for (const m of fx.mustInclude ?? []) {
        assert.ok(new RegExp(m, 'i').test(corpus), `${f}: mustInclude /${m}/ is not in its corpus`)
      }
      // A decoy is a figure the corpus does NOT contain. If a decoy regex
      // matches the corpus itself, it will flag a *correct* brief — the "5
      // minutes" matching "3.5 minutes" lesson.
      for (const d of fx.decoys ?? []) {
        assert.ok(!new RegExp(d, 'i').test(corpus), `${f}: decoy /${d}/ matches the corpus — it would flag a correct brief`)
      }
    }
  })
})

describe('reasoning suite (v1.9.1)', () => {
  const turn = (correct: boolean, empty = false) => ({ correct, missing: [], asserted: [], empty, ms: 20_000 })
  const c = (file: string, draft: boolean, final: boolean, extra: Record<string, unknown> = {}) => ({
    file, kind: 'k', draft: turn(draft), final: turn(final), reviewFoundProblems: draft !== final, revised: draft !== final, reviewMs: 30_000, ...extra
  })

  test('fixed and broke are directed counts over the right denominators', () => {
    const s = summarizeReasoning([
      c('a', false, true),   // fixed
      c('b', true, false),   // broke
      c('c', true, true),    // held
      c('d', false, false)   // still wrong
    ])
    assert.deepEqual(s.draftCorrect, { hit: 2, of: 4 })
    assert.deepEqual(s.finalCorrect, { hit: 2, of: 4 })
    assert.deepEqual(s.fixed, { hit: 1, of: 2 }, 'fixed is over wrong drafts, not all cases')
    assert.deepEqual(s.broke, { hit: 1, of: 2 }, 'broke is over right drafts')
  })

  test('errored cases are excluded and an empty reply never counts as a fix', () => {
    const s = summarizeReasoning([
      { ...c('a', false, false), error: 'fetch failed' },
      { file: 'b', kind: 'k', draft: turn(false), final: turn(true, true), reviewFoundProblems: true, revised: true, reviewMs: 1 }
    ])
    assert.deepEqual(s.draftCorrect, { hit: 0, of: 1 })
    assert.deepEqual(s.fixed, { hit: 0, of: 0 }, 'a case with an empty reply is not evidence either way')
  })

  test('the cost multiplier is derivable from the reported seconds', () => {
    const s = summarizeReasoning([c('a', true, true)])
    assert.equal(s.secondsDraft, 20)
    assert.equal(s.secondsReview, 30)
  })

  test('every reasoning fixture is self-consistent against its own canonical answer', () => {
    const dir = join(__dirname, '..', '..', 'test', 'fixtures', 'reasoning')
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    assert.ok(files.length >= 8)
    for (const f of files) {
      const fx = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as {
        kind?: string; prompt?: string; canonical?: string; answer?: string[]; distractors?: string[]
      }
      assert.ok(fx.kind && fx.prompt && fx.canonical, `${f}: kind, prompt, canonical`)
      assert.ok((fx.answer?.length ?? 0) > 0, `${f}: answer patterns`)
      assert.match(fx.prompt!, /ANSWER:/, `${f}: the prompt must fix the answer format`)
      // The discipline that would have caught the "5 minutes" bug at write time:
      // every answer pattern matches the canonical line, no distractor does.
      for (const a of fx.answer!) {
        assert.ok(new RegExp(a, 'i').test(fx.canonical!), `${f}: answer /${a}/ does not match its canonical ${fx.canonical}`)
      }
      for (const d of fx.distractors ?? []) {
        assert.ok(!new RegExp(d, 'i').test(fx.canonical!), `${f}: distractor /${d}/ matches the CORRECT answer`)
      }
    }
  })
})

describe('project-wide recall suite (v1.11)', () => {
  const q = (
    kind: 'recall' | 'control',
    hit: boolean,
    extra: Partial<{ injected: boolean; decoysStated: string[]; error: string; mode: 'hybrid' | 'keyword' }> = {}
  ) => ({
    prompt: 'p',
    kind,
    hit,
    missing: [],
    ms: 4000,
    injected: extra.injected ?? false,
    from: [],
    decoysStated: extra.decoysStated ?? [],
    ...(extra.error ? { error: extra.error } : {}),
    ...(extra.mode ? { mode: extra.mode } : {})
  })

  test('recall and control questions are counted separately in each arm', () => {
    const s = summarizeProjectRecall([
      {
        file: 'a',
        project: 'P',
        recall: [q('recall', true, { injected: true }), q('recall', true, { injected: true }), q('control', true)],
        bare: [q('recall', false), q('recall', true), q('control', true)]
      }
    ])
    assert.deepEqual(s.recall.recallAnswered, { hit: 2, of: 2 })
    assert.deepEqual(s.bare.recallAnswered, { hit: 1, of: 2 })
    assert.deepEqual(s.recall.controlAnswered, { hit: 1, of: 1 })
  })

  test('a control reply that states a project term counts as pulled off topic', () => {
    const s = summarizeProjectRecall([
      {
        file: 'a',
        project: 'P',
        recall: [q('control', true, { decoysStated: ['acme'] }), q('control', true)],
        bare: [q('control', true), q('control', true)]
      }
    ])
    assert.deepEqual(s.recall.controlDistracted, { hit: 1, of: 2 })
    assert.deepEqual(s.bare.controlDistracted, { hit: 0, of: 2 })
  })

  test('retrieval is judged on its own: fired where it should, quiet where it should', () => {
    const s = summarizeProjectRecall([
      {
        file: 'a',
        project: 'P',
        recall: [
          q('recall', true, { injected: true, mode: 'hybrid' }),
          q('recall', false, { injected: false, mode: 'hybrid' }),
          q('control', true, { injected: false, mode: 'hybrid' }),
          q('control', true, { injected: true, mode: 'hybrid' })
        ],
        bare: []
      }
    ])
    assert.deepEqual(s.retrieval.firedOnRecall, { hit: 1, of: 2 })
    assert.deepEqual(s.retrieval.quietOnControl, { hit: 1, of: 2 })
    assert.equal(s.retrieval.mode, 'hybrid')
  })

  test('errored questions are excluded, not failed', () => {
    const s = summarizeProjectRecall([
      { file: 'a', project: 'P', recall: [q('recall', false, { error: 'fetch failed' }), q('recall', true, { injected: true })], bare: [] }
    ])
    assert.deepEqual(s.recall.recallAnswered, { hit: 1, of: 1 })
  })

  test('the project fixtures are well-formed: sibling chats, recall and control questions', () => {
    const dir = join(__dirname, '..', '..', 'test', 'fixtures', 'projects')
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    assert.ok(files.length >= 3)
    for (const f of files) {
      const fx = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as {
        project?: string
        siblings?: { title?: string; turns?: [string, string][] }[]
        questions?: { kind?: string; expect?: unknown[]; mustInclude?: string[]; decoys?: string[]; prompt?: string }[]
      }
      assert.ok(fx.project, `${f}: needs a project name`)
      assert.ok((fx.siblings ?? []).length >= 2, `${f}: needs at least two sibling chats`)
      for (const sib of fx.siblings ?? []) {
        assert.ok(sib.title, `${f}: every sibling chat needs a title — it is the citation`)
        assert.ok((sib.turns ?? []).length >= 1, `${f}: sibling "${sib.title}" has no turns`)
      }
      const qs = fx.questions ?? []
      assert.ok(qs.some((x) => x.kind === 'recall'), `${f}: needs recall questions`)
      assert.ok(qs.some((x) => x.kind === 'control'), `${f}: needs control questions — harm is the half that matters`)
      for (const x of qs) {
        // Unscoreable questions pass by default in a naive runner; the runner
        // refuses them, and so does this.
        assert.ok(
          (x.expect ?? []).length > 0 || (x.mustInclude ?? []).length > 0,
          `${f}: question "${x.prompt}" has no expectation and could never be scored`
        )
        if (x.kind === 'control') {
          assert.ok((x.decoys ?? []).length > 0, `${f}: control "${x.prompt}" needs decoys to detect distraction`)
          // A decoy that matches the correct answer would report distraction
          // for a right answer.
          for (const d of x.decoys ?? []) {
            for (const m of x.mustInclude ?? []) {
              assert.ok(!m.toLowerCase().includes(d.toLowerCase()), `${f}: decoy "${d}" overlaps required string "${m}"`)
            }
          }
        }
      }
    }
  })
})
