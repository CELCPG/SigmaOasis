import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { load, state, resetState, fakeImageBytes } from './harness'

const search = load<typeof import('../src/main/ipc/search')>('search')
const researchIndex = load<typeof import('../src/main/ipc/researchIndex')>('researchIndex')

type Settings = {
  workingDirectory: string
  search: { provider: string; maxResults: number; confirmBeforeSearch: boolean }
}
const settings = (): Settings => state.settings as unknown as Settings

/** Run a query through the real pipeline and report what would have been sent. */
async function sanitized(query: string): Promise<{ sent: string; redactions: string[] }> {
  state.searchHtml = '<html></html>'
  const out = await search.runWebSearch(query)
  return { sent: out.sentQuery, redactions: out.redactions }
}

beforeEach(() => {
  resetState()
  search.clearSearchCache()
  researchIndex.clearResearchIndex()
})

describe('sanitizeQuery (via runWebSearch)', () => {
  test('leaves ordinary URL-ish paths alone (the v0.6 false positive)', async () => {
    const { sent } = await sanitized('react router /docs/api/reference guide')
    assert.equal(sent, 'react router /docs/api/reference guide')
  })

  test('leaves a pasted URL intact', async () => {
    const { sent } = await sanitized('what does https://example.com/a/b/c say')
    assert.ok(sent.includes('https://example.com/a/b/c'))
  })

  test('does not redact a one-segment web route', async () => {
    const { sent } = await sanitized('why does /home/dashboard 404')
    assert.ok(sent.includes('/home/dashboard'))
  })

  test('redacts a home-rooted filesystem path', async () => {
    const { sent, redactions } = await sanitized('error in /Users/someone/Documents/secret.txt')
    assert.ok(!sent.includes('secret.txt'))
    assert.ok(redactions.length > 0)
  })

  test('redacts a tilde path', async () => {
    const { sent } = await sanitized('open ~/Documents/private/notes.md')
    assert.ok(!sent.includes('notes.md'))
  })

  test('redacts a system path', async () => {
    const { sent } = await sanitized('permissions on /etc/passwd')
    assert.ok(!sent.includes('/etc/passwd'))
  })

  test('redacts a Windows path', async () => {
    const { sent } = await sanitized('cannot open C:\\Users\\colin\\notes.txt')
    assert.ok(!sent.includes('notes.txt'))
  })

  test('redacts the configured working directory by exact match', async () => {
    settings().workingDirectory = '/srv/projects/AcmeApp'
    const { sent, redactions } = await sanitized('build fails in /srv/projects/AcmeApp/src/main')
    assert.ok(!sent.includes('AcmeApp'))
    assert.ok(redactions.includes('local path'))
  })

  test('redacts emails, tokens, JWTs and private IPs', async () => {
    assert.ok(!(await sanitized('contact bob@example.com')).sent.includes('@example.com'))
    assert.ok(
      !(await sanitized('why is sk-abcdefghij0123456789 rejected')).sent.includes('abcdefghij')
    )
    assert.ok(
      !(await sanitized('decode eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdef')).sent.includes(
        'eyJhbGciOiJIUzI1NiJ9'
      )
    )
    assert.ok(!(await sanitized('cannot reach 192.168.1.50')).sent.includes('192.168.1.50'))
  })

  test('caps query length', async () => {
    assert.ok((await sanitized('word '.repeat(200))).sent.length <= 400)
  })

  test('an empty query is refused rather than sent', async () => {
    const out = await search.runWebSearch('   ')
    assert.equal(out.ok, false)
    assert.equal(state.fetchLog.length, 0)
  })
})

