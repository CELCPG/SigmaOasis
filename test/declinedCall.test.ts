import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { load } from './harness'
import { declinedCall, failureReason, toolFailure, wasDeclined } from '../src/shared/tools/outcomes'
import { ToolCallBlock } from '../src/renderer/src/components/ToolCallBlock'
import { conversationStats } from '../src/renderer/src/lib/conversationStats'
import { settleClaims } from '../src/renderer/src/lib/claimCheck'
import type { SettleDeps } from '../src/renderer/src/lib/claimCheck'
import type { Conversation, ToolCallRecord } from '../src/renderer/src/types'

/**
 * Round 5 gave a call that worked and found nothing its own state (∅), because
 * it had been reading as a success. The other glyph carries the same fault one
 * step further: ✗ covers a provider that answered with an error, a host that
 * could not be reached, and a call the app declined to make. Only two of those
 * are failures.
 *
 * Measured (TH2, `.h2h-runs/judge-r5/TH2/run-1`, audit log): three web_search
 * rows, every one `✗ 🔍 web_search`. The first never left the machine —
 * "That query is a sentence about you, not search terms, so it was not sent" —
 * and the other two are the fixture's HTTP 500. A blind critic read the first
 * as the third and observed that the Details panel's "Tool calls 3" therefore
 * overstates what reached the network.
 *
 * Measured (TTU3, `.h2h-runs/judge-r5/TTU3/run-1`, transcript): seven rows of
 * bare `✗ 🔍 web_search`. The reason behind all seven — `net::ERR_UNSAFE_PORT`,
 * the same one every time — is legible only after opening a disclosure, so
 * collapsed the transcript says something went wrong and nothing else.
 */

const search = load<typeof import('../src/main/ipc/search')>('search')

/** The TH2 prompt, verbatim — and the query run-1's model sent as-is. */
const TH2_QUESTION =
  "What's the latest guidance on where carbon monoxide alarms should go in a two-storey house? Give me the source links."

/** The guidance web_search appends to every failure, verbatim from both runs. */
const SEARCH_GUIDANCE =
  'Tell the user plainly what you could not verify — never invent products, brands, ' +
  'prices, or sources to fill the gap.'

/** TTU3's failure, verbatim from run-1's transcript: the host was never reached. */
const UNSAFE_PORT = 'net::ERR_UNSAFE_PORT'

/** TH2's failure, verbatim from run-1's audit log: the provider answered, badly. */
const SEARXNG_500 =
  'SearXNG returned HTTP 500. If this is 403, enable JSON output on your instance ' +
  '(settings.yml → search: formats: [html, json]).'

/**
 * The one clause the row carries for TH2's refused call. Pinned as a literal
 * here and against `minimizeQuery` below, so the wording the reader sees and
 * the wording the guard emits are the same string.
 */
const TH2_DECLINE_REASON = 'the query was a sentence about you, not search terms'

/** A lookup that ran and found nothing — round 5's state, verbatim from run-1. */
const EMPTY_LOOKUP =
  'No reference passages found for "carbon monoxide alarm placement two storey house location recommendations".\n' +
  'The reference library is empty.\n' +
  'Say plainly that the library has nothing on this; do not invent a reference.'

let seq = 0
const rec = (name: string, status: ToolCallRecord['status'], result: string): ToolCallRecord => ({
  id: `${name}-${(seq += 1)}`,
  name,
  args: {},
  status,
  result
})

// ---- the three states, as the handler composes them --------------------------

/** The call the app declined: nothing was contacted, so the app says why itself. */
const DECLINED = rec(
  'web_search',
  'error',
  declinedCall(TH2_DECLINE_REASON, `${search.minimizeQuery(TH2_QUESTION).refusal} ${SEARCH_GUIDANCE}`)
)
/** The provider answered with an error. */
const SERVER_ERROR = rec('web_search', 'error', toolFailure(SEARXNG_500, SEARCH_GUIDANCE))
/** The host was never reachable. */
const UNREACHABLE = rec('web_search', 'error', toolFailure(UNSAFE_PORT, SEARCH_GUIDANCE))
/** The call ran and came back empty. */
const EMPTY = rec('reference_lookup', 'done', EMPTY_LOOKUP)

/** The collapsed header is the whole of what a reader sees; the h2h capture records exactly it. */
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

describe('the guard and the row agree on what a decline is', () => {
  test("TH2's query really is refused before the wire, by the shipped guard", () => {
    const out = search.minimizeQuery(TH2_QUESTION)
    assert.ok(out.refusal, 'expected minimizeQuery to refuse the TH2 query')
    assert.equal(
      out.refusalReason,
      TH2_DECLINE_REASON,
      'the guard must emit the same clause the row prints'
    )
  })

  test('only a composed decline reads as one', () => {
    assert.equal(wasDeclined(DECLINED.result!), true)
    assert.equal(wasDeclined(SERVER_ERROR.result!), false)
    assert.equal(wasDeclined(UNREACHABLE.result!), false)
  })

  test('the model still gets the whole refusal, not just the clause', () => {
    assert.match(DECLINED.result!, /search terms/)
    assert.match(DECLINED.result!, /call the tool again/i)
    assert.match(DECLINED.result!, /never invent products/)
  })
})

