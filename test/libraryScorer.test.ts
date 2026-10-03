import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  LIBRARY_SCORER_RULE,
  assertedPatterns,
  measurementsIn,
  normalizeReply,
  readReply,
  scoreLibrary,
  stabilityAcrossPasses,
  summarizeLibrary,
  type LibraryCaseResult
} from '../src/renderer/src/lib/answerEval'
import { rescoreLibraryFile, type LibraryFixtureLike } from '../src/main/agent/evalLibraryRescore'
import { detectSuite, diffResults, formatDiff, libraryScorerRuleOf, mergeResults, trimForBaseline } from '../src/main/agent/evalDiff'

/**
 * The library scorer reads the reply as plain text (v4.6, J3).
 *
 * 4.5's H5 found the sample answer's four replies to `14-estimated-payments`
 * writing "June 15" with a narrow no-break space (U+202F) where the case's
 * pattern has an ASCII space: the fact counted as missing, and the artifact
 * decided a verdict. The scorer now normalises Unicode spaces — and the dashes
 * and quotes a model writes the same way — once, before any pattern or cue
 * reads the reply, and says which version it is (`LIBRARY_SCORER_RULE`).
 */

const SPACES = ['\u00a0', '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007', '\u2008', '\u2009', '\u200a', '\u202f', '\u205f', '\u3000']
const score = (reply: string, mustInclude: string[], mustNotAssert: string[] = []): ReturnType<typeof scoreLibrary> => scoreLibrary(reply, { mustInclude, mustNotAssert, passages: '', titles: [] })

describe('normalizeReply', () => {
  test('every Unicode space separator reads as a plain space, and nothing else changes', () => {
    for (const c of SPACES) assert.equal(normalizeReply(`June${c}15`), 'June 15', `U+${c.codePointAt(0)!.toString(16)}`)
    const plain = 'Cool it for 15 minutes — not ice.\n\n- 165 °F (74 °C)\ttab, \u201cthe em dash\u201d stays'
    assert.equal(normalizeReply('Cool it for 15 minutes — not ice.\n\n- 165\u00a0°F (74\u202f°C)\ttab, \u201cthe em dash\u201d stays'), plain.replace('\u201c', '"').replace('\u201d', '"'))
  })
  test('hyphen-like dashes and the minus sign read as "-"; the em dash is punctuation and stays', () => {
    assert.equal(normalizeReply('10\u201315, 10\u201015, 10\u201115, 10\u201215, \u22125'), '10-15, 10-15, 10-15, 10-15, -5')
    assert.equal(normalizeReply('wait—then go, ―'), 'wait—then go, ―')
  })
  test('curly quotes and apostrophes read as straight ones', () => {
    assert.equal(normalizeReply('don\u2019t, \u2018this\u2019, \u201cthat\u201d'), 'don\'t, \'this\', "that"')
  })
  test('a plain reply is unchanged, and it is idempotent', () => {
    const t = 'Hold under cool running water for 15\u201330 minutes.'
    assert.equal(normalizeReply(normalizeReply(t)), normalizeReply(t))
    assert.equal(normalizeReply('plain text, 1,249.99 and $5'), 'plain text, 1,249.99 and $5')
  })
})

