import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { looksFactual, looksLive, looksLiveByRules, webToolsForTurn } from '../src/renderer/src/lib/grounding'
import { selectTurnTools, TURN_TOOL_CAP, withBudgetNotes, withForcedTools } from '../src/renderer/src/lib/toolSelection'
import { factLedgerProvider } from '../src/renderer/src/lib/contextProviders/factLedger'
import { autoSearchProvider } from '../src/renderer/src/lib/contextProviders/autoSearch'
import { dayOf, longDate, renderLivePage, scoreLiveAnswer, summarizeLive, type LiveAsk, type LiveCaseResult, type LiveFixture } from '../src/renderer/src/lib/liveEval'
import { TOOL_SCHEMAS, TOOL_TURN_BUDGETS } from '../src/shared/tools'
import type { ProviderIO, TurnInput } from '../src/renderer/src/lib/contextProviders'

/**
 * v4.1 (M5): the live world, offline. The model-facing halves — the live
 * tool-choice fixtures and `EVAL_SUITES=live` — need a model; what the app
 * does before the model speaks does not, and is pinned here:
 *
 *   - a live question puts web_search and fetch_webpage on the wire, however
 *     the embedding rank falls (4.0.1: "weather … today" ranked the date tools
 *     first and the model was sent no web tool);
 *   - the fact ledger does not ride the turn, and the app-run search does
 *     (4.0.2: a snippet's "72°F" could answer tomorrow's weather).
 */

const REPO = join(__dirname, '..', '..')
const WEB = ['web_search', 'fetch_webpage']
const NATIVE = TOOL_SCHEMAS.filter((t) => t.function.name !== 'run_code')

interface ToolChoiceFixture {
  file: string
  prompt: string
  expect: { tool: string } | 'no_tool'
  live?: string
}
const toolchoice: ToolChoiceFixture[] = readdirSync(join(REPO, 'test', 'fixtures', 'toolchoice'))
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((file) => ({ file, ...(JSON.parse(readFileSync(join(REPO, 'test', 'fixtures', 'toolchoice', file), 'utf8')) as Omit<ToolChoiceFixture, 'file'>) }))
const liveChoice = toolchoice.filter((f) => f.live)

const liveCases: LiveFixture[] = readdirSync(join(REPO, 'test', 'fixtures', 'live', 'cases'))
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((file) => ({ file, ...(JSON.parse(readFileSync(join(REPO, 'test', 'fixtures', 'live', 'cases', file), 'utf8')) as Omit<LiveFixture, 'file'>) }))

/** Every question the app is asked about the live world, from both suites. */
const LIVE_QUESTIONS = [...liveChoice.map((f) => ({ id: f.file, text: f.prompt, kind: f.live! })), ...liveCases.map((f) => ({ id: f.file, text: f.question, kind: f.kind as string }))]

test('the tool-choice suite asks the live world — weather, a score, futures, a latest version — and expects the web', () => {
  assert.deepEqual([...new Set(liveChoice.map((f) => f.live))].sort(), ['futures', 'score', 'version', 'weather'])
  for (const f of liveChoice) assert.deepEqual(f.expect, { tool: 'web_search' }, f.file)
})

describe('a live-world turn on the wire, before any model', () => {
  // The ranking that failed in 4.0.1, made total: every web tool scored last.
  const scores = Object.fromEntries(NATIVE.map((t, i) => [t.function.name, WEB.includes(t.function.name) ? 0 : 1 - i / 100]))

  for (const q of LIVE_QUESTIONS) {
    test(`${q.id}: web_search and fetch_webpage ride the turn whatever the rank says`, () => {
      const ranked = selectTurnTools(NATIVE, scores)
      assert.ok(!ranked.some((t) => WEB.includes(t.function.name)), 'the ranking alone sends no web tool — the case the rule exists for')
      assert.deepEqual([...webToolsForTurn(q.text)], WEB)
      const wire = withBudgetNotes(withForcedTools(NATIVE, ranked, webToolsForTurn(q.text)), TOOL_TURN_BUDGETS).map((t) => t.function.name)
      for (const w of WEB) assert.ok(wire.includes(w), `${w} is not on the wire for "${q.text}"`)
      assert.ok(wire.length <= TURN_TOOL_CAP)
    })
  }
})

