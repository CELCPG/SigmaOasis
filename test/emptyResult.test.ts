import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { load } from './harness'
import { consultedSources, needsVerification } from '../src/renderer/src/lib/grounding'
import { ToolCallBlock } from '../src/renderer/src/components/ToolCallBlock'
import type { ToolCallRecord } from '../src/renderer/src/types'

/**
 * A retrieval that found nothing succeeded as a *call* and failed as a
 * *lookup*. The build said only the first, in both places it speaks.
 *
 * Measured on TH2 (`.h2h-runs/judge-r4/TH2`), a turn whose search fixture
 * answers HTTP 500 for every query against an empty reference library — so
 * zero sources are consulted, by construction:
 *
 *   run-2 (older build) printed "⚠️ Answered from model memory — no sources
 *   consulted." Its `reference_lookup` had errored, because the model named a
 *   pack that is not installed.
 *
 *   run-1 (this build) printed no such line, and showed a green ✓ on a
 *   `reference_lookup` whose result reads "No reference passages found … The
 *   reference library is empty." Its only difference: the model omitted the
 *   `pack` argument, so the same nothing came back `ok`.
 *
 * Which argument the model happened to send is not a fact about verification.
 */

const libraryModule = load<typeof import('../src/main/ipc/library')>('library')

/** The TH2 prompt, verbatim. */
const TH2_QUESTION =
  "What's the latest guidance on where carbon monoxide alarms should go in a two-storey house? Give me the source links."

/** The lookup query run-1's model sent, verbatim from its audit log. */
const TH2_LOOKUP_QUERY = 'carbon monoxide alarm placement two storey house bedrooms hallway stairwell'

/** The fixture's answer to every query, verbatim from both runs' audit logs. */
const SEARXNG_500 =
  'SearXNG returned HTTP 500. If this is 403, enable JSON output on your instance ' +
  '(settings.yml → search: formats: [html, json]). Tell the user plainly what you could not ' +
  'verify — never invent products, brands, prices, or sources to fill the gap.'

/** run-2's lookup error, verbatim: a pack the library does not have. */
const NO_SUCH_PACK = 'No pack "home repair" is installed.'

/** The app's own text for a lookup that found nothing — built by the formatter that ships. */
const EMPTY_LOOKUP = libraryModule.formatLookup(
  { ok: true, passages: [], mode: 'keyword', notes: ['The reference library is empty.'] },
  TH2_LOOKUP_QUERY
)

/** The same formatter, over a passage that does answer the question. */
const PASSAGES_LOOKUP = libraryModule.formatLookup(
  {
    ok: true,
    mode: 'hybrid',
    notes: [],
    passages: [
      {
        packId: 'home-safety',
        packName: 'Home safety',
        docId: 'carbon-monoxide-indoors',
        docTitle: 'Carbon monoxide indoors',
        section: 'Where to put alarms',
        position: 0.34,
        text:
          'Fit an alarm on every storey: in the room with any fuel-burning appliance, and ' +
          'outside the sleeping areas on each floor.',
        score: 0.81,
        source: 'https://example.invalid/carbon-monoxide'
      }
    ]
  },
  TH2_LOOKUP_QUERY
)

/** A provider that answered and matched nothing — the web_search handler's own wording. */
const EMPTY_SEARCH =
  'No results found for "carbon monoxide alarm placement two storey house" (searxng). ' +
  'Say plainly that the search found nothing usable; do not invent results.'

let seq = 0
const rec = (name: string, status: ToolCallRecord['status'], result: string): ToolCallRecord => ({
  id: `${name}-${(seq += 1)}`,
  name,
  args: {},
  status,
  result
})

/**
 * The badge decision, exactly as useLMStudio.ts makes it at both call sites
 * (`checkableTurn && !consultedSources(allRecords)` → `patch({ unverified: true })`,
 * which is what renders the "Answered from model memory" line in MessageBubble).
 */
const answeredFromMemory = (question: string, records: ToolCallRecord[]): boolean =>
  needsVerification(question) && !consultedSources(records)

/** run-2: three source calls, all errored. */
const RUN_2_RECORDS = [
  rec('web_search', 'error', 'That query is a sentence about you, not search terms, so it was not sent.'),
  rec('reference_lookup', 'error', NO_SUCH_PACK),
  rec('web_search', 'error', SEARXNG_500)
]

/** run-1: the same turn, except the lookup came back `ok` with nothing in it. */
const RUN_1_RECORDS = [
  rec('web_search', 'error', 'That query is a sentence about you, not search terms, so it was not sent.'),
  rec('reference_lookup', 'done', EMPTY_LOOKUP),
  rec('web_search', 'error', SEARXNG_500),
  rec('web_search', 'error', SEARXNG_500)
]

/** The same turn if the library had held the answer. */
const GROUNDED_RECORDS = [
  rec('web_search', 'error', SEARXNG_500),
  rec('reference_lookup', 'done', PASSAGES_LOOKUP)
]