describe('searchDuckDuckGo parsing', () => {
  // Result 2 has no snippet. The v0.6 code zipped two independent match lists,
  // so result 3's snippet was attributed to result 2 — and every one after it
  // shifted too, describing real URLs with another result's text.
  const html = `
    <div class="result results_links">
      <a rel="nofollow" class="result__a js-result-title-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Falpha.example%2Fone">Alpha Title</a>
      <a class="result__snippet" href="x">Alpha snippet text</a>
    </div>
    <div class="result results_links">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbeta.example%2Ftwo">Beta Title</a>
    </div>
    <div class="result results_links">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgamma.example%2Fthree">Gamma <b>Title</b></a>
      <a class="result__snippet" href="y">Gamma snippet &amp; more</a>
    </div>`

  test('parses every result and unwraps redirect URLs', async () => {
    state.searchHtml = html
    const out = await search.runWebSearch('test')
    assert.equal(out.results.length, 3)
    assert.equal(out.results[0].url, 'https://alpha.example/one')
  })

  test('a snippetless result gets no snippet, not the next one', async () => {
    state.searchHtml = html
    const out = await search.runWebSearch('test')
    assert.equal(out.results[0].snippet, 'Alpha snippet text')
    assert.equal(out.results[1].snippet, '')
    assert.equal(out.results[2].snippet, 'Gamma snippet & more')
  })

  test('handles variable class lists and strips inline tags from titles', async () => {
    state.searchHtml = html
    const out = await search.runWebSearch('test')
    assert.equal(out.results[0].title, 'Alpha Title')
    assert.equal(out.results[2].title, 'Gamma Title')
  })

  test('honors maxResults', async () => {
    state.searchHtml = html
    settings().search.maxResults = 2
    assert.equal((await search.runWebSearch('test')).results.length, 2)
  })

  test('skips non-http result URLs', async () => {
    state.searchHtml =
      '<div class="result"><a class="result__a" href="javascript:alert(1)">Bad</a></div>' +
      '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fok.example%2F">Good</a></div>'
    const out = await search.runWebSearch('test')
    assert.equal(out.results.length, 1)
    assert.equal(out.results[0].url, 'https://ok.example/')
  })
})

describe('search response cache', () => {
  const html =
    '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2F">A</a>' +
    '<a class="result__snippet">snippet</a></div>'

  test('a repeated query is served locally without re-contacting the provider', async () => {
    state.searchHtml = html
    const first = await search.runWebSearch('same query')
    const searchesAfterFirst = state.fetchLog.filter((f) => f.purpose === 'search').length
    const second = await search.runWebSearch('same query')

    assert.equal(first.cached, false)
    assert.equal(second.cached, true)
    assert.deepEqual(second.results, first.results)
    assert.equal(state.fetchLog.filter((f) => f.purpose === 'search').length, searchesAfterFirst)
  })

  test('the cache is case-insensitive on the query', async () => {
    state.searchHtml = html
    await search.runWebSearch('Same Query')
    assert.equal((await search.runWebSearch('same query')).cached, true)
  })

  test('a different query is not served from cache', async () => {
    state.searchHtml = html
    await search.runWebSearch('first query')
    assert.equal((await search.runWebSearch('second query')).cached, false)
  })

  test('changing maxResults bypasses the cache', async () => {
    state.searchHtml = html
    await search.runWebSearch('a query')
    settings().search.maxResults = 3
    assert.equal((await search.runWebSearch('a query')).cached, false)
  })

  test('an empty result set is not cached, so a transient miss is not sticky', async () => {
    state.searchHtml = '<html></html>'
    await search.runWebSearch('nothing matches')
    state.searchHtml = html
    const retry = await search.runWebSearch('nothing matches')
    assert.equal(retry.cached, false)
    assert.equal(retry.results.length, 1)
  })

  test('a cache hit skips the confirmation prompt, since nothing is sent', async () => {
    state.searchHtml = html
    settings().search.confirmBeforeSearch = true
    let prompts = 0
    const confirm = async (): Promise<boolean> => {
      prompts += 1
      return true
    }
    await search.runWebSearch('confirmed query', confirm)
    await search.runWebSearch('confirmed query', confirm)
    assert.equal(prompts, 1)
  })

  test('declining the confirmation sends nothing and caches nothing', async () => {
    state.searchHtml = html
    settings().search.confirmBeforeSearch = true
    const out = await search.runWebSearch('declined query', async () => false)
    assert.equal(out.ok, false)
    assert.equal(state.fetchLog.filter((f) => f.purpose === 'search').length, 0)
    assert.equal(search.searchCacheSize(), 0)
  })

  test('clearing empties the cache', async () => {
    state.searchHtml = html
    await search.runWebSearch('a query')
    assert.ok(search.searchCacheSize() > 0)
    search.clearSearchCache()
    assert.equal(search.searchCacheSize(), 0)
  })
})

