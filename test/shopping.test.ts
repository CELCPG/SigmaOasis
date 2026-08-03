import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { load, state, resetState } from './harness'

const shopping = load<typeof import('../src/main/ipc/shopping')>('shopping')
const search = load<typeof import('../src/main/ipc/search')>('search')
const researchIndex = load<typeof import('../src/main/ipc/researchIndex')>('researchIndex')

/**
 * Three behaviors here must never regress, because each is a promise the
 * feature makes rather than a nicety:
 *
 * 1. Personal framing is refused *before* egress, not rewritten.
 * 2. `requireProxy` refuses rather than falling back to a direct fetch.
 * 3. A candidate with an unverified hard requirement is not recommendable.
 */

type Settings = {
  search: { provider: string; searxngUrl: string; maxResults: number; confirmBeforeSearch: boolean }
  proxy: { mode: string; host: string; port: number }
  shopping: { requireProxy: boolean; maxSellers: number; excludeTierX: boolean }
}
const settings = (): Settings => state.settings as unknown as Settings

/** A product page carrying schema.org data — the ordinary case. */
function productPage(opts: {
  name: string
  price: string
  currency?: string
  ram?: string
  weight?: string
  extra?: string
}): string {
  const props = [
    opts.ram ? { '@type': 'PropertyValue', name: 'RAM', value: opts.ram } : null,
    opts.weight ? { '@type': 'PropertyValue', name: 'Weight', value: opts.weight } : null
  ].filter(Boolean)
  return (
    '<html><head><script type="application/ld+json">' +
    JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: opts.name,
      additionalProperty: props,
      offers: {
        '@type': 'Offer',
        price: opts.price,
        priceCurrency: opts.currency ?? 'USD',
        availability: 'https://schema.org/InStock'
      }
    }) +
    `</script></head><body>${opts.extra ?? ''}</body></html>`
  )
}

function searxngResults(urls: { url: string; title: string }[]): void {
  settings().search.provider = 'searxng'
  state.searxngJson = { results: urls.map((u) => ({ ...u, content: '' })) }
}

beforeEach(() => {
  resetState()
  search.clearSearchCache()
  researchIndex.clearResearchIndex()
})

describe('query minimization — enforced before egress', () => {
  test('refuses first-person framing and names the fix', async () => {
    const out = await shopping.runShopCompare({ product: 'laptop for editing my wedding videos' })
    assert.equal(out.ok, false)
    assert.match(out.error ?? '', /personal framing/i)
    assert.match(out.error ?? '', /specifications/i)
    assert.equal(state.fetchLog.length, 0, 'nothing may leave the machine on a refusal')
  })

  test('refuses a sentence-shaped query', async () => {
    const out = await shopping.runShopCompare({
      product: 'what is the best laptop with a really good screen and long battery life for travel and work'
    })
    assert.equal(out.ok, false)
    assert.match(out.error ?? '', /product search|question/i)
    assert.equal(state.fetchLog.length, 0)
  })

  test('refuses a question', async () => {
    const out = await shopping.runShopCompare({ product: 'which laptop is best?' })
    assert.equal(out.ok, false)
    assert.equal(state.fetchLog.length, 0)
  })

  test('accepts a product-shaped query', () => {
    const shaped = shopping.assertProductShapedQuery('laptop 32GB RAM 1TB discrete GPU under 2000')
    assert.equal(shaped.ok, true)
  })

  test('rejection is a refusal, never a silent rewrite', () => {
    const shaped = shopping.assertProductShapedQuery('headphones for my commute')
    assert.equal(shaped.ok, false)
    // No `query` field on the failure — there is nothing to quietly send.
    assert.equal((shaped as { query?: string }).query, undefined)
  })
})

describe('requireProxy', () => {
  test('refuses when the proxy is off — never falls back to a direct fetch', async () => {
    settings().shopping.requireProxy = true
    settings().proxy.mode = 'none'
    const out = await shopping.runShopCompare({ product: 'laptop 32GB RAM' })
    assert.equal(out.ok, false)
    assert.match(out.error ?? '', /proxy/i)
    assert.equal(state.fetchLog.length, 0, 'the refusal must happen before any request')
  })

  test('proceeds when a proxy is active', async () => {
    settings().shopping.requireProxy = true
    settings().proxy.mode = 'socks5'
    searxngResults([{ url: 'https://shop.example/p/1', title: 'Laptop' }])
    state.responses = [
      { match: 'shop.example', contentType: 'text/html', body: productPage({ name: 'L', price: '999' }) }
    ]
    const out = await shopping.runShopCompare({ product: 'laptop 32GB RAM' })
    assert.equal(out.ok, true)
    assert.equal(out.offers.length, 1)
  })
})