describe('a declined call, a failed call and an empty result are three states', () => {
  test('the decline does not read as a failure', () => {
    assert.ok(
      !headerText(DECLINED).includes('✗'),
      `measured (TH2 run-1): a call that was never sent rendered "${headerText(DECLINED)}"`
    )
  })

  test('the failure still does', () => {
    assert.ok(headerText(SERVER_ERROR).includes('✗'))
    assert.ok(headerText(UNREACHABLE).includes('✗'))
  })

  test('the empty result is neither', () => {
    assert.ok(!headerText(EMPTY).includes('✗'))
    assert.ok(!headerText(EMPTY).includes('✓'))
    assert.match(headerText(EMPTY), /found nothing/)
  })

  test('no two of the three collapse to the same row', () => {
    const rows = [headerText(DECLINED), headerText(SERVER_ERROR), headerText(EMPTY)]
    assert.equal(
      new Set(rows).size,
      3,
      `three different facts about the world, ${new Set(rows).size} row(s): ${JSON.stringify(rows)}`
    )
  })

  test('the decline says it was declined, in words and not only in a glyph', () => {
    assert.match(headerText(DECLINED), /declined/i)
  })
})

describe('the collapsed row names the reason', () => {
  test('a host that was never reached says so without being opened (TTU3)', () => {
    assert.match(
      headerText(UNREACHABLE),
      /ERR_UNSAFE_PORT/,
      `measured (TTU3 run-1): seven rows of "${headerText(UNREACHABLE)}" and the reason inside a disclosure`
    )
  })

  test('a provider error names the status (TH2)', () => {
    assert.match(headerText(SERVER_ERROR), /HTTP 500/)
  })

  test('a decline names what the app objected to (TH2)', () => {
    assert.match(headerText(DECLINED), /not search terms/)
  })

  test('two failures with different causes do not read alike', () => {
    assert.notEqual(headerText(SERVER_ERROR), headerText(UNREACHABLE))
  })

  test('the row stays a glance: the coaching for the model is not on it', () => {
    for (const r of [DECLINED, SERVER_ERROR, UNREACHABLE]) {
      assert.ok(
        !/never invent products/.test(headerText(r)),
        `the model's instructions leaked onto the row: ${headerText(r)}`
      )
    }
  })

  test('an error this module never composed still names something', () => {
    // fetch_webpage and the calculators hand their errors through raw.
    const raw = rec('fetch_webpage', 'error', 'Could not fetch that page. The request timed out.')
    assert.match(headerText(raw), /Could not fetch that page/)
  })

  test('a long reason is cut to a clause, not printed whole', () => {
    const long = 'x'.repeat(200)
    assert.ok(failureReason(long).length <= 72, failureReason(long))
    assert.match(failureReason(long), /…$/)
  })
})

// ---- what the Details panel counts -------------------------------------------

const convo = (calls: ToolCallRecord[]): Conversation => ({
  id: 'c',
  title: 'c',
  mode: 'independent',
  createdAt: 1,
  updatedAt: 1,
  messages: [
    { id: 'u1', role: 'user', content: TH2_QUESTION, createdAt: 1 },
    { id: 'a1', role: 'assistant', content: 'I could not retrieve…', createdAt: 2, toolCalls: calls }
  ]
})

describe('the tool-call count does not have to mean two things at once', () => {
  /** TH2 run-1's turn: refused, empty lookup, 500, 500. */
  const TH2_TURN = [DECLINED, EMPTY, SERVER_ERROR, rec('web_search', 'error', toolFailure(SEARXNG_500, SEARCH_GUIDANCE))]

  test('every call the model made is still counted', () => {
    assert.equal(conversationStats(convo(TH2_TURN)).toolCalls, 4)
  })

  test('and the ones the app declined are named, so the count is not read as egress', () => {
    assert.equal(
      conversationStats(convo(TH2_TURN)).declinedCalls,
      1,
      'measured (TH2 run-1): "Tool calls 3" over a turn where one call never left the machine'
    )
  })

  test('a turn with nothing declined says nothing about declines', () => {
    assert.equal(conversationStats(convo([EMPTY, SERVER_ERROR])).declinedCalls, 0)
  })
})

// ---- the same distinction, one panel over ------------------------------------

/**
 * The claim-check panel settled TTU3's five claims as "Unverifiable — Search
 * was declined or failed." Nothing was declined on that turn: every search was
 * `net::ERR_UNSAFE_PORT`. A verdict that offers the reader a choice of two
 * reasons has told them neither.
 */
describe('a claim the app declined to check does not read like one a provider failed', () => {
  const deps = (error: string): SettleDeps => ({
    search: async () => ({ ok: false, error }),
    fetchPage: null,
    judge: async () => assert.fail('a failed search must not be followed by a judgment'),
    onClaim: () => {},
    aborted: () => false
  })

  const basisFor = async (error: string): Promise<string> => {
    const out = await settleClaims(["Television's first album was the self-titled 'Television'."], deps(error))
    return out.claims[0]?.basis ?? ''
  }

  test('a decline says the app declined', async () => {
    const basis = await basisFor(DECLINED.result!)
    assert.match(basis, /declined/i)
    assert.doesNotMatch(basis, /failed/i, `measured (TTU3 run-1): "${basis}"`)
  })

  test('a provider failure says it failed, and does not offer a decline as an alternative', async () => {
    // ERR_UNSAFE_PORT stops the whole pass, so this uses the provider error.
    const basis = await basisFor(SERVER_ERROR.result!)
    assert.match(basis, /failed/i)
    assert.doesNotMatch(basis, /declined/i, `measured (TTU3 run-1): "${basis}"`)
  })
})
