import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildResearchRevision,
  checkResearchGrounding,
  describeResearchGrounding,
  researchGroundingIsClean
} from '../src/main/ipc/researchGrounding'

/**
 * Deep research under the ladder (v1.9): the brief checked mechanically
 * against the passages it was synthesized from. These pin what counts as
 * unsupported, what must never be flagged (years, citations, roundings),
 * and that the revision text names exactly what to fix.
 */

const src = (index: number, ...texts: string[]) => ({ index, passages: texts.map((text) => ({ text })) })

describe('checkResearchGrounding · figures', () => {
  test('a figure present in a passage is supported; one absent is flagged', () => {
    const r = checkResearchGrounding(
      'The median price was $1,249.99 [1], and shipments rose 12.5% [2]. Analysts expect $2,000,000 next year.',
      [src(1, 'Median price: $1,249.99 across 400 listings.'), src(2, 'Shipments rose 12.5% year on year.')]
    )
    assert.deepEqual(r.figures, ['$2,000,000'])
    assert.deepEqual(r.badCitations, [])
  })

  test('years, citation numbers and list markers are never figures', () => {
    const r = checkResearchGrounding('In 2024 the rule changed [3]. 1. First point. 2. Second point.', [src(3, 'The rule changed.')])
    assert.deepEqual(r.figures, [])
    assert.deepEqual(r.badCitations, [])
  })

  test('a rounding of a passage figure passes; a different figure does not', () => {
    const r = checkResearchGrounding('About 28.1% of revenue [1], roughly 30 minutes [1], and 45 minutes [1].', [
      src(1, 'West accounts for 28.07% of revenue. Cool for 29.5 minutes.')
    ])
    assert.deepEqual(r.figures, [])
    assert.deepEqual(r.measurements, ['45 minutes'])
  })
})

describe('checkResearchGrounding · measurements and citations', () => {
  test('a dose or duration in no passage is flagged as a measurement', () => {
    const r = checkResearchGrounding('Take 500 mg every 6 hours [1]; cool the burn for 20 minutes [1].', [
      src(1, 'Adults may take 400 mg every 8 hours. Cool a burn for 20 minutes.')
    ])
    assert.deepEqual(r.measurements, ['500 mg', '6 hours'])
  })

  test('a citation to a source the run never read is a fabricated reference', () => {
    const r = checkResearchGrounding('Prices fell [1]. Demand rose [4].', [src(1, 'Prices fell.'), src(2, 'Other.')])
    assert.deepEqual(r.badCitations, [4])
    assert.deepEqual(r.sourceIndices, [1, 2])
  })

  test('a fully supported brief is clean', () => {
    const r = checkResearchGrounding('Cool the burn for 20 minutes under running water [1].', [src(1, 'Cool a burn under running water for 20 minutes.')])
    assert.equal(researchGroundingIsClean(r), true)
  })
})

describe('revision and disclosure', () => {
  test('the revision names each unsupported item and the valid citation range', () => {
    const r = checkResearchGrounding('Costs $9,999 [1]; takes 3 hours [7].', [src(1, 'Costs $99.'), src(2, 'x')])
    const rev = buildResearchRevision(r)
    assert.match(rev, /Citations to sources that do not exist: \[7\]\. Only \[1\], \[2\] exist/)
    assert.match(rev, /Measurements not in any source: 3 hours/)
    assert.match(rev, /Figures not in any source: \$9,999/)
    assert.match(rev, /Do not add new claims/)
  })

  test('the disclosure says all supported, revised-and-clean, or what still stands', () => {
    const clean = checkResearchGrounding('x [1]', [src(1, 'x')])
    assert.match(describeResearchGrounding({ before: clean, after: null, revised: false }), /All supported\./)
    const dirty = checkResearchGrounding('$5,000 [1]', [src(1, 'nothing numeric')])
    assert.match(describeResearchGrounding({ before: dirty, after: clean, revised: true }), /revised and the revision is fully supported/)
    const still = describeResearchGrounding({ before: dirty, after: dirty, revised: true })
    assert.match(still, /after one revision these still stand: figures \$5,000/)
    assert.match(still, /Present those as unverified/)
  })
})