describe('readWebpage', () => {
  const article =
    '<html><head><title>Handbook</title></head><body><article>' +
    '<p>Introduction. This document describes the hiring process at a fictional firm.</p>' +
    '<p>Chapter 1. The interview loop has four stages and takes about two weeks.</p>' +
    '<p>Chapter 2. Remuneration is reviewed annually every March by the committee.</p>' +
    '<p>Chapter 3. Office locations include three sites with no parking facilities.</p>' +
    '<p>Chapter 4. Cache invalidation for the internal directory is write-through.</p>' +
    '<p>See <a href="/appendix">the appendix</a> for detail.</p>' +
    '</article></body></html>'

  beforeEach(() => {
    state.responses = [
      { match: 'example.com/handbook', contentType: 'text/html', body: article }
    ]
  })

  test('returns whole-page text when no query is given', async () => {
    const out = await search.readWebpage('https://example.com/handbook', '', 5)
    assert.ok(out.ok)
    assert.ok(out.text!.includes('Introduction'))
    assert.equal(out.retrieval, undefined)
  })

  test('returns ranked passages when a query is given', async () => {
    const out = await search.readWebpage('https://example.com/handbook', 'salary review', 2)
    assert.ok(out.ok)
    assert.ok(out.retrieval)
    assert.equal(out.retrieval!.mode, 'hybrid')
    // "Remuneration" shares no vocabulary with "salary" — only the embedding
    // can bridge that, so this asserts hybrid retrieval is really engaged.
    assert.ok(out.retrieval!.passages.some((p) => p.text.includes('Remuneration')))
  })

  test('surfaces outbound links so a citation can be followed', async () => {
    const out = await search.readWebpage('https://example.com/handbook', '', 5)
    assert.ok(out.links.some((l) => l.url === 'https://example.com/appendix'))
  })

  test('reports that a main container was found', async () => {
    const out = await search.readWebpage('https://example.com/handbook', '', 5)
    assert.equal(out.mainContentFound, true)
    assert.equal(out.kind, 'html')
  })

  test('a second read of the same URL makes no new network request', async () => {
    await search.readWebpage('https://example.com/handbook', 'salary', 2)
    const after = state.fetchLog.filter((f) => f.purpose === 'webpage').length
    const second = await search.readWebpage('https://example.com/handbook', 'parking', 2)
    assert.equal(second.cached, true)
    assert.equal(state.fetchLog.filter((f) => f.purpose === 'webpage').length, after)
  })

  test('chunk vectors are reused across queries — only the query is embedded', async () => {
    await search.readWebpage('https://example.com/handbook', 'salary', 2)
    const embedsAfterFirst = state.embedCalls
    await search.readWebpage('https://example.com/handbook', 'parking', 2)
    assert.equal(state.embedCalls, embedsAfterFirst + 1)
  })

  test('degrades to keyword ranking when embeddings are unavailable', async () => {
    state.failEmbeddings = true
    const out = await search.readWebpage('https://example.com/handbook', 'cache invalidation', 2)
    assert.equal(out.retrieval!.mode, 'keyword')
    assert.ok(out.retrieval!.passages.some((p) => p.text.includes('Cache invalidation')))
    assert.ok(out.retrieval!.notes.some((n) => /embeddings unavailable/i.test(n)))
  })

  test('refuses a non-HTTPS URL', async () => {
    const out = await search.readWebpage('http://example.com/handbook', '', 5)
    assert.equal(out.ok, false)
    assert.match(out.error!, /only HTTPS/i)
  })

  test('refuses an unparseable URL', async () => {
    assert.equal((await search.readWebpage('not a url', '', 5)).ok, false)
  })

  test('extracts a PDF served over HTTPS', async () => {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    state.responses = [
      {
        match: 'example.com/paper.pdf',
        contentType: 'application/pdf',
        body: readFileSync(join(__dirname, '..', '..', 'test/fixtures/chromium-sample.pdf'))
      }
    ]
    const out = await search.readWebpage('https://example.com/paper.pdf', 'retry timeout', 3)
    assert.ok(out.ok, out.error)
    assert.equal(out.kind, 'pdf')
    assert.ok(out.retrieval!.passages.some((p) => p.text.includes('retry timeout')))
  })

  test('refuses an unsupported content type', async () => {
    state.responses = [
      { match: 'example.com/thing.zip', contentType: 'application/zip', body: 'PK\u0003\u0004' }
    ]
    const out = await search.readWebpage('https://example.com/thing.zip', '', 5)
    assert.equal(out.ok, false)
    assert.match(out.error!, /unsupported content type/i)
  })
})

