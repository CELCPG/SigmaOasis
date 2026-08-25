import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  abandonClaims,
  buildExtractionMessages,
  buildJudgeMessages,
  claimCheckBlocked,
  claimCheckSummary,
  firstResultUrl,
  parseClaims,
  parseVerdict,
  searchUnreachable,
  settleClaims,
  sourceCaveat,
  EXTRACTION_INSTRUCTION,
  JUDGE_INSTRUCTION,
  UNREACHABLE_NOTE,
  type SettleDeps
} from '../src/renderer/src/lib/claimCheck'
import type { CheckedClaim, ModelConfig, ToolCallRecord } from '../src/renderer/src/types'

/**
 * Claim Check's structural guarantees: extraction is the critic's job (never
 * the answerer's), malformed model JSON degrades to zero claims instead of a
 * guess, and anything without a source verdict is unverifiable by default.
 */
function slot(id: string, roleName: string): ModelConfig {
  return {
    id,
    modelId: 'model-x',
    roleName,
    systemPrompt: `You are ${roleName}.`,
    color: 'blue',
    enabled: true,
    sampling: { temperature: 0.3, topP: 1, maxTokens: -1, seed: null, topK: -1, minP: -1 },
    contextWindow: null
  }
}

describe('parseClaims', () => {
  test('parses a clean JSON array', () => {
    const { claims, truncated } = parseClaims('["Claim one.", "Claim two."]', 5)
    assert.deepEqual(claims, ['Claim one.', 'Claim two.'])
    assert.equal(truncated, false)
  })

  test('recovers JSON wrapped in prose or a markdown fence', () => {
    const fenced = 'Here are the claims:\n```json\n["Album X came out in 1996."]\n```\nHope this helps'
    const { claims } = parseClaims(fenced, 5)
    assert.deepEqual(claims, ['Album X came out in 1996.'])
  })

  test('falls back to string literals when the array is malformed', () => {
    const { claims } = parseClaims('Sure! The claims are: "Phish released Billy Budd in 2000" and more', 5)
    assert.deepEqual(claims, ['Phish released Billy Budd in 2000'])
  })

  test('unparseable output degrades to zero claims, never a guess', () => {
    const { claims } = parseClaims('I could not find any claims because reasons', 5)
    assert.deepEqual(claims, [])
  })

  test('respects the per-reply cap and reports truncation', () => {
    const many = JSON.stringify(Array.from({ length: 8 }, (_, i) => `Claim ${i + 1} here.`))
    const { claims, truncated } = parseClaims(many, 5)
    assert.equal(claims.length, 5)
    assert.equal(truncated, true)
  })

  test('empty array stays empty', () => {
    assert.deepEqual(parseClaims('[]', 5).claims, [])
  })
})

describe('firstResultUrl', () => {
  const searchOutput =
    '[UNTRUSTED CONTENT]\n\nSearch results for "Phish albums":\n\n' +
    '1. Phish - Wikipedia\n   https://en.wikipedia.org/wiki/Phish\n   Phish is an American band...\n\n' +
    '2. Phish.com\n   https://www.phish.com\n   Official site mentioning https://example.com in a snippet'

  test('returns the first indented result URL', () => {
    assert.equal(firstResultUrl(searchOutput), 'https://en.wikipedia.org/wiki/Phish')
  })

  test('ignores URLs inside snippet text', () => {
    const onlySnippetUrl = '1. Title\n   not a url line\n   see https://example.com for details'
    assert.equal(firstResultUrl(onlySnippetUrl), null)
  })
})

describe('parseVerdict', () => {
  test('reads explicit CONFIRMED and CONTRADICTED with a basis', () => {
    assert.deepEqual(parseVerdict('VERDICT: CONFIRMED\nBASIS: The page lists the 1996 release.'), {
      verdict: 'confirmed',
      basis: 'The page lists the 1996 release.'
    })
    assert.equal(parseVerdict('VERDICT: CONTRADICTED\nBASIS: No such album exists.').verdict, 'contradicted')
  })

  test('accepts a bare leading verdict word', () => {
    assert.equal(parseVerdict('CONTRADICTED — the discography has no such entry').verdict, 'contradicted')
  })

  test('defaults to unverifiable — never the benefit of the doubt', () => {
    assert.equal(parseVerdict('VERDICT: UNVERIFIABLE\nBASIS: The passage does not say.').verdict, 'unverifiable')
    assert.equal(parseVerdict('I think this is probably true given the context').verdict, 'unverifiable')
    assert.equal(parseVerdict('').verdict, 'unverifiable')
  })
})

