import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  citedIndices,
  danglingCitations,
  parseCitations,
  passagesHandedOver,
  renumberPassages,
  retrievedCitations,
  turnLookups,
  webSource
} from '../src/renderer/src/lib/citations'
import type { ToolCallRecord } from '../src/renderer/src/types'

/**
 * Transcribed from a real run: "What's the standard deduction for a married
 * couple filing jointly … cite the source." The lookup returned two passages,
 * each carrying the locator that makes the citation followable, and the reply
 * came back with "[1]" and "[2]" resolving to nothing on screen.
 */
const LOOKUP = `Reference passages for "standard deduction married filing jointly" from the local library (keyword ranking), most relevant first. These are the user's own installed reference documents, not the live web: cite the bracketed number and the document when you use one.

[1] Personal finance & tax basics › Tax inflation adjustments for tax year 2025 › Notable changes for tax year 2025 · 10% in
    source: https://www.irs.gov/newsroom/irs-releases-tax-inflation-adjustments-for-tax-year-2025
    date: retrieved 2026-08-16
    license: Public domain (US federal work)
    relevance 1
For married couples filing jointly, the standard deduction rises to $30,000, an increase of $800 from tax year 2024.
[2] Personal finance & tax basics › Tax Topic 501 — Should I itemize? › Topic no. 501 · 0% in
    source: https://www.irs.gov/taxtopics/tc501
    date: retrieved 2026-08-16
    license: Public domain (US federal work)
    relevance 0.996
In general, individuals may take a standard deduction or itemize their deductions.`

function rec(result: string, name = 'reference_lookup', status: ToolCallRecord['status'] = 'done'): ToolCallRecord {
  return { id: `${name}-${result.length}`, name, args: {}, result, status }
}

describe('parseCitations', () => {
  test('recovers the number, the citation and the locator of each passage', () => {
    const [one, two] = parseCitations(LOOKUP)
    assert.equal(one.index, 1)
    assert.match(one.label, /^Personal finance & tax basics › Tax inflation adjustments/)
    assert.equal(
      one.href,
      'https://www.irs.gov/newsroom/irs-releases-tax-inflation-adjustments-for-tax-year-2025'
    )
    assert.equal(two.index, 2)
    assert.equal(two.href, 'https://www.irs.gov/taxtopics/tc501')
  })

  test('a folder pack\'s source is kept but never linkable — it is a path, not a page', () => {
    const [only] = parseCitations('[1] My documents › Lease · 4% in\n    source: /Users/me/docs/lease.pdf\n    relevance 1\ntext')
    assert.equal(only.source, '/Users/me/docs/lease.pdf')
    assert.equal(only.href, undefined)
  })

  test('a javascript: source never becomes a link', () => {
    const [only] = parseCitations('[1] Pack › Doc · 1% in\n    source: javascript:alert(1)\n    relevance 1\nx')
    assert.equal(only.href, undefined)
    assert.equal(webSource('javascript:alert(1)'), undefined)
  })

  test('no passages, nothing to cite', () => {
    assert.deepEqual(parseCitations('No reference passages found for "x".'), [])
  })

  // v1.17.2: the strip is built from this parse, so the parse has to recover
  // everything the strip shows — not just what an inline marker needs.
  test('the relevance and the passage\'s own words come back too', () => {
    const [one, two] = parseCitations(LOOKUP)
    assert.equal(one.score, 1)
    assert.equal(one.text, 'For married couples filing jointly, the standard deduction rises to $30,000, an increase of $800 from tax year 2024.')
    assert.equal(two.score, 0.996)
    assert.equal(two.text, 'In general, individuals may take a standard deduction or itemize their deductions.')
  })

  test('a block cut off by the output cap yields no score and no text, never a wrong one', () => {
    const [only] = parseCitations('[1] Pack › Doc · 1% in\n    source: https://example.com/a\n    dat')
    assert.equal(only.index, 1)
    assert.equal(only.score, undefined)
    assert.equal(only.text, undefined)
  })

  test('the notes formatLookup appends after the last passage are not part of it', () => {
    const withNotes = `${LOOKUP}\n\nNote: one pack was skipped.\nNote: embeddings are stale.`
    const [, two] = parseCitations(withNotes)
    assert.equal(two.text, 'In general, individuals may take a standard deduction or itemize their deductions.')
  })
})

describe('turnLookups', () => {
  test('each lookup keeps its own passages, in the order the turn ran them', () => {
    const second = '[3] Other pack › Other doc · 2% in\n    source: https://example.com/a\n    relevance 1\ntext'
    const lookups = turnLookups([
      { id: 'a', name: 'reference_lookup', args: { query: 'deduction' }, status: 'done', result: LOOKUP },
      { id: 'b', name: 'reference_lookup', args: { query: 'itemizing' }, status: 'done', result: second }
    ])
    assert.deepEqual(lookups.map((l) => l.query), ['deduction', 'itemizing'])
    assert.deepEqual(lookups.map((l) => l.passages.map((p) => p.index)), [[1, 2], [3]])
  })

  test('a number claimed twice is listed under the lookup that claimed it first', () => {
    const lookups = turnLookups([rec(LOOKUP), rec(LOOKUP)])
    assert.equal(lookups.length, 1)
    assert.deepEqual(lookups[0].passages.map((p) => p.index), [1, 2])
  })

  test('an unfinished lookup, another tool, and an empty result contribute nothing', () => {
    assert.deepEqual(turnLookups([rec(LOOKUP, 'reference_lookup', 'error')]), [])
    assert.deepEqual(turnLookups([rec(LOOKUP, 'web_search')]), [])
    assert.deepEqual(turnLookups([rec('No reference passages found for "x".')]), [])
  })
})