describe('refused categories', () => {
  test('declines to rank medical devices, with guidance instead', async () => {
    const out = await shopping.runShopCompare({ product: 'blood pressure monitor upper arm' })
    assert.equal(out.ok, false)
    assert.match(out.error ?? '', /medical devices/i)
    assert.match(out.error ?? '', /clearance|clinician/i)
    assert.equal(state.fetchLog.length, 0)
  })

  test('declines financial products', () => {
    const refused = shopping.refusedCategory('best life insurance policy')
    assert.ok(refused)
    assert.match(refused.guidance, /adviser|regulator/i)
  })

  test('ordinary electronics are not refused', () => {
    assert.equal(shopping.refusedCategory('laptop 32GB RAM'), null)
    assert.equal(shopping.refusedCategory('over-ear headphones noise cancelling'), null)
  })
})

describe('candidate discovery', () => {
  test('excludes tier-X listicles and reports the exclusion', async () => {
    searxngResults([
      { url: 'https://bestreviews.guide/best-laptops', title: 'Top 10 Laptops' },
      { url: 'https://shop.example/p/1', title: 'Laptop' }
    ])
    state.responses = [
      { match: 'shop.example', contentType: 'text/html', body: productPage({ name: 'L', price: '999' }) }
    ]
    const out = await shopping.runShopCompare({ product: 'laptop 32GB RAM' })
    assert.equal(out.offers.length, 1)
    assert.equal(out.excluded.length, 1)
    assert.match(out.excluded[0].why, /affiliate|listicle/i)
    assert.ok(!state.fetchLog.some((f) => f.url.includes('bestreviews')), 'an excluded source is never fetched')
  })

  test('strips tracking parameters before fetching', async () => {
    searxngResults([{ url: 'https://shop.example/p/1?tag=aff-20&utm_source=x', title: 'Laptop' }])
    state.responses = [
      { match: 'shop.example', contentType: 'text/html', body: productPage({ name: 'L', price: '999' }) }
    ]
    const out = await shopping.runShopCompare({ product: 'laptop 32GB RAM' })
    assert.ok(!out.offers[0].url.includes('tag='))
    const shopFetch = state.fetchLog.find((f) => f.purpose === 'shop')
    assert.ok(shopFetch, 'shopping fetches are logged under their own purpose')
    assert.ok(!shopFetch.url.includes('tag='), 'the affiliate tag must not reach the retailer either')
  })

  test('one candidate per host — the same seller is not checked twice', async () => {
    searxngResults([
      { url: 'https://shop.example/p/1', title: 'A' },
      { url: 'https://shop.example/p/2', title: 'B' },
      { url: 'https://other.example/p/3', title: 'C' }
    ])
    state.responses = [
      { match: 'shop.example', contentType: 'text/html', body: productPage({ name: 'A', price: '1' }) },
      { match: 'other.example', contentType: 'text/html', body: productPage({ name: 'C', price: '2' }) }
    ]
    const out = await shopping.runShopCompare({ product: 'laptop 32GB RAM' })
    assert.deepEqual(out.offers.map((o) => o.seller).sort(), ['other.example', 'shop.example'])
  })
})

describe('fetch budget', () => {
  test('stops at maxSellers and discloses the stop', async () => {
    searxngResults(
      ['a', 'b', 'c', 'd', 'e'].map((h) => ({ url: `https://${h}.example/p`, title: h }))
    )
    state.responses = ['a', 'b', 'c', 'd', 'e'].map((h) => ({
      match: `${h}.example`,
      contentType: 'text/html',
      body: productPage({ name: h, price: '100' })
    }))
    const out = await shopping.runShopCompare({ product: 'laptop 32GB RAM', maxSellers: 2 })
    assert.equal(out.offers.length, 2)
    assert.match(out.budgetNote ?? '', /budget reached/i)
    assert.equal(
      state.fetchLog.filter((f) => f.purpose === 'shop').length,
      2,
      'the budget is checked before the work, not after'
    )
  })

  test('caps maxSellers regardless of what the caller asks for', async () => {
    searxngResults(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((h) => ({ url: `https://${h}.example/p`, title: h }))
    )
    state.responses = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((h) => ({
      match: `${h}.example`,
      contentType: 'text/html',
      body: productPage({ name: h, price: '100' })
    }))
    const out = await shopping.runShopCompare({ product: 'laptop 32GB RAM', maxSellers: 99 })
    assert.ok(out.offers.length <= 5)
  })
})