describe('research index', () => {
  const text = Array.from({ length: 8 }, (_, i) => `Paragraph ${i} about caching and retries.`).join(
    '\n\n'
  )

  test('pageCacheKey ignores the fragment but keeps the query string', () => {
    assert.equal(
      researchIndex.pageCacheKey('https://a.com/x#frag'),
      researchIndex.pageCacheKey('https://a.com/x')
    )
    assert.ok(researchIndex.pageCacheKey('https://a.com/x?q=1').includes('q=1'))
  })

  test('pageCacheKey normalizes a bare-root trailing slash', () => {
    assert.equal(
      researchIndex.pageCacheKey('https://a.com/'),
      researchIndex.pageCacheKey('https://a.com')
    )
  })

  test('stats reflect indexed content and clear empties it', () => {
    researchIndex.indexPage({ key: 'k1', url: 'u1', title: 't', text, truncated: false })
    const stats = researchIndex.researchIndexStats()
    assert.equal(stats.pages, 1)
    assert.ok(stats.chunks > 0)
    assert.ok(stats.chars > 0)
    assert.equal(researchIndex.clearResearchIndex().pages, 1)
    assert.equal(researchIndex.researchIndexStats().pages, 0)
  })

  test('enforces the page cap, evicting least-recently-used first', () => {
    for (let i = 0; i < 40; i++) {
      researchIndex.indexPage({ key: `p${i}`, url: `u${i}`, title: 't', text, truncated: false })
    }
    assert.ok(researchIndex.researchIndexStats().pages <= 32)
    assert.equal(researchIndex.getIndexedPage('p0'), null)
    assert.ok(researchIndex.getIndexedPage('p39') !== null)
  })

  test('an empty page yields no passages and does not throw', async () => {
    const page = researchIndex.indexPage({
      key: 'empty', url: 'u', title: 't', text: '   ', truncated: false
    })
    const out = await researchIndex.retrievePassages(page, 'anything', 3)
    assert.equal(out.passages.length, 0)
    assert.equal(out.totalChunks, 0)
  })

  test('falls back to the head of the page when nothing matches', async () => {
    state.failEmbeddings = true
    const page = researchIndex.indexPage({
      key: 'p', url: 'u', title: 't', text, truncated: false
    })
    const out = await researchIndex.retrievePassages(page, 'zzzz nonexistent', 2)
    assert.ok(out.passages.length > 0)
    assert.ok(out.notes.some((n) => /No passage matched/i.test(n)))
  })

  test('passages come back in reading order with scores in range', async () => {
    const page = researchIndex.indexPage({
      key: 'p', url: 'u', title: 't', text, truncated: false
    })
    const out = await researchIndex.retrievePassages(page, 'caching retries', 3)
    out.passages.forEach((p, i) => {
      assert.ok(p.position >= 0 && p.position <= 1)
      assert.ok(p.score >= 0 && p.score <= 1)
      if (i > 0) assert.ok(p.position >= out.passages[i - 1].position)
    })
  })
})