describe('prompt assembly', () => {
  const critic = slot('m2', 'Researcher')

  test('extraction demands a JSON array and nothing else', () => {
    assert.match(EXTRACTION_INSTRUCTION, /ONLY a JSON array of strings/)
    const [system, user] = buildExtractionMessages(critic, 'Q?', 'An answer.', 'Assistant')
    assert.match(system!.content, /You are Researcher\./)
    assert.match(user!.content, /Assistant answered/)
    assert.match(user!.content, /An answer\./)
  })

  test('the judge sees one claim and one passage, with verdict rules', () => {
    assert.match(JUDGE_INSTRUCTION, /Never infer beyond the passage/)
    const [, user] = buildJudgeMessages(critic, 'Claim.', 'Passage text.')
    assert.match(user!.content, /Claim\./)
    assert.match(user!.content, /untrusted external content/)
    assert.match(user!.content, /Passage text\./)
  })
})

/**
 * v1.12.3: a pass that cannot succeed must not be run.
 *
 * Measured (TTU3, both builds): with the search provider on a dead port, the
 * claim check still extracted five claims and ran five searches, holding the
 * finished answer for 26-33 seconds of silence to end on five UNVERIFIABLEs.
 * Every one of those verdicts was settled before the pass began — nothing was
 * reachable, and the app knew it from its own turn records.
 */
describe('reachability', () => {
  const errored = (name: string, result: string): ToolCallRecord => ({
    id: `${name}:${result.slice(0, 8)}`,
    name,
    args: { query: 'q' },
    status: 'error',
    result
  })

  test('a refused connection is unreachable; a provider that answered is not', () => {
    for (const transport of [
      'net::ERR_CONNECTION_REFUSED',
      'net::ERR_NAME_NOT_RESOLVED',
      'net::ERR_PROXY_CONNECTION_FAILED',
      'connect ECONNREFUSED 127.0.0.1:9',
      'getaddrinfo ENOTFOUND search.example',
      'fetch failed',
      'Request timed out after 15s.',
      'No SearXNG URL configured — set it under Settings → Search.'
    ]) {
      assert.equal(searchUnreachable(transport), true, transport)
    }
    for (const answered of [
      'SearXNG returned HTTP 403. Enable JSON output on your instance.',
      'The user declined this web search.',
      'Empty search query.',
      'No results found for "marquee moon" (searxng).'
    ]) {
      assert.equal(searchUnreachable(answered), false, answered)
    }
  })

  test('the pass is blocked before a token is spent when every search refused to connect', () => {
    const note = claimCheckBlocked([
      errored('web_search', 'net::ERR_CONNECTION_REFUSED (http://127.0.0.1:9)'),
      errored('web_search', 'net::ERR_CONNECTION_REFUSED (http://127.0.0.1:9)')
    ])
    assert.match(note ?? '', /could not check: no source is reachable/i)
    assert.equal(note, UNREACHABLE_NOTE)
  })

  test('a reachable provider, or no attempt at all, still runs the pass', () => {
    // Nothing tried yet: the pass has to find out for itself.
    assert.equal(claimCheckBlocked([]), null)
    // One search came back — the provider is there, so the next claim may settle.
    assert.equal(
      claimCheckBlocked([
        errored('web_search', 'net::ERR_CONNECTION_REFUSED'),
        { id: 'ok', name: 'web_search', args: {}, status: 'done', result: '1. T\n   https://e.g/a\n   s' }
      ]),
      null
    )
    // Failed, but the provider answered: a 403 is not an unreachable provider.
    assert.equal(claimCheckBlocked([errored('web_search', 'SearXNG returned HTTP 403.')]), null)
    // A failed page fetch is not a failed search: only web_search decides this.
    assert.equal(claimCheckBlocked([errored('fetch_webpage', 'net::ERR_CONNECTION_REFUSED')]), null)
  })

  test('abandoned claims say they were not checked — never UNVERIFIABLE', () => {
    const abandoned = abandonClaims(['Marquee Moon came out in 1977.', 'SST released it.'])
    assert.equal(abandoned.length, 2)
    for (const claim of abandoned) {
      assert.equal(claim.verdict, 'unchecked')
      assert.match(claim.basis ?? '', /no source is reachable/i)
      assert.equal(claim.source, undefined)
    }
    assert.equal(abandoned[0]!.text, 'Marquee Moon came out in 1977.')
  })
})