describe('the case\'s patterns against a reply a model wrote with Unicode characters', () => {
  test('the sample answer\'s "June 15": the case\'s pattern has an ASCII space', () => {
    // the artifact: read as written, a reply that carries only the date has the fact missing
    assert.equal(new RegExp('June 15|September 15', 'i').test('Due June\u202f15.'), false)
    assert.equal(score('Due June\u202f15.', ['June 15|September 15']).answered, true)
    assert.deepEqual(score('Due June\u202f15.', ['June 15|September 15']).missing, [])
  })
  test('every space separator in the list, in a pattern that needs a plain space', () => {
    for (const c of SPACES) assert.equal(score(`It is due June${c}15.`, ['June 15']).answered, true, `U+${c.codePointAt(0)!.toString(16)}`)
  })
  test('a range written with an en dash, a non-breaking hyphen or a minus sign meets a pattern with "-"', () => {
    for (const d of ['\u2013', '\u2011', '\u2010', '\u2212']) assert.equal(score(`Cool it for 10${d}15 minutes.`, ['10-15 minutes']).answered, true, `U+${d.codePointAt(0)!.toString(16)}`)
    assert.equal(score('Cool it for 10—15 minutes.', ['10-15 minutes']).answered, false) // an em dash is not a hyphen
  })
  test('a curly apostrophe no longer hides a negation: "don\u2019t use ice" is not an assertion of ice', () => {
    const reply = 'Cool the burn with water. Don\u2019t use ice or butter.'
    assert.deepEqual(assertedPatterns(reply, ['\\bice\\b', '\\bbutter\\b']), ['\\bice\\b', '\\bbutter\\b']) // as written: the cue "don't" is not seen
    assert.deepEqual(score(reply, ['water'], ['\\bice\\b', '\\bbutter\\b']).forbidden, [])
    // …and recommending it still fails
    assert.deepEqual(score('Put ice on it.', ['ice'], ['\\bice\\b']).forbidden, ['\\bice\\b'])
  })
  test('the other flags do not move on the characters: a measurement is read the same either way', () => {
    const reply = 'Cool it for 45\u202fminutes under water at 20\u00a0°C.'
    assert.deepEqual(measurementsIn(reply).map((m) => [m.value, m.unit]), measurementsIn(normalizeReply(reply)).map((m) => [m.value, m.unit]))
    const s = scoreLibrary(reply, { mustInclude: [], passages: 'Hold under cool water for 15 to 30 minutes.', titles: [] })
    assert.deepEqual(s.unsupported, ['45 minutes', '20 °C'])
  })
  test('readReply is the one place `answered` and `forbidden` are read', () => {
    assert.deepEqual(readReply('Due June\u202f15.', { mustInclude: ['June 15'], mustNotAssert: ['\\bice\\b'] }), { missing: [], forbidden: [] })
  })
})

test('the scorer has a version a results file can carry', () => {
  assert.equal(LIBRARY_SCORER_RULE, 2)
})

// ---- moving a recorded file to the scorer -----------------------------------------

const FIXTURES: Record<string, LibraryFixtureLike> = {
  '14-estimated-payments.json': { mustInclude: ['June 15|September 15'] },
  '01-burn-cooling.json': { mustInclude: ['cool'], mustNotAssert: ['\\bice\\b'] },
  '02-nosebleed.json': { mustInclude: ['lean forward'] }
}
const fixtureOf = (r: LibraryCaseResult): LibraryFixtureLike | undefined => FIXTURES[r.file]
const lrun = (file: string, reply: string, o: { answered: boolean; missing?: string[]; forbidden?: string[]; kind?: string; error?: string }): LibraryCaseResult => ({
  file,
  prompt: file,
  ...(o.kind ? { kind: o.kind } : {}),
  passagesFound: 3,
  ms: 2000,
  reply,
  ...(o.error ? { error: o.error } : { score: { answered: o.answered, missing: o.missing ?? [], cited: true, unsupported: [], forbidden: o.forbidden ?? [] } })
})
const passRuns = (): LibraryCaseResult[][] => [
  [
    // the artifact: stored missing, now found
    lrun('14-estimated-payments.json', 'It is due June\u202f15.', { answered: false, missing: ['June 15|September 15'], kind: 'near-tie' }),
    // an older scorer: stored as asserting ice, today's reads the negation
    lrun('01-burn-cooling.json', 'Cool it. Never put ice on a burn.', { answered: true, forbidden: ['\\bice\\b'] }),
    // a reply that really is missing the fact: stays
    lrun('02-nosebleed.json', 'Pinch your nose firmly.', { answered: false, missing: ['lean forward'] }),
    lrun('99-gone.json', 'x', { answered: true }),
    lrun('03-x.json', '', { answered: true, error: 'HTTP 500' })
  ],
  [lrun('14-estimated-payments.json', 'It is due September\u202f15.', { answered: false, missing: ['June 15|September 15'], kind: 'near-tie' })]
]
const multiPass = (): Record<string, unknown> => {
  const ps = passRuns()
  return {
    model: 'm',
    ranAt: 'now',
    session: { id: 's', role: 'arm' },
    librarySuite: 'library-aids',
    library: {
      passes: ps.map((runs) => ({ summary: summarizeLibrary(runs), runs })),
      stability: stabilityAcrossPasses(ps.map((runs) => runs.map((r) => ({ file: r.file, pass: r.error ? null : (r.score?.answered ?? false) })))),
      shapes: { calledTheTool: 0, echoedTheHeader: 0, cutOffByTheCap: 3, stoppedShort: 0 }
    },
    quant: { kept: true }
  }
}