describe('SSRF guard (fetchWebpage)', () => {
  const page = '<html><body><p>' + 'text '.repeat(200) + '</p></body></html>'

  test('refuses a host resolving to a private address', async () => {
    state.dnsOverrides['internal.example'] = [{ address: '10.0.0.5', family: 4 }]
    state.responses = [{ match: 'internal.example', contentType: 'text/html', body: page }]
    const out = await search.readWebpage('https://internal.example/secret', '', 5)
    assert.equal(out.ok, false)
    assert.match(out.error!, /private or reserved/i)
  })

  test('refuses the cloud metadata endpoint', async () => {
    // 169.254.169.254 is the single most valuable SSRF target on a cloud host.
    state.dnsOverrides['metadata.example'] = [{ address: '169.254.169.254', family: 4 }]
    const out = await search.readWebpage('https://metadata.example/latest/meta-data', '', 5)
    assert.equal(out.ok, false)
    assert.match(out.error!, /private or reserved/i)
  })

  test('refuses a loopback-resolving host, including the LM Studio server', async () => {
    state.dnsOverrides['local.example'] = [{ address: '127.0.0.1', family: 4 }]
    const out = await search.readWebpage('https://local.example/v1/models', '', 5)
    assert.equal(out.ok, false)
    assert.match(out.error!, /private or reserved/i)
  })

  test('refuses a host that resolves to a private IPv6 address', async () => {
    state.dnsOverrides['v6.example'] = [{ address: 'fd00::1', family: 6 }]
    const out = await search.readWebpage('https://v6.example/x', '', 5)
    assert.equal(out.ok, false)
  })

  test('refuses when any answer is private, not just the first', async () => {
    // A split-horizon answer must not be admitted because one record is public.
    state.dnsOverrides['mixed.example'] = [
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.10', family: 4 }
    ]
    const out = await search.readWebpage('https://mixed.example/x', '', 5)
    assert.equal(out.ok, false)
  })

  test('reports an unresolvable host', async () => {
    state.dnsFailures = ['nowhere.example']
    const out = await search.readWebpage('https://nowhere.example/x', '', 5)
    assert.equal(out.ok, false)
    assert.match(out.error!, /could not resolve/i)
  })

  test('re-checks the guard on a redirect, refusing a hop to an internal host', async () => {
    // The reason redirects are followed manually: a public URL may redirect
    // inward, and the check has to run again on every hop.
    state.dnsOverrides['inside.example'] = [{ address: '10.1.2.3', family: 4 }]
    state.responses = [
      {
        match: 'public.example',
        contentType: 'text/html',
        body: '',
        status: 302,
        headers: { location: 'https://inside.example/admin' }
      },
      { match: 'inside.example', contentType: 'text/html', body: page }
    ]
    const out = await search.readWebpage('https://public.example/start', '', 5)
    assert.equal(out.ok, false)
    assert.match(out.error!, /private or reserved/i)
  })

  test('follows a redirect to another public host', async () => {
    state.responses = [
      {
        match: 'first.example',
        contentType: 'text/html',
        body: '',
        status: 302,
        headers: { location: 'https://second.example/final' }
      },
      { match: 'second.example', contentType: 'text/html', body: page }
    ]
    const out = await search.readWebpage('https://first.example/start', '', 5)
    assert.equal(out.ok, true, out.error)
    assert.equal(out.url, 'https://second.example/final')
  })

  test('refuses a redirect to a non-HTTPS URL', async () => {
    state.responses = [
      {
        match: 'downgrade.example',
        contentType: 'text/html',
        body: '',
        status: 302,
        headers: { location: 'http://plain.example/x' }
      }
    ]
    const out = await search.readWebpage('https://downgrade.example/start', '', 5)
    assert.equal(out.ok, false)
    assert.match(out.error!, /non-HTTPS/i)
  })

  test('stops a redirect loop rather than following it forever', async () => {
    state.responses = [
      {
        match: 'loop.example',
        contentType: 'text/html',
        body: '',
        status: 302,
        headers: { location: 'https://loop.example/again' }
      }
    ]
    const out = await search.readWebpage('https://loop.example/start', '', 5)
    assert.equal(out.ok, false)
    assert.match(out.error!, /too many redirects/i)
  })
})

