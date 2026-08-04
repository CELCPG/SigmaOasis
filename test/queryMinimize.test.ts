import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { load, installStubs } from './harness'

installStubs()
const search = load<typeof import('../src/main/ipc/search')>('search')
const { minimizeQuery } = search

/**
 * Query minimization (DESIGN-private-shopping §2b). The refusal case is
 * transcribed from a real v1.3 session: the model sent an entire paragraph
 * about the user's business trip to DuckDuckGo as a search query, under a
 * schema that says to send terms only.
 */

describe('minimizeQuery · queries that pass through untouched', () => {
  const clean = [
    'organic cotton thongs made in USA brands',
    'Phish Hampton 1997 setlist',
    'used Toyota Corolla for sale Richmond VA under 25000',
    'Judi Rosen organic cotton thong price',
    'what is the capital of Peru',
    'grand sumo tournament September 2026 schedule'
  ]
  for (const query of clean) {
    test(`"${query.slice(0, 40)}…"`, () => {
      const out = minimizeQuery(query)
      assert.equal(out.query, query, 'a keyword query must not be rewritten')
      assert.equal(out.dropped, false)
      assert.equal(out.refusal, undefined)
    })
  }
})

describe('minimizeQuery · framing stripped', () => {
  const cases: [string, string][] = [
    ['im looking for a thong made from organic cotton and made in the usa', 'thong made from organic cotton and made in the usa'],
    ['im trying to find a good deal for a toyota corolla', 'good deal for a toyota corolla'],
    ['can you look up the sumo tournament schedule 2026', 'sumo tournament schedule 2026'],
    // The design doc's own example of what must not be sent.
    ['best noise cancelling headphones for my flight to Lagos', 'best noise cancelling headphones'],
    ['I need a quiet air purifier for a 40 m2 bedroom under $300', 'quiet air purifier for a 40 m2 bedroom under $300']
  ]
  for (const [input, expected] of cases) {
    test(`"${input.slice(0, 40)}…"`, () => {
      const out = minimizeQuery(input)
      assert.equal(out.query, expected)
      assert.equal(out.dropped, true)
      assert.equal(out.refusal, undefined)
    })
  }

  test('personal context after the subject is dropped, not the subject', () => {
    const out = minimizeQuery(
      "so i'm trying to find the best rated laptop under $1000 for my daughter who is starting college"
    )
    assert.equal(out.query, 'best rated laptop under $1000')
  })
})

describe('minimizeQuery · refusal', () => {
  const paragraph =
    'I have a business meeting coming up in Japan. I need to buy 2 new business suits and book ' +
    'flights and hotel in Tokyo for Aug 28 - September 12. I also want to see a sumo wrestling event'

  test('a paragraph about the asker is refused, not truncated', () => {
    // Truncating this to sixteen words leaks the trip AND searches for nothing.
    const out = minimizeQuery(paragraph)
    assert.ok(out.refusal, 'expected a refusal')
    assert.match(out.refusal!, /search terms/i)
  })

  test('the refusal tells the model how to fix it', () => {
    const out = minimizeQuery(paragraph)
    assert.match(out.refusal!, /call the tool again/i)
  })

  test('a long query with no first-person framing is allowed, just capped', () => {
    const long =
      'toyota corolla se 2019 2020 richmond virginia certified pre owned under 25000 low mileage one owner accident free'
    const out = minimizeQuery(long)
    assert.equal(out.refusal, undefined)
    assert.ok(out.query.split(/\s+/).length <= 16)
  })

  test('a short first-person remnant is not worth bouncing', () => {
    const out = minimizeQuery('best gift for my mom')
    assert.equal(out.refusal, undefined)
  })

  test('an empty query is left alone for the caller to reject', () => {
    assert.deepEqual(minimizeQuery('   '), { query: '', dropped: false })
  })
})

describe('runWebSearch refuses framing before anything leaves', () => {
  test('nothing is sent and the model is told why', async () => {
    const out = await search.runWebSearch(
      'I have a business meeting coming up in Japan. I need to buy 2 new business suits and book ' +
        'flights and hotel in Tokyo for Aug 28 - September 12. I also want to see a sumo event'
    )
    assert.equal(out.ok, false)
    assert.match(out.error!, /search terms/i)
    assert.equal(out.sentQuery, '', 'a refused query must never be reported as sent')
  })
})