describe('rescoreLibraryFile', () => {
  test('the flags that move are told apart by what moved them, and the others are left alone', () => {
    const r = rescoreLibraryFile(multiPass(), fixtureOf)
    assert.deepEqual(
      r.changes.map((c) => `${c.pass} ${c.case} ${c.field} ${c.was}→${c.now} ${c.because}`),
      [
        '1 14-estimated-payments.json answered false→true normalisation',
        '1 01-burn-cooling.json forbidden true→false older scorer',
        '2 14-estimated-payments.json answered false→true normalisation'
      ]
    )
    assert.equal(r.read, 4)
    assert.deepEqual(r.left, { errored: 1, noReply: 0, noFixture: ['99-gone.json'] })
    assert.equal(r.measurementsMoved, 0)
    const runs = (r.file.library as { passes: { runs: LibraryCaseResult[] }[] }).passes
    // the case that stays missing keeps its pattern in `missing`; one that moves is cleared
    assert.deepEqual(runs[0]!.runs.map((x) => x.score?.answered), [true, true, false, true, undefined])
    assert.deepEqual(runs[0]!.runs[0]!.score!.missing, [])
    assert.deepEqual(runs[0]!.runs[1]!.score!.forbidden, [])
    // what is not re-read is stored as it was, and a run no fixture covers keeps its score
    assert.equal(runs[0]!.runs[0]!.score!.cited, true)
    assert.equal(runs[0]!.runs[3]!.score!.answered, true)
  })
  test('the file is stamped, its summaries are recomputed by the functions that wrote them, and every key keeps its place', () => {
    const before = multiPass()
    const r = rescoreLibraryFile(before, fixtureOf)
    assert.deepEqual(Object.keys(r.file), ['model', 'ranAt', 'session', 'librarySuite', 'libraryScorerRule', 'library', 'quant'])
    assert.equal(r.file.libraryScorerRule, LIBRARY_SCORER_RULE)
    const lib = r.file.library as { passes: { summary: ReturnType<typeof summarizeLibrary>; runs: LibraryCaseResult[] }[]; stability: ReturnType<typeof stabilityAcrossPasses>; shapes: Record<string, number> }
    assert.deepEqual(Object.keys(lib), ['passes', 'stability', 'shapes'])
    assert.deepEqual(lib.passes[0]!.summary, summarizeLibrary(lib.passes[0]!.runs))
    assert.equal(lib.passes[0]!.summary.answered.hit, 3)
    assert.equal(lib.passes[0]!.summary.forbidden.hit, 0)
    assert.deepEqual(lib.stability.perPass, [3, 1])
    assert.deepEqual(r.file.quant, { kept: true })
    // the input is not changed
    assert.equal(((before.library as { passes: { runs: LibraryCaseResult[] }[] }).passes[0]!.runs[0]!.score!.answered), false)
    assert.equal(libraryScorerRuleOf(before), 1)
    assert.equal(libraryScorerRuleOf(r.file), LIBRARY_SCORER_RULE)
  })
  test('a single-pass file (library.runs) and a second rescore: nothing moves the second time', () => {
    const single = { model: 'm', library: { summary: summarizeLibrary(passRuns()[0]!), runs: passRuns()[0]! } }
    const once = rescoreLibraryFile(single, fixtureOf)
    assert.equal((once.file.library as { summary: ReturnType<typeof summarizeLibrary> }).summary.answered.hit, 3)
    const twice = rescoreLibraryFile(once.file, fixtureOf)
    assert.deepEqual(twice.changes, [])
    assert.equal(twice.summariesExact, true)
    assert.deepEqual(twice.file, once.file)
  })
  test('a control file that holds library-aids runs and does not say so is stamped with its suite', () => {
    const { librarySuite: _s, ...control } = multiPass()
    const r = rescoreLibraryFile(control, fixtureOf)
    assert.equal(r.suiteStamped, true)
    assert.deepEqual(Object.keys(r.file), ['model', 'ranAt', 'session', 'librarySuite', 'libraryScorerRule', 'library', 'quant'])
    assert.equal(r.file.librarySuite, 'library-aids')
    // one that says already, and one with no kind in it (the 28-question suite), are not touched
    assert.equal(rescoreLibraryFile(multiPass(), fixtureOf).suiteStamped, false)
    const plain = { model: 'm', library: { runs: [lrun('01-burn-cooling.json', 'Cool it.', { answered: true })] } }
    const p = rescoreLibraryFile(plain, fixtureOf)
    assert.equal(p.suiteStamped, false)
    assert.equal('librarySuite' in p.file, false)
  })
  test('a committed baseline keeps each reply cut: it cannot be re-scored from them', () => {
    const saved = trimForBaseline(mergeResults([multiPass(), multiPass()]), ['a', 'b'], new Date('2026-10-03T00:00:00Z'))
    assert.equal(detectSuite(saved), 'library')
    assert.throws(() => rescoreLibraryFile(saved, fixtureOf), /cut to 300 characters/)
  })
  test('an agent file is not a library file', () => {
    assert.throws(() => rescoreLibraryFile({ suite: 'agent', runs: [[]] }, fixtureOf), /library block/)
  })
})

