import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeProductUrl, removedParams, stripTracking, unwrapRedirect } from '../src/main/ipc/urlHygiene'

/**
 * The load-bearing assertion in this file is the negative one: hygiene never
 * *adds* a parameter. Sigma Oasis takes no referral revenue, and a link it
 * shows must not carry an affiliate tag — including one it inherited from a
 * search result.
 */

describe('stripTracking', () => {
  test('removes affiliate and campaign parameters', () => {
    const out = stripTracking(
      'https://shop.example/p/123?tag=someaffiliate-20&utm_source=google&utm_campaign=x&gclid=abc&color=black'
    )
    assert.ok(!out.includes('tag='))
    assert.ok(!out.includes('utm_'))
    assert.ok(!out.includes('gclid'))
    assert.ok(out.includes('color=black'), 'variant parameters must survive')
  })

  test('keeps variant parameters that select which product is shown', () => {
    // Stripping these silently prices the wrong item — worse than a breadcrumb.
    const out = stripTracking('https://shop.example/dp/X?th=1&psc=1&variant=512gb&ref=nav_search')
    assert.ok(out.includes('th=1'))
    assert.ok(out.includes('psc=1'))
    assert.ok(out.includes('variant=512gb'))
    assert.ok(!out.includes('ref='))
  })

  test('removes tracking path segments', () => {
    const out = stripTracking('https://shop.example/dp/B01/ref=sr_1_3?keywords=laptop')
    assert.ok(!out.includes('ref=sr_1_3'))
    assert.ok(out.includes('/dp/B01'))
  })

  test('leaves an already-clean URL untouched', () => {
    const url = 'https://shop.example/p/123?size=large'
    assert.equal(stripTracking(url), url)
  })

  test('a path that was entirely tracking collapses to root, not to an empty path', () => {
    assert.equal(stripTracking('https://shop.example/ref=abc'), 'https://shop.example/')
  })
})

describe('unwrapRedirect', () => {
  test('extracts the destination from a DuckDuckGo click wrapper', () => {
    const out = unwrapRedirect('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fshop.example%2Fp%2F1&rut=x')
    assert.equal(out, 'https://shop.example/p/1')
  })

  test('extracts the destination from a Google redirect', () => {
    const out = unwrapRedirect('https://www.google.com/url?q=https://shop.example/p/2&sa=U')
    assert.equal(out, 'https://shop.example/p/2')
  })

  test('unwraps a nested chain', () => {
    const inner = encodeURIComponent('https://shop.example/final')
    const middle = encodeURIComponent(`https://out.affiliate.net/?url=${inner}`)
    const out = unwrapRedirect(`https://duckduckgo.com/l/?uddg=${middle}`)
    assert.equal(out, 'https://shop.example/final')
  })

  test('leaves a direct URL alone', () => {
    const url = 'https://shop.example/p/3'
    assert.equal(unwrapRedirect(url), url)
  })

  test('a wrapper with no usable destination is returned unchanged rather than mangled', () => {
    const url = 'https://duckduckgo.com/l/?uddg=notaurl'
    assert.equal(unwrapRedirect(url), url)
  })
})

describe('normalizeProductUrl', () => {
  test('unwraps then strips, in that order', () => {
    const wrapped = `https://duckduckgo.com/l/?uddg=${encodeURIComponent(
      'https://shop.example/p/9?tag=aff-20&size=m'
    )}`
    const out = normalizeProductUrl(wrapped)
    assert.ok(out.startsWith('https://shop.example/p/9'))
    assert.ok(!out.includes('tag='))
    assert.ok(out.includes('size=m'))
  })

  test('is idempotent — a stored watchlist URL must not drift on re-normalization', () => {
    const once = normalizeProductUrl('https://shop.example/p/1/ref=x?utm_source=a&color=red')
    assert.equal(normalizeProductUrl(once), once)
  })

  test('never adds a parameter', () => {
    // The whole no-affiliate-revenue promise, asserted rather than assumed.
    const cases = [
      'https://shop.example/p/1',
      'https://shop.example/p/1?color=red',
      'https://shop.example/p/1?tag=aff-20',
      'https://duckduckgo.com/l/?uddg=' + encodeURIComponent('https://shop.example/p/2?utm_source=x')
    ]
    for (const input of cases) {
      const before = new Set([...new URL(unwrapRedirect(input)).searchParams.keys()])
      const after = new URL(normalizeProductUrl(input)).searchParams
      for (const key of after.keys()) {
        assert.ok(before.has(key), `hygiene added parameter "${key}" to ${input}`)
      }
    }
  })

  test('garbage in, garbage out — never throws', () => {
    assert.equal(normalizeProductUrl('not a url'), 'not a url')
    assert.equal(normalizeProductUrl(''), '')
  })
})

describe('removedParams', () => {
  test('reports what was taken off, for disclosure', () => {
    const removed = removedParams('https://shop.example/p?tag=a&utm_source=b&color=red')
    assert.deepEqual(removed.sort(), ['tag', 'utm_source'])
  })
})