describe('retrievedCitations', () => {
  test('only a finished reference_lookup counts', () => {
    assert.deepEqual(retrievedCitations([rec(LOOKUP, 'reference_lookup', 'error')]), [])
    assert.deepEqual(retrievedCitations([rec(LOOKUP, 'web_search')]), [])
    assert.equal(retrievedCitations([rec(LOOKUP)]).length, 2)
  })

  test('two lookups both number from [1]; the first to claim a number keeps it', () => {
    const second = '[1] Other pack › Other doc · 2% in\n    source: https://example.com/a\n    relevance 1\ntext\n[3] Other pack › Third · 5% in\n    relevance 0.5\nmore'
    const merged = retrievedCitations([rec(LOOKUP), rec(second)])
    assert.deepEqual(merged.map((c) => c.index), [1, 2, 3])
    assert.match(merged[0].label, /^Personal finance/)
  })
})

describe('passagesHandedOver', () => {
  test('the highest number this turn has already given the model', () => {
    assert.equal(passagesHandedOver([]), 0)
    assert.equal(passagesHandedOver([rec(LOOKUP)]), 2)
  })

  test('an unfinished lookup, or another tool, has handed over nothing', () => {
    assert.equal(passagesHandedOver([rec(LOOKUP, 'reference_lookup', 'error')]), 0)
    assert.equal(passagesHandedOver([rec(LOOKUP, 'web_search')]), 0)
  })
})

describe('renumberPassages', () => {
  test('the turn\'s second lookup continues where the first stopped', () => {
    const shifted = renumberPassages(LOOKUP, 2)
    assert.deepEqual(parseCitations(shifted).map((c) => c.index), [3, 4])
    assert.match(shifted, /^\[3\] Personal finance & tax basics › Tax inflation adjustments/m)
    // The passages themselves are untouched — only their numbers move.
    assert.match(shifted, /the standard deduction rises to \$30,000/)
  })

  test('the head says the numbering continues, so the model does not reset it', () => {
    assert.match(renumberPassages(LOOKUP, 5), /already handed you 5 numbered passages, so these continue from \[6\]/)
    assert.match(renumberPassages(LOOKUP, 1), /handed you 1 numbered passage, so/)
  })

  test('the turn\'s first lookup is left byte-identical', () => {
    assert.equal(renumberPassages(LOOKUP, 0), LOOKUP)
  })

  test('a lookup that found nothing has no numbering to continue', () => {
    const empty = 'No reference passages found for "x".\nSay plainly that the library has nothing on this.'
    assert.equal(renumberPassages(empty, 4), empty)
  })
})

describe('citedIndices', () => {
  test('the markers a reply actually used', () => {
    assert.deepEqual(citedIndices('The deduction is $30,000 [1]. As the IRS states [2].'), [1, 2])
  })

  test('array indexing in code is not a citation', () => {
    const answer = 'Here:\n\n```python\nvalues[1] = totals[2]\n```\n\nand `rows[3]` inline.'
    assert.deepEqual(citedIndices(answer), [])
  })

  test('a markdown link is not a citation marker', () => {
    assert.deepEqual(citedIndices('see [1](https://example.com) for more'), [])
  })

  /**
   * v1.17.2. Measured (judge-r7/V2/run-1): the reply wrote "[2][5]" and the
   * app saw only the [2] — the guard that keeps `m[0][1]` out of the count
   * refused any marker sitting after a `]`, whichever `]` it was. The strip
   * then stated that the passage the reply had just cited went uncited.
   */
  test('markers written together are two citations, not one', () => {
    assert.deepEqual(citedIndices('adjusts each year (Topic no. 551) [2][5].'), [2, 5])
    assert.deepEqual(citedIndices('all three [1][2][3] agree'), [1, 2, 3])
  })

  test('array indexing is still not a citation, adjacent or not', () => {
    // The run starts after a word character, so the whole run is refused.
    assert.deepEqual(citedIndices('`m[0][1]` is a cell'), [])
    assert.deepEqual(citedIndices('Read m[0][1] from the matrix.'), [])
    // …and one whose run starts after some other bracket expression too.
    assert.deepEqual(citedIndices('Read arr[i][1] from the matrix.'), [])
  })

  test('a run that ends in a markdown link keeps the link out of the count', () => {
    assert.deepEqual(citedIndices('see [2][5](https://example.com)'), [2])
  })
})

describe('danglingCitations', () => {
  test('a marker naming no retrieved passage is a finding', () => {
    const retrieved = retrievedCitations([rec(LOOKUP)])
    assert.deepEqual(danglingCitations('It is $30,000 [1], per Publication 17 [3].', retrieved), ['[3]'])
  })

  test('markers that name retrieved passages are not', () => {
    const retrieved = retrievedCitations([rec(LOOKUP)])
    assert.deepEqual(danglingCitations('$30,000 [1]; itemizing [2].', retrieved), [])
  })

  test('with nothing retrieved the check stays silent — a bare [1] is the model\'s own footnote', () => {
    assert.deepEqual(danglingCitations('as noted [1]', []), [])
  })
})