describe('blocked sellers', () => {
  test('a failed fetch becomes a blocked row, never a dropped one', async () => {
    searxngResults([
      { url: 'https://blocked.example/p', title: 'Blocked' },
      { url: 'https://shop.example/p', title: 'Fine' }
    ])
    state.responses = [
      { match: 'blocked.example', contentType: 'text/html', body: 'nope', status: 403 },
      { match: 'shop.example', contentType: 'text/html', body: productPage({ name: 'L', price: '999' }) }
    ]
    const out = await shopping.runShopCompare({ product: 'laptop 32GB RAM' })
    const blocked = out.offers.find((o) => o.seller === 'blocked.example')
    assert.ok(blocked, 'the gap must be visible, not silently omitted')
    assert.match(blocked.blocked ?? '', /403/)
    assert.match(shopping.formatCompare(out), /BLOCKED/)
  })
})

describe('verification and the recommendation gate', () => {
  const requirement = (spec: string, value: number, op: '>=' | '<=' = '>=', kind: 'hard' | 'soft' = 'hard') => ({
    spec,
    label: `${spec} ${op} ${value}`,
    op,
    value,
    kind,
    why: 'test',
    origin: 'rubric' as const
  })

  test('confirms a met requirement and names the basis', async () => {
    // A recognized retailer, so the basis must say "retailer-listed" — a
    // retailer's spec table is not a manufacturer spec sheet.
    searxngResults([{ url: 'https://www.bestbuy.com/site/p.p', title: 'Laptop' }])
    state.responses = [
      {
        match: 'bestbuy.com',
        contentType: 'text/html',
        body: productPage({ name: 'L', price: '1999', ram: '32 GB' })
      }
    ]
    const out = await shopping.runShopCompare({
      product: 'laptop 32GB RAM',
      requirements: [requirement('ram_gb', 32)]
    })
    const verdict = out.offers[0].verdicts[0]
    assert.equal(verdict.verdict, 'confirmed')
    assert.equal(verdict.found, '32 GB')
    assert.equal(verdict.basis, 'retailer-listed')
    assert.equal(verdict.source, 'https://www.bestbuy.com/site/p.p')
  })

  test('an unrecognized source that published the value is page-stated, not model-read', async () => {
    // "we don't know this site" and "a model read it off the page" are
    // different weaknesses, and only the second is our doing.
    searxngResults([{ url: 'https://shop.example/p', title: 'Laptop' }])
    state.responses = [
      {
        match: 'shop.example',
        contentType: 'text/html',
        body: productPage({ name: 'L', price: '1999', ram: '32 GB' })
      }
    ]
    const out = await shopping.runShopCompare({
      product: 'laptop 32GB RAM',
      requirements: [requirement('ram_gb', 32)]
    })
    assert.equal(out.offers[0].verdicts[0].basis, 'page-stated')
  })

  test('contradicts an unmet requirement', async () => {
    searxngResults([{ url: 'https://shop.example/p', title: 'Laptop' }])
    state.responses = [
      {
        match: 'shop.example',
        contentType: 'text/html',
        body: productPage({ name: 'L', price: '999', ram: '8 GB' })
      }
    ]
    const out = await shopping.runShopCompare({
      product: 'laptop 32GB RAM',
      requirements: [requirement('ram_gb', 32)]
    })
    assert.equal(out.offers[0].verdicts[0].verdict, 'contradicted')
    assert.equal(shopping.canRecommend(out.offers[0].verdicts), false)
  })

  test('a spec the page does not state is unverifiable — never assumed either way', async () => {
    searxngResults([{ url: 'https://shop.example/p', title: 'Laptop' }])
    state.responses = [
      { match: 'shop.example', contentType: 'text/html', body: productPage({ name: 'L', price: '999' }) }
    ]
    const out = await shopping.runShopCompare({
      product: 'laptop 32GB RAM',
      requirements: [requirement('ram_gb', 32)]
    })
    assert.equal(out.offers[0].verdicts[0].verdict, 'unverifiable')
    assert.equal(out.offers[0].verdicts[0].found, undefined)
  })

  test('the gate: an unverifiable hard requirement makes a product unrecommendable', async () => {
    searxngResults([{ url: 'https://shop.example/p', title: 'Laptop' }])
    state.responses = [
      {
        match: 'shop.example',
        contentType: 'text/html',
        body: productPage({ name: 'L', price: '1999', ram: '32 GB' })
      }
    ]
    const out = await shopping.runShopCompare({
      product: 'laptop 32GB RAM',
      requirements: [requirement('ram_gb', 32), requirement('weight_kg', 1.6, '<=')]
    })
    assert.equal(shopping.canRecommend(out.offers[0].verdicts), false)
    const text = shopping.formatCompare(out)
    assert.match(text, /NOT recommendable/)
    assert.match(text, /do not pick one anyway/)
  })

  test('soft requirements do not block recommendation', () => {
    assert.equal(
      shopping.canRecommend([
        { requirement: 'a', verdict: 'confirmed', sourceTier: 'C', basis: 'retailer-listed', kind: 'hard' },
        { requirement: 'b', verdict: 'unverifiable', sourceTier: 'C', basis: 'retailer-listed', kind: 'soft' }
      ]),
      true
    )
  })

  test('no requirements at all is not a pass', () => {
    assert.equal(shopping.canRecommend([]), false)
  })

  test('basis distinguishes manufacturer claims from independent testing', () => {
    assert.equal(shopping.basisFor('A', 'json-ld'), 'manufacturer-claimed')
    assert.equal(shopping.basisFor('B', 'json-ld'), 'independently-tested')
    assert.equal(shopping.basisFor('C', 'json-ld'), 'retailer-listed')
    assert.equal(shopping.basisFor('A', 'model'), 'model-read', 'a model reading a page is never a spec sheet')
  })
})

