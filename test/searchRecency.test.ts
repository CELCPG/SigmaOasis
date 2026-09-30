import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { load, state, resetState } from './harness'

const search = load<typeof import('../src/main/ipc/search')>('search')
const web = load<typeof import('../src/main/ipc/toolHandlers/web')>('toolHandlers/web')

/**
 * v4.1 (G2c): a live question asks each provider for recent results, by the
 * provider's own parameter, and a filter that empties the page is dropped.
 */

const ONE_RESULT = `
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnews.example%2Fheat">Heat beat Knicks</a>
    <a class="result__snippet" href="x">Miami won 112-104 last night.</a>
  </div>`

beforeEach(() => {
  resetState()
  search.clearSearchCache()
})

describe('providerSearchUrl · each provider by its own name', () => {
  test('SearXNG time_range, Brave freshness, DuckDuckGo df', () => {
    assert.match(search.providerSearchUrl('searxng', 'q', 8, 'day', 'https://sx.local'), /&time_range=day$/)
    assert.match(search.providerSearchUrl('brave', 'q', 8, 'week'), /&freshness=pw$/)
    assert.match(search.providerSearchUrl('duckduckgo', 'q', 8, 'month'), /&df=m$/)
    assert.match(search.providerSearchUrl('duckduckgo', 'q', 8, 'year'), /&df=y$/)
  })

  test('no recency, no parameter — the 4.0 URLs byte for byte', () => {
    assert.equal(search.providerSearchUrl('duckduckgo', 'a b', 8), 'https://html.duckduckgo.com/html/?q=a%20b')
    assert.equal(
      search.providerSearchUrl('brave', 'a b', 8),
      'https://api.search.brave.com/res/v1/web/search?q=a%20b&count=8'
    )
    assert.equal(search.providerSearchUrl('searxng', 'a b', 8, undefined, 'https://sx'), 'https://sx/search?q=a%20b&format=json')
  })
})

describe('runWebSearch · recency', () => {
  test('the filter goes on the wire and is reported back', async () => {
    state.searchHtml = ONE_RESULT
    const out = await search.runWebSearch('miami heat score', undefined, { recency: 'day' })
    assert.equal(out.ok, true)
    assert.equal(out.recency, 'day')
    assert.ok(state.fetchLog.some((f) => f.url.includes('&df=d')))
  })

  test('a filter that empties the page is asked once more without it', async () => {
    state.searchRoutes = [{ match: '&df=d', html: '<html></html>' }]
    state.searchHtml = ONE_RESULT
    const out = await search.runWebSearch('miami heat score', undefined, { recency: 'day' })
    assert.equal(out.results.length, 1)
    assert.equal(out.recency, undefined, 'the results were not filtered, so the outcome must not say they were')
    assert.equal(state.fetchLog.filter((f) => f.purpose === 'search').length, 2)
  })

  test('an unknown recency is ignored, never sent', async () => {
    state.searchHtml = ONE_RESULT
    await search.runWebSearch('miami heat score', undefined, { recency: 'decade' as never })
    assert.ok(!state.fetchLog.some((f) => f.url.includes('&df=')))
  })

  test('the cache keeps filtered and unfiltered results apart', async () => {
    state.searchHtml = ONE_RESULT
    await search.runWebSearch('miami heat score', undefined, { recency: 'week' })
    const plain = await search.runWebSearch('miami heat score')
    assert.equal(plain.cached, false)
  })

  test('the tool reads the app-only argument and says what it did', async () => {
    state.searchHtml = ONE_RESULT
    const out = await web.webHandlers.web_search({ query: 'miami heat score', recency: 'day' }, { sender: {} } as never)
    assert.equal(out.ok, true)
    assert.match(out.output ?? '', /past day only/)
  })
})