describe('a live-world turn and the ledger', () => {
  const input = (text: string): TurnInput =>
    ({
      convo: { id: 'c', messages: [] },
      conversations: [],
      slot: { id: 's', roleName: 'A', modelId: 'm' },
      slotTools: NATIVE,
      lastUserContent: text,
      previousUserContent: undefined,
      offline: false,
      // As the chat decides it (hooks/chatTurn.ts): the live domains are factual.
      factualTurn: looksFactual(text),
      referenceTurn: false,
      shoppingTurn: false,
      project: null,
      assistantMsgId: 'a',
      signal: new AbortController().signal
    }) as unknown as TurnInput
  const io = {
    runTool: async () => ({ ok: true, output: '' }),
    recordSyntheticCall() {},
    // A lookup that would answer: the gate, not an empty ledger, is what keeps it off the turn.
    api: { ledgerLookup: async () => ({ ok: true, hits: [] }) },
    patch() {},
    settings: () => ({ grounding: { factLedger: true } })
  } as unknown as ProviderIO

  for (const q of LIVE_QUESTIONS.filter((x) => x.kind !== 'version')) {
    test(`${q.id}: no ledger, and the app runs the search`, () => {
      assert.equal(looksLive(q.text), true)
      assert.equal(factLedgerProvider.enabled(input(q.text), io), false)
      assert.equal(autoSearchProvider.enabled(input(q.text), io), true)
    })
  }

  test('control: a question about a fact that holds still does get the ledger', () => {
    assert.equal(factLedgerProvider.enabled(input('How much is an adult ticket to the Harrowgate Maritime Museum?'), io), true)
  })

  // Was the KNOWN GAP pinned here through 4.1: "the latest version of X" is live
  // (it moves with every release) but not in LIVE_DOMAINS, so the ledger could
  // answer it from a version filed 730 days fresh. v4.2 (C3): the web-trigger
  // classifier reads it as live — the labelled set puts "latest version"
  // questions in `live` — so the ledger stays off it as it does for the
  // weather. The rule itself is unchanged; the classifier closes the gap.
  test('a "latest version" question: the rules still miss it, the classifier keeps the ledger off (v4.2)', () => {
    for (const q of LIVE_QUESTIONS.filter((x) => x.kind === 'version')) {
      assert.equal(looksLiveByRules(q.text), false, q.id)
      assert.equal(looksLive(q.text), true, q.id)
      assert.equal(factLedgerProvider.enabled(input(q.text), io), false, q.id)
      assert.equal(autoSearchProvider.enabled(input(q.text), io), true, q.id)
    }
  })
})

// ---- EVAL_SUITES=live: the pages and the scoring -------------------------------------

const NOW = new Date(2026, 8, 30, 9, 0) // Wednesday, September 30, 2026, 9 AM local

describe('the live suite\'s fixtures', () => {
  test('six cases, two of each kind, every question read as live', () => {
    assert.deepEqual(
      liveCases.map((c) => c.kind),
      ['weather', 'weather', 'score', 'score', 'futures', 'futures']
    )
    for (const c of liveCases) assert.equal(looksLive(c.question), true, c.file)
  })

  test('each page dates every row from the clock; the day asked has a row, and only its row matches the answer', () => {
    for (const c of liveCases) {
      const html = renderLivePage(c, NOW)
      assert.match(html, new RegExp(`<title>${c.title}</title>`))
      for (const r of c.rows) assert.ok(html.includes(longDate(dayOf(NOW, r.day))), `${c.file}: no date for day ${r.day}`)
      const answer = c.rows.find((r) => r.day === c.answerDay)
      assert.ok(answer, `${c.file}: no row for the day asked`)
      for (const p of c.mustInclude) {
        assert.match(answer.text, new RegExp(p, 'i'), `${c.file}: the answer row does not carry ${p}`)
        for (const r of c.rows.filter((x) => x !== answer)) assert.doesNotMatch(r.text, new RegExp(p, 'i'), `${c.file}: day ${r.day} also matches ${p} — the date would not be scored`)
      }
      for (const p of c.otherDays) assert.doesNotMatch(answer.text, new RegExp(p, 'i'), `${c.file}: ${p} matches the answer row`)
      assert.ok(c.otherDays.every((p) => c.rows.some((r) => r.day !== c.answerDay && new RegExp(p, 'i').test(r.text))), `${c.file}: an otherDays pattern matches no other row`)
    }
    assert.match(renderLivePage(liveCases[0]!, NOW), /Wednesday, September 30, 2026/)
  })
})

