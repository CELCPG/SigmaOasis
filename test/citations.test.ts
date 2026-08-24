import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  citedIndices,
  danglingCitations,
  parseCitations,
  retrievedCitations,
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
