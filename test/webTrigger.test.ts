import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  looksFactual,
  looksFactualByRules,
  looksLive,
  looksLiveByRules,
  webToolsForTurn,
  webToolsForTurnByRules
} from '../src/renderer/src/lib/grounding'
import { classifyWebNeed, modelSaysLive, WEB_TRIGGER_THRESHOLDS } from '../src/renderer/src/lib/webTrigger'
import { FEATURE_BITS, WEB_NEED_LABELS, isHeldOut, labelledDigest, parseLabelled, type WebTriggerModelFile } from '../src/renderer/src/lib/webTriggerFeatures'

/**
 * v4.2 (C1–C4): the measured web trigger.
 *
 * Through 4.1 whether a turn reached the web was decided by word lists that
 * grew one miss at a time. 4.2 adds a classifier trained on labelled prompts
 * and keeps the lists as overrides. This file holds the three things that make
 * that a measurement rather than a claim: the labelled set and its fixed
 * held-out split, a model that is provably the one the set trains, and the
 * held-out numbers for the rules alone beside the rules with the classifier —
 * printed on every run and recorded in docs/web-trigger.md.
 */

const REPO = join(__dirname, '..', '..')
const LABELLED_PATH = join(REPO, 'test', 'fixtures', 'webTrigger', 'labelled.jsonl')
const MODEL_PATH = join(REPO, 'src', 'renderer', 'src', 'lib', 'webTrigger.model.json')
const LABELLED_TEXT = readFileSync(LABELLED_PATH, 'utf8')
const ROWS = parseLabelled(LABELLED_TEXT)
const HELD_OUT = ROWS.filter((r) => r.split === 'test')

/**
 * The ceilings the combined system must stay under on the held-out split. A
 * false alarm is a web search the user waits for, and a query leaving the
 * machine, for a chat turn that needed neither. The rules alone flag 10.8% of
 * the held-out chat turns (docs/web-trigger.md) — "how does a stock market
 * work", "what should i name my variable that stores the last score" — and as
 * overrides they still force, so the ceiling sits above theirs: 18% in all,
 * and no more than 6 points added by the classifier (it measures 3.2). The
 * trainer aims its thresholds at 5% added, on cross-validation.
 */
const WEB_FALSE_ALARM_CEILING = 0.18
const WEB_FALSE_ALARM_ADDED_CEILING = 0.06
/** Of everything not live, how much reads as live: the rules measure 1.3%, the two together 1.9%. */
const LIVE_FALSE_ALARM_CEILING = 0.05

describe('the labelled set (C1)', () => {
  test('about four hundred prompts or more, each with a valid label and a unique id', () => {
    assert.ok(ROWS.length >= 400, `${ROWS.length} rows`)
    assert.equal(new Set(ROWS.map((r) => r.id)).size, ROWS.length)
    for (const r of ROWS) {
      assert.ok(WEB_NEED_LABELS.includes(r.label), `${r.id}: ${r.label}`)
      assert.ok(r.text.trim().length > 0, r.id)
    }
    assert.equal(new Set(ROWS.map((r) => r.text)).size, ROWS.length, 'a prompt appears twice')
  })

  test('the held-out split is fixed by id, about a quarter, and holds every label', () => {
    for (const r of ROWS) {
      const want = isHeldOut(r.id) ? 'test' : 'train'
      assert.equal(r.split, want, `${r.id} should be "${want}" (isHeldOut in lib/webTriggerFeatures.ts decides)`)
    }
    const share = HELD_OUT.length / ROWS.length
    assert.ok(share > 0.2 && share < 0.3, `held-out share ${share}`)
    for (const label of WEB_NEED_LABELS) assert.ok(HELD_OUT.filter((r) => r.label === label).length >= 25, label)
  })

  test('it carries the 4.0.1 session and the hard negatives its fix was written around', () => {
    const labelOf = (text: string): string | undefined => ROWS.find((r) => r.text === text)?.label
    assert.equal(labelOf('can you check the weather for righmond va today'), 'live')
    assert.equal(labelOf('how are s&p futures looking  for today'), 'live')
    assert.equal(labelOf('when is the next miami heat basketball game?'), 'live')
    assert.equal(labelOf('how do futures work in rust'), 'none')
    assert.equal(labelOf('what should i add to my next game'), 'none')
    assert.equal(labelOf('we need to weather the storm at work, any tips for keeping morale up'), 'none')
    assert.equal(labelOf('write a poem about rain'), 'none')
    assert.equal(labelOf('how does a stock market work'), 'none')
  })
})

