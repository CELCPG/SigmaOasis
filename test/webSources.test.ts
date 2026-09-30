import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  CITE_RESULTS_NOTE,
  highestWebSource,
  numberWebSources,
  sourceKey,
  webCitations
} from '../src/renderer/src/lib/webSources'
import { passagesHandedOver, renumberPassages, turnCitations } from '../src/renderer/src/lib/citations'
import { checkToolGrounding } from '../src/renderer/src/lib/toolGrounding'
import type { ToolCallRecord } from '../src/renderer/src/types'

/**
 * v4.1 (G3): the turn's web sources are numbered once for the whole turn, on
 * the library's sequence, and the dangling and wrong-source checks read them.
 * The outputs below are the handlers' own shapes (toolHandlers/web.ts).
 */

const SEARCH_A =
  '[untrusted]\n\nSearch results for "miami heat next game" via duckduckgo:\n\n' +
  '1. Miami Heat Schedule 2026-27 - ESPN\n   https://www.espn.com/nba/team/schedule/_/name/mia\n   Full schedule for the Miami Heat.\n\n' +
  '2. Heat vs Knicks preview\n   https://news.example/heat-knicks\n   Tip-off is 7:30 PM ET on Oct 21.'

const SEARCH_B =
  '[untrusted]\n\nSearch results for "heat knicks tickets" via duckduckgo:\n\n' +
  '1. Heat vs Knicks preview\n   https://news.example/heat-knicks/\n   Tip-off is 7:30 PM ET.\n\n' +
  '2. Tickets - Kaseya Center\n   https://kaseyacenter.example/events\n   Buy tickets.'

const PAGE =
  '[untrusted]\n\nPage: Heat vs Knicks: what to watch\nURL: https://news.example/heat-knicks\n' +
  'Showing 1 of the 4 passage(s)\n\n--- passage 1 · 10% into page · relevance 0.9 ---\n' +
  'The Heat open at home against the Knicks on October 21 at 7:30 PM ET.'

let seq = 0
function rec(name: string, args: Record<string, unknown>, result: string): ToolCallRecord {
  return { id: `r${++seq}`, name, args, status: 'done', result }
}

/** What the turn's hooks do: number against the records so far, then file the record. */
function run(records: ToolCallRecord[], name: string, args: Record<string, unknown>, output: string): string {
  const numbered = numberWebSources(name, args, output, records, passagesHandedOver(records))
  records.push(rec(name, args, numbered))
  return numbered
}

