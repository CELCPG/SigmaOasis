import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildExtractionMessages,
  buildJudgeMessages,
  firstResultUrl,
  parseClaims,
  parseVerdict,
  EXTRACTION_INSTRUCTION,
  JUDGE_INSTRUCTION
} from '../src/renderer/src/lib/claimCheck'
import type { ModelConfig } from '../src/renderer/src/types'

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
    sampling: { temperature: 0.3, topP: 1, maxTokens: -1, seed: null },
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