describe('the model (C2)', () => {
  const model = JSON.parse(readFileSync(MODEL_PATH, 'utf8')) as WebTriggerModelFile

  test('is the one the labelled set trains — edit the set, run scripts/train-web-trigger.sh', () => {
    assert.equal(model.trainedOn, labelledDigest(LABELLED_TEXT))
    assert.equal(model.trainExamples, ROWS.filter((r) => r.split === 'train').length)
    assert.equal(model.featureBits, FEATURE_BITS)
    assert.deepEqual(model.labels, [...WEB_NEED_LABELS])
    assert.equal(model.weights.length, model.index.length * model.labels.length)
  })

  test('stays small enough to ship in the renderer bundle', () => {
    assert.ok(statSync(MODEL_PATH).size < 300 * 1024, `${statSync(MODEL_PATH).size} bytes`)
  })

  test('answers with a label and its probability, the same way every time', () => {
    for (const r of ROWS.slice(0, 40)) {
      const a = classifyWebNeed(r.text)
      const b = classifyWebNeed(`${r.text} `)
      assert.ok(WEB_NEED_LABELS.includes(a.label))
      assert.ok(a.p > 0 && a.p <= 1)
      assert.equal(a.p, a.probs[a.label])
      assert.ok(Math.abs(a.probs.none + a.probs.web + a.probs.live - 1) < 1e-9)
      // A trailing space adds no n-gram: the reading does not depend on the cache.
      assert.deepEqual(b, a)
    }
  })

  test('well under a millisecond a message', () => {
    const texts = ROWS.map((r) => r.text)
    classifyWebNeed('warm up the tables')
    const started = process.hrtime.bigint()
    // Each text differs from the one before, so the one-entry cache never answers.
    for (let i = 0; i < 4; i++) for (const t of texts) classifyWebNeed(`${t}${' x'.repeat(i)}`)
    const perCallMs = Number(process.hrtime.bigint() - started) / 1e6 / (texts.length * 4)
    console.log(`classifyWebNeed: ${(perCallMs * 1000).toFixed(1)} µs per message`)
    assert.ok(perCallMs < 1, `${perCallMs} ms per call`)
  })

  test('thresholds come from the model file', () => {
    assert.deepEqual(WEB_TRIGGER_THRESHOLDS, model.thresholds)
    assert.ok(model.thresholds.live > 0.3 && model.thresholds.live < 1)
    assert.ok(model.thresholds.web > 0.3 && model.thresholds.web < 1)
  })
})

describe('the rules stay overrides (C3)', () => {
  const WEB = ['web_search', 'fetch_webpage']

  test('a rule hit still forces, whatever the classifier reads', () => {
    // "futures market" is on the live list; the set labels this a concept question.
    assert.equal(classifyWebNeed('explain how a futures market works').label, 'none')
    assert.deepEqual(webToolsForTurn('explain how a futures market works'), WEB)
    assert.equal(looksLive('explain how a futures market works'), true)
  })

  test('creative and coding intent still vetoes', () => {
    // The classifier alone reads this one as live; the rule's veto wins.
    const song = 'compose a song about the score of the lakers game last night'
    assert.equal(modelSaysLive(song), true)
    assert.equal(looksLive(song), false)
    for (const text of [song, 'write a story about the next big game between two rival schools', 'write a poem about how humid it is in miami today', 'fix this bug in my weather api function']) {
      assert.deepEqual(webToolsForTurn(text), [], text)
      assert.equal(looksFactual(text), false, text)
    }
  })

  test('an ask for the web by name carries the tools but is not searched as a subject', () => {
    assert.deepEqual(webToolsForTurn('can you try with duck duck go now?'), WEB)
    assert.equal(looksFactual('can you try with duck duck go now?'), false)
  })

  test('a reference question the rules leave to the library stays the library\'s', () => {
    // The factual reading defers to the packs, as the rules' factual path does.
    assert.deepEqual(webToolsForTurn('what is the standard deduction'), [])
    assert.deepEqual(webToolsForTurn('how long do leftovers last in the fridge'), [])
  })
})