/**
 * v1.12.4 — the same pass, still running, measured again (TTU3, both arms).
 *
 * v1.12.3 enumerated the transport codes it had seen and missed the one that
 * was actually happening. Pointed at `http://127.0.0.1:9`, Chromium refuses the
 * port before a socket is opened — `net::ERR_UNSAFE_PORT` — which matched none
 * of the patterns, so neither the pre-flight nor the in-pass stop ever fired.
 * Recorded consequence: run-1 spent 41,988 ms on a turn whose own stat line
 * read "23.0s total" — about 19 s of post-answer silence, 45% of the turn — to
 * arrive at three "Unverifiable — Search was declined or failed."; run-2,
 * 62,556 ms against "36.4s total", five of them. Every one of those verdicts
 * was settled before the pass began, and the useful warning ("Answered from
 * model memory — no sources consulted") was already on screen without it.
 */
describe('a refused port stops the pass at the first search (TTU3)', () => {
  /** Verbatim from both recorded runs — what web_search returned every time. */
  const REFUSED =
    'net::ERR_UNSAFE_PORT Tell the user plainly what you could not verify — never invent ' +
    'products, brands, prices, or sources to fill the gap.'

  /** The five claims the critic extracted in run-2, verbatim. */
  const CLAIMS = [
    "The band Television's first album was Marquee Moon.",
    'Marquee Moon was released on March 25, 1977.',
    'Marquee Moon was released via Sire Records.',
    'Tom Verlaine played vocals and guitar in Television.',
    'Richard Lloyd played guitar in Television.'
  ]

  const record = (result: string): ToolCallRecord => ({
    id: `web_search:${result.slice(0, 8)}`,
    name: 'web_search',
    args: { query: 'q' },
    status: 'error',
    result
  })

  /** A provider that refuses every connection, watching how often it is asked. */
  const refusing = (searched: string[]): SettleDeps => ({
    search: async (claim) => {
      searched.push(claim)
      return { ok: false, error: REFUSED }
    },
    fetchPage: async () => assert.fail('a refused search must not be followed by a fetch'),
    judge: async () => assert.fail('a refused search must not be followed by a judgment'),
    onClaim: () => {},
    aborted: () => false
  })

  test('a port Chromium refuses is an unreachable source, not a source that answered', () => {
    assert.equal(searchUnreachable(REFUSED), true)
    assert.equal(searchUnreachable('net::ERR_UNSAFE_PORT'), true)
  })

  test('the rule is "nothing answered", not a list of codes seen so far', () => {
    // Codes the enumeration never named still count: the request never landed.
    for (const nothingAnswered of [
      'net::ERR_SOCKS_CONNECTION_FAILED',
      'net::ERR_TUNNEL_CONNECTION_FAILED',
      'net::ERR_ADDRESS_INVALID'
    ]) {
      assert.equal(searchUnreachable(nothingAnswered), true, nothingAnswered)
    }
    // …and a code that means a server DID answer does not: the next claim may
    // fare differently, so the pass has no business giving up on its behalf.
    for (const answered of [
      'net::ERR_CONTENT_DECODING_FAILED',
      'net::ERR_TOO_MANY_REDIRECTS',
      'net::ERR_INVALID_CHUNKED_ENCODING'
    ]) {
      assert.equal(searchUnreachable(answered), false, answered)
    }
  })

  test('the turn’s own refusals block the pass before a token is spent extracting', () => {
    assert.equal(claimCheckBlocked([record(REFUSED), record(REFUSED)]), UNREACHABLE_NOTE)
  })

  test('five claims cost ONE search, not five', async () => {
    const searched: string[] = []
    const outcome = await settleClaims(CLAIMS, refusing(searched))
    assert.deepEqual(searched, [CLAIMS[0]], 'the pass repeated a search that had already failed')
    assert.equal(outcome.claims.length, 5)
    for (const claim of outcome.claims) {
      assert.equal(claim.verdict, 'unchecked')
      assert.equal(claim.source, undefined)
    }
    assert.equal(outcome.budgetNote, UNREACHABLE_NOTE)
  })

  test('the line on screen says the check could not run, not "5 claims — 0 confirmed"', async () => {
    const outcome = await settleClaims(CLAIMS, refusing([]))
    const summary = claimCheckSummary(outcome, false)
    assert.match(summary, /could not check: no source is reachable/i)
    assert.doesNotMatch(summary, /\d+ claims? —/)
    assert.doesNotMatch(summary, /confirmed|contradicted/)
  })

  test('a provider that answered is not unreachable — every claim still gets its search', async () => {
    const searched: string[] = []
    const outcome = await settleClaims(CLAIMS.slice(0, 3), {
      search: async (claim) => {
        searched.push(claim)
        return { ok: false, error: 'SearXNG returned HTTP 403. Enable JSON output on your instance.' }
      },
      fetchPage: null,
      judge: async () => assert.fail('nothing was fetched, so nothing may be judged'),
      onClaim: () => {},
      aborted: () => false
    })
    assert.equal(searched.length, 3)
    assert.equal(outcome.budgetNote, undefined)
    for (const claim of outcome.claims) assert.equal(claim.verdict, 'unverifiable')
  })

  test('a pass that stops halfway reports what it checked, not what was extracted', async () => {
    const results =
      '1. Marquee Moon — Wikipedia\n   https://en.wikipedia.org/wiki/Marquee_Moon\n   Released 1977.'
    let searches = 0
    const outcome = await settleClaims(CLAIMS.slice(0, 3), {
      search: async () =>
        searches++ === 0 ? { ok: true, output: results } : { ok: false, error: REFUSED },
      fetchPage: async () => ({ ok: true, output: 'Marquee Moon was released on 8 February 1977.' }),
      judge: async () => 'VERDICT: CONTRADICTED\nBASIS: The page dates it 8 February 1977.',
      onClaim: () => {},
      aborted: () => false
    })
    assert.equal(searches, 2, 'the third claim was searched after the second had refused')
    assert.deepEqual(
      outcome.claims.map((c) => c.verdict),
      ['contradicted', 'unchecked', 'unchecked']
    )
    assert.equal(
      claimCheckSummary(outcome, false),
      'Claim check: 1 of 3 claims checked — 0 confirmed, 1 contradicted'
    )
  })

  test('the pass streams each claim out as it settles, abandoned ones included', async () => {
    const seen: CheckedClaim[] = []
    const deps = refusing([])
    await settleClaims(CLAIMS.slice(0, 2), { ...deps, onClaim: (c) => seen.push(c) })
    assert.deepEqual(
      seen.map((c) => c.text),
      CLAIMS.slice(0, 2)
    )
  })
})