describe('formatCompare', () => {
  test('states provenance, the anonymous-price caveat, and the no-transaction boundary', async () => {
    searxngResults([{ url: 'https://shop.example/p', title: 'Laptop' }])
    state.responses = [
      {
        match: 'shop.example',
        contentType: 'text/html',
        body: productPage({ name: 'Example 14', price: '1899', ram: '32 GB', extra: 'Only 2 left!' })
      }
    ]
    const out = await shopping.runShopCompare({ product: 'laptop 32GB RAM' })
    const text = shopping.formatCompare(out)
    assert.match(text, /\$1899\.00/)
    assert.match(text, /price from json-ld/)
    assert.match(text, /checked just now/)
    assert.match(text, /logged-in or regional price may differ/)
    assert.match(text, /does not transact/)
    assert.match(text, /retailer marketing on this page \(NOT fact\): Only 2 left/)
  })

  test('a price with no structured data is reported absent, never invented', async () => {
    searxngResults([{ url: 'https://shop.example/p', title: 'Laptop' }])
    state.responses = [
      { match: 'shop.example', contentType: 'text/html', body: '<html><body>Call us for pricing</body></html>' }
    ]
    const out = await shopping.runShopCompare({ product: 'laptop 32GB RAM' })
    assert.equal(out.offers[0].price, undefined)
    assert.match(shopping.formatCompare(out), /no price in structured data/)
  })
})

describe('runShopRequirements — local only', () => {
  test('first call returns the questions and sends nothing', () => {
    const out = shopping.runShopRequirements({ need: 'I need a new laptop' })
    assert.equal(out.ok, true)
    assert.match(out.output ?? '', /primary_use/)
    assert.match(out.output ?? '', /Nothing has left the machine/)
    assert.equal(state.fetchLog.length, 0)
  })

  test('second call derives requirements and hands over a product-shaped query', () => {
    const out = shopping.runShopRequirements({
      need: 'laptop',
      answers: { primary_use: 'video or photo editing', portability: 'constant travel', budget: '$2500' }
    })
    assert.match(out.output ?? '', /32 GB RAM or more/)
    assert.match(out.output ?? '', /correct it BEFORE searching/)
    // Spec order in the query is fixed, so the same answers always produce the
    // same query string — and therefore the same search cache entry.
    assert.match(out.output ?? '', /shop_compare with product="laptop 32GB RAM 1TB under 2500"/)
    assert.equal(state.fetchLog.length, 0)
  })

  test('an uncovered category asks the model to elicit rather than inventing a rubric', () => {
    const out = shopping.runShopRequirements({ need: 'a new mattress' })
    assert.equal(out.ok, true)
    assert.match(out.output ?? '', /at most 4 questions/)
    assert.match(out.output ?? '', /your inference, not established fact/)
  })

  test('refused categories are refused at this stage too', () => {
    const out = shopping.runShopRequirements({ need: 'a blood pressure monitor' })
    assert.equal(out.ok, false)
    assert.match(out.error ?? '', /medical devices/i)
  })
})