describe('a source tool that found nothing did not supply a source', () => {
  test("the empty-lookup fixture is the app's own output, verbatim from run-1's audit log", () => {
    assert.equal(
      EMPTY_LOOKUP,
      'No reference passages found for "carbon monoxide alarm placement two storey house bedrooms hallway stairwell".\n' +
        'The reference library is empty.\n' +
        'Say plainly that the library has nothing on this; do not invent a reference.'
    )
  })

  test('the badge gate reaches this question at all', () => {
    assert.equal(needsVerification(TH2_QUESTION), true)
  })

  test('every source tool errored: the turn is answered from memory (run-2)', () => {
    assert.equal(consultedSources(RUN_2_RECORDS), false)
    assert.equal(
      answeredFromMemory(TH2_QUESTION, RUN_2_RECORDS),
      true,
      'a turn where every source tool failed must say the answer came from memory'
    )
  })

  test('a lookup that returned nothing is not a source either (run-1)', () => {
    assert.equal(
      consultedSources(RUN_1_RECORDS),
      false,
      'the library was empty and every search returned 500 — nothing was consulted'
    )
    assert.equal(
      answeredFromMemory(TH2_QUESTION, RUN_1_RECORDS),
      true,
      'the disclosure must not turn on whether the model named a pack that exists'
    )
  })

  test('a search that matched nothing is not a source', () => {
    const records = [rec('web_search', 'done', EMPTY_SEARCH)]
    assert.equal(consultedSources(records), false)
    assert.equal(answeredFromMemory(TH2_QUESTION, records), true)
  })

  test('a lookup that returned passages still is', () => {
    assert.equal(consultedSources(GROUNDED_RECORDS), true)
    assert.equal(
      answeredFromMemory(TH2_QUESTION, GROUNDED_RECORDS),
      false,
      'a turn with a genuinely successful lookup is not answered from memory'
    )
  })

  test('the two turns must not reach the same verdict', () => {
    assert.notEqual(
      consultedSources(RUN_1_RECORDS),
      consultedSources(GROUNDED_RECORDS),
      'a lookup that supplied nothing and one that supplied a passage cannot both count as sources'
    )
  })
})

/**
 * The collapsed header is the whole of what a reader sees — the h2h capture
 * records exactly that, and it is where run-1's ✓ was read off an empty lookup.
 */
function headerText(record: ToolCallRecord): string {
  const html = renderToStaticMarkup(createElement(ToolCallBlock, { record }))
  const button = html.match(/<button[^>]*>([\s\S]*?)<\/button>/)
  assert.ok(button, `no header button in ${html}`)
  return button[1]
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function headerHtml(record: ToolCallRecord): string {
  const html = renderToStaticMarkup(createElement(ToolCallBlock, { record }))
  return html.match(/<button[^>]*>([\s\S]*?)<\/button>/)?.[0] ?? html
}

describe('the tool block distinguishes a call that worked from one that supplied something', () => {
  const empty = rec('reference_lookup', 'done', EMPTY_LOOKUP)
  const grounded = rec('reference_lookup', 'done', PASSAGES_LOOKUP)
  const failed = rec('reference_lookup', 'error', NO_SUCH_PACK)

  test('an empty-result lookup does not read like one that returned passages', () => {
    assert.notEqual(
      headerText(empty),
      headerText(grounded),
      'measured (run-1): both rendered "✓ ⚙️ reference_lookup", one over "No reference passages found"'
    )
  })

  test('it does not carry the success glyph', () => {
    assert.ok(!headerText(empty).includes('✓'), `empty lookup still shows ✓: ${headerText(empty)}`)
    assert.ok(
      !/text-ink-ok/.test(headerHtml(empty)),
      // v2.2: was text-green-500, which is 2.22:1 on the light panel. The claim
      // is unchanged — the empty lookup must not wear the success colour —
      // only the colour it names, which is now the theme-aware ink token.
      'empty lookup still renders in the success colour'
    )
  })

  test('it says on the header what it found', () => {
    assert.match(headerText(empty), /found nothing/)
  })

  test('a lookup that returned passages keeps the success glyph', () => {
    assert.ok(headerText(grounded).includes('✓'))
    assert.ok(/text-ink-ok/.test(headerHtml(grounded)))
    assert.ok(!/found nothing/.test(headerText(grounded)))
  })

  test('a call that errored still reads as an error, not as an empty result', () => {
    assert.ok(headerText(failed).includes('✗'))
    assert.ok(!/found nothing/.test(headerText(failed)))
  })

  test('a tool with no empty-result wording is untouched', () => {
    const python = rec('run_python', 'done', 'ran in 3 ms')
    assert.ok(headerText(python).includes('✓'))
    assert.equal(consultedSources([python]), true)
  })
})
