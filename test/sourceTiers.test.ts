import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { authoritativeFor, isExcluded, isMarketplace, tierOf } from '../src/main/ipc/sourceTiers'

/**
 * Tiering is the quality lever that matters most in product search, because
 * the default result set is dominated by affiliate listicles. These tests pin
 * the classifications a user would otherwise have to take on faith.
 */

describe('tierOf', () => {
  test('independent testing outlets are tier B', () => {
    const t = tierOf('https://www.rtings.com/headphones/reviews/sony/wh-1000xm5')
    assert.equal(t.tier, 'B')
    assert.equal(t.monetized, true, 'affiliate revenue is disclosed, not disqualifying')
  })

  test('retailers are tier C — price and stock only', () => {
    assert.equal(tierOf('https://www.bestbuy.com/site/x/123.p').tier, 'C')
    assert.equal(authoritativeFor('C'), 'price and availability')
  })

  test('a brand token promotes the manufacturer site to tier A', () => {
    assert.equal(tierOf('https://www.sony.com/electronics/headband-headphones/wh-1000xm5', ['Sony']).tier, 'A')
  })

  test('a brand token does NOT promote that brand’s storefront on a marketplace', () => {
    // Otherwise "sony" in the query would make an Amazon listing authoritative
    // for specifications, which is exactly backwards.
    assert.equal(tierOf('https://www.amazon.com/sony-wh1000xm5/dp/B09', ['Sony']).tier, 'C')
  })

  test('forums are tier D', () => {
    assert.equal(tierOf('https://www.reddit.com/r/laptops/comments/abc').tier, 'D')
  })

  test('known content farms are tier X', () => {
    const t = tierOf('https://bestreviews.guide/best-laptops')
    assert.equal(t.tier, 'X')
    assert.ok(isExcluded(t.tier))
  })

  test('listicle-shaped URLs on unrecognized domains are tier X', () => {
    assert.equal(tierOf('https://randomblog.example/best-laptops-2026').tier, 'X')
    assert.equal(tierOf('https://randomblog.example/top-10-headphones/').tier, 'X')
  })

  test('a tier-B outlet’s round-up is still tier B — the testing is real', () => {
    assert.equal(tierOf('https://www.rtings.com/headphones/reviews/best/noise-cancelling').tier, 'B')
  })

  test('an unrecognized domain with an ordinary path is tier D, not excluded', () => {
    const t = tierOf('https://someshop.example/products/thing')
    assert.equal(t.tier, 'D')
    assert.equal(isExcluded(t.tier), false)
  })

  test('an unparseable URL is excluded rather than trusted', () => {
    assert.equal(tierOf('not a url').tier, 'X')
  })
})

describe('isMarketplace', () => {
  test('flags marketplaces where third-party sellers dominate', () => {
    assert.equal(isMarketplace('https://www.ebay.com/itm/123'), true)
    assert.equal(isMarketplace('https://www.aliexpress.com/item/1'), true)
    assert.equal(isMarketplace('https://www.bestbuy.com/site/x'), false)
  })
})
