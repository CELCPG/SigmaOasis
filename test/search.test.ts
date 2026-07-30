import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { load, state, resetState } from './harness'

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