describe('numberWebSources', () => {
  test('a search is numbered [1]…[n] and told how to cite', () => {
    const records: ToolCallRecord[] = []
    const out = run(records, 'web_search', { query: 'q' }, SEARCH_A)
    assert.match(out, /^\[1\] Miami Heat Schedule/m)
    assert.match(out, /^\[2\] Heat vs Knicks preview\n {3}https:\/\/news\.example\/heat-knicks$/m)
    assert.ok(out.endsWith(CITE_RESULTS_NOTE))
    assert.match(CITE_RESULTS_NOTE, /snippet is a lead, not a source/)
  })

  test('a second search continues the sequence, and a URL keeps its first number', () => {
    const records: ToolCallRecord[] = []
    run(records, 'web_search', { query: 'a' }, SEARCH_A)
    const out = run(records, 'web_search', { query: 'b' }, SEARCH_B)
    // The trailing slash does not make a new source.
    assert.match(out, /^\[2\] Heat vs Knicks preview/m)
    assert.match(out, /^\[3\] Tickets - Kaseya Center/m)
    assert.equal(highestWebSource(records), 3)
  })

  test('a fetched page takes the number its search result had', () => {
    const records: ToolCallRecord[] = []
    run(records, 'web_search', { query: 'a' }, SEARCH_A)
    const out = run(records, 'fetch_webpage', { url: 'https://news.example/heat-knicks', query: 'tip-off' }, PAGE)
    assert.match(out, /^\[2\] Page: Heat vs Knicks: what to watch$/m)
    assert.match(out, /This page is source \[2\]/)
  })

  test('a page no search found gets the next number', () => {
    const records: ToolCallRecord[] = []
    run(records, 'web_search', { query: 'a' }, SEARCH_A)
    const out = run(records, 'fetch_webpage', { url: 'https://other.example/x' }, PAGE.replace('news.example/heat-knicks', 'other.example/x'))
    assert.match(out, /^\[3\] Page:/m)
  })

  test('the library and the web share one sequence, in either order', () => {
    const lookup = 'Reference passages for "x":\n\n[1] Finance › Standard deduction · 10% in\n    source: https://irs.gov/sd\n    relevance 0.8\nThe standard deduction is $15,000.'
    const records: ToolCallRecord[] = []
    run(records, 'web_search', { query: 'a' }, SEARCH_A)
    const renumbered = renumberPassages(lookup, passagesHandedOver(records))
    assert.match(renumbered, /^\[3\] Finance/m)
    records.push(rec('reference_lookup', { query: 'x' }, renumbered))
    const out = run(records, 'web_search', { query: 'b' }, SEARCH_B.replace('kaseyacenter.example/events', 'k.example/e'))
    assert.match(out, /^\[4\] Tickets/m)
  })

  test('other tools and failed or unnumberable output pass through untouched', () => {
    assert.equal(numberWebSources('reference_lookup', {}, SEARCH_A, [], 0), SEARCH_A)
    const empty = 'No results found for "x" (duckduckgo).'
    assert.equal(numberWebSources('web_search', {}, empty, [], 0), empty)
    const numberedPage = PAGE.replace('Page:', '[4] Page:')
    assert.equal(numberWebSources('fetch_webpage', {}, numberedPage, [], 0), numberedPage)
  })

  test('sourceKey folds scheme, www., trailing slash and fragment', () => {
    assert.equal(sourceKey('https://www.a.example/p/#x'), sourceKey('http://a.example/p'))
    assert.notEqual(sourceKey('https://a.example/p?id=1'), sourceKey('https://a.example/p?id=2'))
  })
})

describe('webCitations and the checks', () => {
  const records = (): ToolCallRecord[] => {
    const list: ToolCallRecord[] = []
    run(list, 'web_search', { query: 'a' }, SEARCH_A)
    run(list, 'fetch_webpage', { url: 'https://news.example/heat-knicks' }, PAGE)
    return list
  }

  test('a page stands for its number over the snippet', () => {
    const cites = webCitations(records())
    assert.deepEqual(cites.map((c) => c.index), [1, 2])
    assert.equal(cites[1].label, 'Heat vs Knicks: what to watch')
    assert.match(cites[1].text ?? '', /October 21 at 7:30 PM ET/)
    assert.equal(cites[0].href, 'https://www.espn.com/nba/team/schedule/_/name/mia')
  })

  test('turnCitations is the library and the web together', () => {
    const list = records()
    list.push(rec('reference_lookup', { query: 'x' }, '[3] Finance › SD · 1% in\n    relevance 0.5\ntext'))
    assert.deepEqual(turnCitations(list).map((c) => c.index), [1, 2, 3])
  })

  test('a web marker that names nothing is flagged; a real one is not', () => {
    const list = records()
    assert.equal(checkToolGrounding('The Heat play the Knicks on October 21 at 7:30 PM ET [2].', list, 'next heat game'), null)
    const report = checkToolGrounding('The Heat play the Knicks on October 21 [2]. Tickets start at $40 [7].', list, 'x')
    assert.deepEqual(report?.citations, ['[7]'])
  })

  test('a web marker labelled with another source is flagged', () => {
    const report = checkToolGrounding('Tip-off is 7:30 PM ET [1] (Heat vs Knicks: what to watch).', records(), 'x')
    assert.deepEqual(report?.attributions, ['[1] Heat vs Knicks: what to watch'])
  })

  test('with no web source numbered, a bare [1] is still nobody\'s business', () => {
    const unnumbered = [rec('web_search', { query: 'a' }, SEARCH_A)]
    assert.equal(checkToolGrounding('See the schedule [1].', unnumbered, 'x')?.citations, undefined)
  })
})