describe('runImageSearch', () => {
  test('SearXNG results map to image, thumbnail and page URLs', async () => {
    settings().search.provider = 'searxng'
    state.searxngJson = {
      results: [
        {
          title: 'Pet stroller',
          url: 'https://shop.example/stroller',
          img_src: 'https://cdn.example/full.jpg',
          thumbnail_src: 'https://cdn.example/thumb.jpg'
        }
      ]
    }
    const out = await search.runImageSearch('all-terrain pet stroller')
    assert.equal(out.ok, true)
    assert.deepEqual(out.images, [
      {
        title: 'Pet stroller',
        imageUrl: 'https://cdn.example/full.jpg',
        thumbnailUrl: 'https://cdn.example/thumb.jpg',
        pageUrl: 'https://shop.example/stroller'
      }
    ])
  })

  test('protocol-relative provider URLs are given a scheme', async () => {
    settings().search.provider = 'searxng'
    state.searxngJson = {
      results: [{ title: 'x', url: 'https://page.example/a', img_src: '//cdn.example/i.jpg' }]
    }
    const out = await search.runImageSearch('x')
    assert.equal(out.images[0].imageUrl, 'https://cdn.example/i.jpg')
    // An absent thumbnail stays absent rather than becoming "https:undefined".
    assert.equal(out.images[0].thumbnailUrl, undefined)
  })

  test('results without an image or a page URL are dropped', async () => {
    settings().search.provider = 'searxng'
    state.searxngJson = {
      results: [
        { title: 'no image', url: 'https://page.example/a' },
        { title: 'no page', img_src: 'https://cdn.example/b.jpg' },
        { title: 'good', url: 'https://page.example/c', img_src: 'https://cdn.example/c.jpg' }
      ]
    }
    const out = await search.runImageSearch('x')
    assert.equal(out.images.length, 1)
    assert.equal(out.images[0].title, 'good')
  })

  test('the query is sanitized before it leaves, exactly as web search is', async () => {
    settings().search.provider = 'searxng'
    state.searxngJson = { results: [] }
    const out = await search.runImageSearch('pictures of a boat email me@example.com')
    assert.ok(!out.sentQuery.includes('me@example.com'))
    assert.ok(out.redactions.length > 0)
  })

  test('an empty query never reaches the provider', async () => {
    settings().search.provider = 'searxng'
    const out = await search.runImageSearch('   ')
    assert.equal(out.ok, false)
    assert.equal(state.fetchLog.length, 0)
  })

  test('a declined confirmation sends nothing', async () => {
    settings().search.provider = 'searxng'
    settings().search.confirmBeforeSearch = true
    const out = await search.runImageSearch('boats', 6, async () => false)
    assert.equal(out.ok, false)
    assert.match(out.error!, /declined/i)
    assert.equal(state.fetchLog.length, 0)
  })

  test('more images than MAX_IMAGE_RESULTS are never requested', async () => {
    // The cap is a privacy budget: every extra result is another third-party
    // host contacted. Asking for more and discarding the surplus spends the
    // user's quota to produce nothing.
    settings().search.provider = 'searxng'
    state.searxngJson = {
      results: Array.from({ length: 20 }, (_, i) => ({
        title: `i${i}`,
        url: `https://page.example/${i}`,
        img_src: `https://cdn.example/${i}.jpg`
      }))
    }
    const out = await search.runImageSearch('x', 50)
    assert.equal(out.images.length, search.MAX_IMAGE_RESULTS)
    assert.equal(search.MAX_IMAGE_RESULTS, 6)
  })

  test('Brave without a key refuses rather than falling back to another provider', async () => {
    // The provider the user chose is the only one that may see the query.
    // Silently reaching for a different one would send it somewhere they did
    // not pick — so a missing key has to fail, visibly.
    settings().search.provider = 'brave'
    const out = await search.runImageSearch('laptop')
    assert.equal(out.ok, false)
    assert.match(out.error!, /Brave Search API key/i)
    assert.equal(state.fetchLog.length, 0)
  })

  test('DuckDuckGo images refuse to guess when no vqd token is issued', async () => {
    settings().search.provider = 'duckduckgo'
    state.searchHtml = '<html>no token here</html>'
    const out = await search.runImageSearch('boats')
    assert.equal(out.ok, false)
    assert.match(out.error!, /token/i)
  })

  test('DuckDuckGo images parse the i.js feed once a token is found', async () => {
    settings().search.provider = 'duckduckgo'
    state.searchRoutes = [
      { match: 'i.js', html: JSON.stringify({
        results: [
          {
            title: 'Boat',
            image: 'https://cdn.example/boat.jpg',
            thumbnail: 'https://cdn.example/boat-t.jpg',
            url: 'https://page.example/boat'
          }
        ]
      }) },
      { match: 'duckduckgo.com/?q=', html: '<script>vqd="4-12345"</script>' }
    ]
    const out = await search.runImageSearch('boats')
    assert.equal(out.ok, true)
    assert.equal(out.images.length, 1)
    assert.equal(out.images[0].pageUrl, 'https://page.example/boat')
  })
})

