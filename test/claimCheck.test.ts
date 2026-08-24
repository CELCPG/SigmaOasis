import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  abandonClaims,
  buildExtractionMessages,
  buildJudgeMessages,
  claimCheckBlocked,
  firstResultUrl,
  parseClaims,
  parseVerdict,
  searchUnreachable,
  EXTRACTION_INSTRUCTION,
  JUDGE_INSTRUCTION,
  UNREACHABLE_NOTE
} from '../src/renderer/src/lib/claimCheck'
import type { ModelConfig, ToolCallRecord } from '../src/renderer/src/types'

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