describe('scoring a live answer', () => {
  const fx = liveCases.find((c) => c.file === '01-weather-harrowgate.json')!
  const ask = (over: Partial<LiveAsk>): LiveAsk => ({ reply: 'Today in Harrowgate: sunny, high of 67°F.', wireTools: ['get_current_datetime', 'web_search', 'fetch_webpage'], searches: 1, fetches: 1, ledgerServed: false, ...over })

  test('searched, read, today\'s figure: a pass', () => {
    assert.deepEqual(scoreLiveAnswer(fx, ask({}), NOW), { webToolsOnWire: true, searched: true, fetched: true, answered: true, wrongDay: false, dateCorrect: true, noLedger: true, pass: true })
  })

  test("another day's figure is the wrong date; today's beside tomorrow's is still an answer", () => {
    const wrong = scoreLiveAnswer(fx, ask({ reply: 'Harrowgate: heavy rain, high of 58°F.' }), NOW)
    assert.deepEqual([wrong.answered, wrong.wrongDay, wrong.pass], [false, true, false])
    const both = scoreLiveAnswer(fx, ask({ reply: 'High of 67°F today; tomorrow 73°F with storms.' }), NOW)
    assert.deepEqual([both.answered, both.wrongDay, both.pass], [true, false, true])
  })

  test('a reply that names a date must name the day asked', () => {
    assert.equal(scoreLiveAnswer(fx, ask({ reply: 'On September 30 Harrowgate sees a high of 67°F.' }), NOW).dateCorrect, true)
    assert.equal(scoreLiveAnswer(fx, ask({ reply: 'On Sept 29 Harrowgate saw a high of 67°F.' }), NOW).dateCorrect, false)
    assert.equal(scoreLiveAnswer(fx, ask({ reply: 'Forecast for 9/30: high 67°F.' }), NOW).dateCorrect, true)
  })

  test('no web tools on the wire, no search, no page read, or a ledger answer each fail the case', () => {
    assert.equal(scoreLiveAnswer(fx, ask({ wireTools: ['get_current_datetime', 'web_search'] }), NOW).pass, false)
    assert.equal(scoreLiveAnswer(fx, ask({ searches: 0 }), NOW).pass, false)
    assert.equal(scoreLiveAnswer(fx, ask({ fetches: 0 }), NOW).pass, false)
    const l = scoreLiveAnswer(fx, ask({ ledgerServed: true }), NOW)
    assert.deepEqual([l.noLedger, l.pass], [false, false])
  })

  test('the summary counts ledger answers and leaves errored cases out of the rates', () => {
    const r = (score: ReturnType<typeof scoreLiveAnswer>): LiveCaseResult => ({ file: 'f', kind: 'weather', question: 'q', score, ask: { ...ask({}), ms: 2000 } })
    const s = summarizeLive([r(scoreLiveAnswer(fx, ask({}), NOW)), r(scoreLiveAnswer(fx, ask({ ledgerServed: true }), NOW)), { file: 'g', kind: 'score', question: 'q', error: 'HTTP 500' }])
    assert.deepEqual(s.ran, { hit: 2, of: 3 })
    assert.deepEqual(s.pass, { hit: 1, of: 2 })
    assert.deepEqual(s.ledgerAnswers, { hit: 1, of: 2 })
    assert.equal(s.seconds, 2)
  })
})