describe('fetchImageDataUrl', () => {
  const jpeg = 'image/jpeg'

  test('returns a data URL, downscaled, for an ordinary image', async () => {
    state.responses = [
      { match: 'cdn.example', contentType: jpeg, body: fakeImageBytes({ width: 1600, jpegBytes: 6000 }) }
    ]
    const out = await search.fetchImageDataUrl('https://cdn.example/a.jpg')
    assert.equal(out.ok, true)
    assert.ok(out.dataUrl!.startsWith('data:image/jpeg;base64,'))
    assert.deepEqual(state.resizeWidths, [320], 'a 1600px source must be resized down')
  })

  test('an already-small image is not upscaled', async () => {
    state.responses = [
      { match: 'cdn.example', contentType: jpeg, body: fakeImageBytes({ width: 200, jpegBytes: 3000 }) }
    ]
    const out = await search.fetchImageDataUrl('https://cdn.example/small.jpg')
    assert.equal(out.ok, true)
    assert.deepEqual(state.resizeWidths, [])
  })

  test('refuses a body the transport had to cut short', async () => {
    // A capped body is a partial body. Base64-encoding it yields a data URL
    // that looks valid and renders as a broken image — the one outcome worse
    // than showing nothing.
    state.responses = [
      {
        match: 'cdn.example',
        contentType: jpeg,
        body: fakeImageBytes({ width: 800, jpegBytes: 4000 }),
        truncated: true
      }
    ]
    const out = await search.fetchImageDataUrl('https://cdn.example/huge.jpg')
    assert.equal(out.ok, false)
    assert.match(out.error!, /larger than/i)
  })

  test('refuses an image that is still over the stored cap after resizing', async () => {
    state.responses = [
      {
        match: 'cdn.example',
        contentType: jpeg,
        body: fakeImageBytes({ width: 4000, jpegBytes: search.MAX_STORED_THUMBNAIL_BYTES + 1 })
      }
    ]
    const out = await search.fetchImageDataUrl('https://cdn.example/big.jpg')
    assert.equal(out.ok, false)
    assert.match(out.error!, /limit/i)
  })

  test('a format nativeImage cannot decode passes through only when already small', async () => {
    state.responses = [
      { match: 'small.example', contentType: 'image/webp', body: fakeImageBytes({ undecodable: true, totalBytes: 4096 }) }
    ]
    const small = await search.fetchImageDataUrl('https://small.example/a.webp')
    assert.equal(small.ok, true)
    assert.ok(small.dataUrl!.startsWith('data:image/webp;base64,'))

    state.responses = [
      {
        match: 'big.example',
        contentType: 'image/webp',
        body: fakeImageBytes({ undecodable: true, totalBytes: search.MAX_STORED_THUMBNAIL_BYTES + 10 })
      }
    ]
    const big = await search.fetchImageDataUrl('https://big.example/a.webp')
    assert.equal(big.ok, false)
    assert.match(big.error!, /cannot be resized/i)
  })

  test('PNG keeps its format when it fits, and falls back to JPEG when it does not', async () => {
    state.responses = [
      { match: 'alpha.example', contentType: 'image/png', body: fakeImageBytes({ width: 900, pngBytes: 20 * 1024, jpegBytes: 5000 }) }
    ]
    const kept = await search.fetchImageDataUrl('https://alpha.example/a.png')
    assert.ok(kept.dataUrl!.startsWith('data:image/png;base64,'))

    state.responses = [
      { match: 'photo.example', contentType: 'image/png', body: fakeImageBytes({ width: 900, pngBytes: 900 * 1024, jpegBytes: 5000 }) }
    ]
    const converted = await search.fetchImageDataUrl('https://photo.example/a.png')
    assert.ok(converted.dataUrl!.startsWith('data:image/jpeg;base64,'))
  })

  test('refuses SVG outright — it can carry script', async () => {
    state.responses = [
      { match: 'cdn.example', contentType: 'image/svg+xml', body: '<svg onload="alert(1)"/>' }
    ]
    const out = await search.fetchImageDataUrl('https://cdn.example/x.svg')
    assert.equal(out.ok, false)
    assert.match(out.error!, /not a supported image/i)
  })

  test('refuses a non-image content type', async () => {
    state.responses = [{ match: 'cdn.example', contentType: 'text/html', body: '<html/>' }]
    const out = await search.fetchImageDataUrl('https://cdn.example/x')
    assert.equal(out.ok, false)
    assert.match(out.error!, /not a supported image/i)
  })

  test('refuses a non-HTTPS URL', async () => {
    const out = await search.fetchImageDataUrl('http://cdn.example/x.jpg')
    assert.equal(out.ok, false)
    assert.match(out.error!, /HTTPS/i)
    assert.equal(state.fetchLog.length, 0)
  })

  test('runs the SSRF guard, including on every redirect hop', async () => {
    state.dnsOverrides['inside.example'] = [{ address: '10.1.2.3', family: 4 }]
    state.responses = [
      {
        match: 'public.example',
        contentType: jpeg,
        body: '',
        status: 302,
        headers: { location: 'https://inside.example/a.jpg' }
      }
    ]
    const out = await search.fetchImageDataUrl('https://public.example/a.jpg')
    assert.equal(out.ok, false)
    assert.match(out.error!, /private or reserved/i)
  })

  test('refuses a redirect that downgrades to HTTP', async () => {
    state.responses = [
      {
        match: 'downgrade.example',
        contentType: jpeg,
        body: '',
        status: 302,
        headers: { location: 'http://plain.example/a.jpg' }
      }
    ]
    const out = await search.fetchImageDataUrl('https://downgrade.example/a.jpg')
    assert.equal(out.ok, false)
    assert.match(out.error!, /non-HTTPS/i)
  })

  test('stops a redirect loop', async () => {
    state.responses = [
      {
        match: 'loop.example',
        contentType: jpeg,
        body: '',
        status: 302,
        headers: { location: 'https://loop.example/again.jpg' }
      }
    ]
    const out = await search.fetchImageDataUrl('https://loop.example/a.jpg')
    assert.equal(out.ok, false)
    assert.match(out.error!, /too many redirects/i)
  })

  test('thumbnail fetches are logged under their own purpose, not as a webpage', async () => {
    // The activity log is the basis of the privacy claim: "an image host we
    // contacted to draw a gallery" is a different disclosure from "a page you
    // asked to read", and the log has to be able to tell the user which.
    state.responses = [
      { match: 'cdn.example', contentType: jpeg, body: fakeImageBytes({ width: 400, jpegBytes: 2000 }) }
    ]
    await search.fetchImageDataUrl('https://cdn.example/a.jpg')
    assert.deepEqual(state.fetchLog.map((f) => f.purpose), ['image'])
  })
})