// ---- one library scorer on both sides ------------------------------------------------------

describe('eval:diff refuses two library files scored by different library scorers', () => {
  const lib = (file: string, answered: boolean): LibraryCaseResult => ({ file, prompt: file, passagesFound: 3, ms: 1000, score: { answered, missing: [], cited: answered, unsupported: [], forbidden: [] } })
  const pass = (n: number, answered: number): LibraryCaseResult[] => Array.from({ length: n }, (_, i) => lib(`L${i}`, i < answered))
  const file = (ps: LibraryCaseResult[][], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    model: 'm',
    ranAt: 'now',
    cases: 'all',
    ...extra,
    library: { passes: ps.map((runs) => ({ summary: {}, runs })) }
  })
  const four = (): LibraryCaseResult[][] => [pass(28, 27), pass(28, 26), pass(28, 27), pass(28, 27)]
  const stamped = (extra: Record<string, unknown> = {}): Record<string, unknown> => file(four(), { libraryScorerRule: LIBRARY_SCORER_RULE, ...extra })

  test('a file that says nothing was scored by rule 1', () => {
    assert.equal(libraryScorerRuleOf(file(four())), 1)
    assert.equal(libraryScorerRuleOf(stamped()), LIBRARY_SCORER_RULE)
  })
  test('a diff across scorers is refused, in words that say what to do', () => {
    assert.throws(() => diffResults(file(four()), stamped()), /the baseline was scored under library scorer rule 1 and the run under rule 2.*Unicode spaces.*eval:library-rescore.*--write/s)
    assert.throws(() => diffResults(stamped(), file(four())), /the baseline was scored under library scorer rule 2 and the run under rule 1/)
  })
  test('two sides scored by the same scorer compare, and the table says which', () => {
    const same = diffResults(stamped(), stamped())
    assert.equal(same.libraryRule, LIBRARY_SCORER_RULE)
    assert.match(formatDiff(same), new RegExp('^library suite library · library scorer rule ' + LIBRARY_SCORER_RULE + ': answered and forbidden read by it on both sides$', 'm'))
    // two files from before the stamp were scored by the same (first) scorer
    assert.equal(diffResults(file(four()), file(four())).libraryRule, 1)
  })
  test('a merge of files scored by different scorers is refused, and a merge keeps the stamp', () => {
    assert.throws(() => mergeResults([stamped(), file(four())], ['a.json', 'b.json']), /a\.json was scored under library scorer rule 2 and b\.json under rule 1/)
    assert.equal(mergeResults([stamped(), stamped()]).libraryScorerRule, LIBRARY_SCORER_RULE)
  })
  test('a saved baseline keeps the scorer it was scored by', () => {
    assert.equal(trimForBaseline(stamped(), 'x', new Date('2026-10-03T00:00:00Z')).libraryScorerRule, LIBRARY_SCORER_RULE)
    assert.equal(trimForBaseline(file(four()), 'x', new Date('2026-10-03T00:00:00Z')).libraryScorerRule, undefined)
  })
})
