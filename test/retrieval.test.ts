import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './harness'

const {
  Bm25Index,
  tokenize,
  reciprocalRankFusion,
  normalizeScores,
  jaccard,
  mmrSelect
} = load<typeof import('../src/main/ipc/retrieval')>('retrieval')

describe('tokenize', () => {
  test('keeps dotted, versioned and hyphenated tokens intact', () => {
    assert.deepEqual(tokenize('Use node.js 1.2.3 with --no-verify'), [
      'use',
      'node.js',
      '1.2.3',
      'no-verify'
    ])
  })

  test('drops stopwords and single characters', () => {
    const terms = tokenize('the a of x cache')
    assert.ok(!terms.includes('the'))
    assert.ok(!terms.includes('x'))
    assert.ok(terms.includes('cache'))
  })

  test('strips trailing punctuation', () => {
    assert.deepEqual(tokenize('timeout, retry.'), ['timeout', 'retry'])
  })

  test('empty input yields no terms', () => {
    assert.deepEqual(tokenize('   '), [])
  })
})

describe('Bm25Index', () => {
  const docs = [
    { id: 'd1', terms: tokenize('the retry timeout defaults to 30 seconds') },
    { id: 'd2', terms: tokenize('cache invalidation happens on write') },
    { id: 'd3', terms: tokenize('retry retry retry backoff strategy') }
  ]
  const index = new Bm25Index(docs)

  test('ranks the best lexical match first', () => {
    assert.equal(index.search(tokenize('retry timeout'))[0].id, 'd1')
  })

  test('omits documents matching no query term', () => {
    assert.ok(!index.search(tokenize('retry timeout')).some((h) => h.id === 'd2'))
  })

  test('all scores are positive', () => {
    assert.ok(index.search(tokenize('retry')).every((h) => h.score > 0))
  })

  test('a term present in every document still scores non-negative', () => {
    // Unsmoothed IDF goes negative when a term appears in >half the corpus,
    // which would rank a universal term as evidence against a match.
    const universal = new Bm25Index([
      { id: 'a', terms: ['retry'] },
      { id: 'b', terms: ['retry'] }
    ]).search(['retry'])
    assert.ok(universal.every((h) => h.score > 0))
  })

  test('term frequency saturates rather than scaling linearly', () => {
    // BM25's k1 term is what stops keyword stuffing from dominating: d3 has
    // 3x the occurrences of d1 but must not score 3x.
    const single = new Bm25Index([{ id: 'one', terms: ['retry'] }]).search(['retry'])[0].score
    const triple = new Bm25Index([{ id: 'three', terms: ['retry', 'retry', 'retry'] }]).search([
      'retry'
    ])[0].score
    assert.ok(triple < single * 3)
  })

  test('empty query and empty corpus are safe', () => {
    assert.equal(index.search([]).length, 0)
    assert.equal(new Bm25Index([]).search(['x']).length, 0)
  })
})

describe('reciprocalRankFusion', () => {
  test('symmetric inputs produce symmetric scores', () => {
    const fused = reciprocalRankFusion([
      ['a', 'b', 'c'],
      ['c', 'b', 'a']
    ])
    assert.ok(Math.abs(fused.get('a')! - fused.get('c')!) < 1e-12)
  })

  test('appearing in both rankings beats topping one', () => {
    // This is the property that makes BM25 + cosine fusion work at all.
    const fused = reciprocalRankFusion([['x', 'y'], ['y']])
    assert.ok(fused.get('y')! > fused.get('x')!)
  })

  test('rank order is preserved within a single list', () => {
    const fused = reciprocalRankFusion([['x', 'y']])
    assert.ok(fused.get('x')! > fused.get('y')!)
  })

  test('no lists produces no scores', () => {
    assert.equal(reciprocalRankFusion([]).size, 0)
  })
})

describe('normalizeScores', () => {
  test('maps min to 0 and max to 1', () => {
    const norm = normalizeScores([
      { id: 'lo', score: 2 },
      { id: 'hi', score: 10 },
      { id: 'mid', score: 6 }
    ])
    assert.equal(norm.get('lo'), 0)
    assert.equal(norm.get('hi'), 1)
    assert.ok(Math.abs(norm.get('mid')! - 0.5) < 1e-12)
  })

  test('identical scores do not divide by zero', () => {
    const flat = normalizeScores([
      { id: 'a', score: 5 },
      { id: 'b', score: 5 }
    ])
    assert.equal(flat.get('a'), 1)
    assert.equal(flat.get('b'), 1)
  })

  test('empty input is safe', () => {
    assert.equal(normalizeScores([]).size, 0)
  })
})

describe('jaccard', () => {
  test('identical sets are 1', () => {
    assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1)
  })
  test('disjoint sets are 0', () => {
    assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0)
  })
  test('half overlap is one third', () => {
    assert.ok(Math.abs(jaccard(new Set(['a', 'b']), new Set(['b', 'c'])) - 1 / 3) < 1e-12)
  })
  test('empty set is 0', () => {
    assert.equal(jaccard(new Set(), new Set(['a'])), 0)
  })
})

describe('mmrSelect', () => {
  // b is a near-duplicate of a; c is distinct but less relevant.
  const similarity = (x: string, y: string): number =>
    [x, y].sort().join('') === 'ab' ? 0.98 : 0.05

  const candidates = [
    { id: 'a', relevance: 1.0 },
    { id: 'b', relevance: 0.97 },
    { id: 'c', relevance: 0.7 }
  ]

  test('drops a near-duplicate in favor of a distinct passage', () => {
    assert.deepEqual(mmrSelect(candidates, 2, 0.72, similarity), ['a', 'c'])
  })

  test('lambda of 1 ignores diversity entirely', () => {
    assert.deepEqual(mmrSelect(candidates, 2, 1.0, similarity), ['a', 'b'])
  })

  test('never returns more than topK or more than exist', () => {
    assert.equal(mmrSelect(candidates, 2, 0.7, similarity).length, 2)
    assert.equal(mmrSelect([{ id: 'a', relevance: 1 }], 5, 0.7, similarity).length, 1)
    assert.equal(mmrSelect([], 3, 0.7, similarity).length, 0)
  })

  test('returns each candidate at most once', () => {
    const picked = mmrSelect(candidates, 3, 0.5, similarity)
    assert.equal(new Set(picked).size, picked.length)
  })
})