/**
 * The footer under the verdicts promises the reader a source to open. Measured
 * (TTU3 run-2): five verdicts, none of them naming a source, and beneath them
 * "Each verdict rests on the one source shown."
 */
describe('the source caveat promises only what is on screen', () => {
  const claim = (text: string, source?: string): CheckedClaim =>
    source
      ? { text, verdict: 'confirmed', source }
      : { text, verdict: 'unverifiable', basis: 'Search was declined or failed.' }

  test('no verdict names a source: no promise of one', () => {
    assert.equal(sourceCaveat([claim('a'), claim('b')]), null)
    assert.equal(sourceCaveat(abandonClaims(['a', 'b'])), null)
    assert.equal(sourceCaveat([]), null)
  })

  test('every verdict names its source: the blanket sentence stands', () => {
    const caveat = sourceCaveat([claim('a', 'https://e.g/1'), claim('b', 'https://e.g/2')])
    assert.match(caveat ?? '', /^Each verdict rests on the one source shown\./)
    assert.match(caveat ?? '', /open it before relying on the claim\.$/)
  })

  test('a mixed pass says which verdicts it means', () => {
    const caveat = sourceCaveat([claim('a', 'https://e.g/1'), claim('b')])
    assert.doesNotMatch(caveat ?? '', /Each verdict rests on the one source shown/)
    assert.match(caveat ?? '', /^Where a verdict names a source, it rests on that one source alone\./)
  })
})