/**
 * v1.4.6. A measured session fetched two supermarket store-locator pages and
 * got bare `HTTP 403` from both. The model read that as "unreachable" and
 * wrote the addresses from memory — three of seven stops in the resulting
 * route came from no source at all.
 *
 * The 403 was correct, and this app caused it: web traffic was routed through
 * a SOCKS5 proxy on the Tor port, and both hosts refuse Tor exits. Verified
 * directly on 2026-08-13 — both URLs answer 200 without the proxy and 403
 * through it, while Wikipedia answers 200 either way.
 *
 * The fix is disclosure, never a retry. Stepping around a proxy the user
 * turned on, for a page that would not otherwise load, is the kind of silent
 * exception that makes the setting worthless.
 */
describe('proxyRefusalHint', () => {
  test('explains a 403 when a proxy is carrying the request', () => {
    const hint = search.proxyRefusalHint(403, 'socks5')
    assert.match(hint, /SOCKS5 proxy/)
    assert.match(hint, /block proxy and Tor exit addresses/)
  })

  test('tells the model what to do instead of guessing', () => {
    // The whole point: the measured failure was not the block, it was the
    // addresses invented after it.
    assert.match(search.proxyRefusalHint(403, 'socks5'), /Do not fill the gap from memory/)
  })

  test('covers the other statuses a bot filter returns', () => {
    assert.notEqual(search.proxyRefusalHint(429, 'socks5'), '')
    assert.notEqual(search.proxyRefusalHint(451, 'http'), '')
  })

  test('says nothing when no proxy is configured', () => {
    // Without a proxy a 403 means something else, and guessing would mislead.
    assert.equal(search.proxyRefusalHint(403, 'none'), '')
  })

  test('says nothing about statuses a proxy does not explain', () => {
    assert.equal(search.proxyRefusalHint(404, 'socks5'), '')
    assert.equal(search.proxyRefusalHint(500, 'socks5'), '')
  })
})