interface Rates {
  precision: number
  recall: number
  falseAlarm: number
  tp: number
  fp: number
  fn: number
  neg: number
}

function rates(rows: { positive: boolean; flagged: boolean }[]): Rates {
  const tp = rows.filter((r) => r.positive && r.flagged).length
  const fp = rows.filter((r) => !r.positive && r.flagged).length
  const fn = rows.filter((r) => r.positive && !r.flagged).length
  const neg = rows.filter((r) => !r.positive).length
  return { precision: tp / Math.max(1, tp + fp), recall: tp / Math.max(1, tp + fn), falseAlarm: fp / Math.max(1, neg), tp, fp, fn, neg }
}

/** The app reaches for the web on a turn when it searches itself or puts the web tools on the wire. */
const reachesWeb = (t: string): boolean => looksFactual(t) || webToolsForTurn(t).length > 0
const reachesWebByRules = (t: string): boolean => looksFactualByRules(t) || webToolsForTurnByRules(t).length > 0

describe('measured on the held-out split (C4)', () => {
  const liveRules = rates(HELD_OUT.map((r) => ({ positive: r.label === 'live', flagged: looksLiveByRules(r.text) })))
  const liveBoth = rates(HELD_OUT.map((r) => ({ positive: r.label === 'live', flagged: looksLive(r.text) })))
  const webRules = rates(HELD_OUT.map((r) => ({ positive: r.label !== 'none', flagged: reachesWebByRules(r.text) })))
  const webBoth = rates(HELD_OUT.map((r) => ({ positive: r.label !== 'none', flagged: reachesWeb(r.text) })))

  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`.padStart(6)
  const row = (name: string, r: Rates): string => `| ${name.padEnd(30)} | ${pct(r.precision)} | ${pct(r.recall)} | ${pct(r.falseAlarm)} |`
  console.log(
    [
      '',
      `web trigger, held-out split: ${HELD_OUT.length} prompts (${HELD_OUT.filter((r) => r.label === 'live').length} live, ${HELD_OUT.filter((r) => r.label === 'web').length} web, ${HELD_OUT.filter((r) => r.label === 'none').length} none)`,
      '| system                         | precis | recall | f.alarm |',
      row('live — rules (4.1)', liveRules),
      row('live — rules + classifier', liveBoth),
      row('web+live — rules (4.1)', webRules),
      row('web+live — rules + classifier', webBoth),
      ''
    ].join('\n')
  )

  test('the classifier does not lose a live question the rules found', () => {
    assert.ok(liveBoth.recall >= liveRules.recall, `${liveBoth.recall} < ${liveRules.recall}`)
  })

  test('nor a web question', () => {
    assert.ok(webBoth.recall >= webRules.recall, `${webBoth.recall} < ${webRules.recall}`)
  })

  test(`false alarms stay under the ceilings (web+live ${WEB_FALSE_ALARM_CEILING * 100}% of chat turns, live ${LIVE_FALSE_ALARM_CEILING * 100}% of the rest)`, () => {
    assert.ok(webBoth.falseAlarm <= WEB_FALSE_ALARM_CEILING, `web+live false alarm ${webBoth.falseAlarm}`)
    assert.ok(webBoth.falseAlarm - webRules.falseAlarm <= WEB_FALSE_ALARM_ADDED_CEILING, `the classifier adds ${webBoth.falseAlarm - webRules.falseAlarm}`)
    assert.ok(liveBoth.falseAlarm <= LIVE_FALSE_ALARM_CEILING, `live false alarm ${liveBoth.falseAlarm}`)
  })

  test('and it is worth having: the combined system finds more than the rules alone', () => {
    assert.ok(liveBoth.recall > liveRules.recall + 0.1, `live recall ${liveRules.recall} → ${liveBoth.recall}`)
    assert.ok(webBoth.recall > webRules.recall + 0.1, `web+live recall ${webRules.recall} → ${webBoth.recall}`)
  })
})
