import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  authoritativeFor,
  isExcluded,
  isMarketplace,
  provenanceNote,
  provenanceOf,
  tierOf
} from '../src/main/ipc/sourceTiers'

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

/**
 * v1.5: general web search gets its own, much smaller claim than the product
 * tiers above. The failure it exists for is a measured v1.4 session that
 * researched a stock, found nothing but SEO domains, and wrote an investment
 * plan on them — with no signal anywhere in the output that the sources had
 * anything in common.
 *
 * The property that matters most is the last one: silence on the ordinary web.
 * A classifier that editorializes about every result is one the model learns
 * to skip, and it would also be this app pretending to know which outlets to
 * believe — a claim it has no basis for and no way to maintain.
 */
describe('provenanceOf', () => {
  const kind = (url: string): string => provenanceOf(url).kind

  test('the public record reads as primary', () => {
    assert.equal(kind('https://www.sec.gov/edgar/browse/?CIK=123'), 'primary')
    assert.equal(kind('https://science.nasa.gov/universe/overview/'), 'primary')
    assert.equal(kind('https://www.cam.ac.uk/research'), 'primary')
    assert.equal(kind('https://arxiv.org/abs/2401.00001'), 'primary')
    assert.equal(kind('https://www.iso.org/standard/12345.html'), 'primary')
  })

  test('encyclopedias are named as summaries, not sources', () => {
    assert.equal(kind('https://en.wikipedia.org/wiki/Cosmology'), 'reference')
    assert.match(provenanceOf('https://en.wikipedia.org/wiki/Cosmology').why, /not a source/i)
  })

  test('the SEO pages from the measured session are caught', () => {
    assert.equal(kind('https://thechronex.com/how-to-buy-spacex-stock-spcx-ipo-guide/'), 'farm')
    assert.equal(kind('https://spacexstockreview.com/spacex-ipo-2026-complete-guide/'), 'farm')
    assert.equal(
      kind('https://www.coingabbar.com/en/price-prediction/spacex-stock-prediction'),
      'farm'
    )
  })

  test('known content farms stay farms whatever the path', () => {
    assert.equal(kind('https://top10.com/anything'), 'farm')
  })

  test('an official how-to guide is not search-bait', () => {
    // The shape only means something on a domain nothing else is known about;
    // a regulator publishing "how to file" is still the regulator.
    assert.equal(kind('https://www.sec.gov/how-to-invest-guide'), 'primary')
  })

  test('the ordinary web is unknown, and says nothing', () => {
    assert.equal(kind('https://example.com/blog/some-post'), 'unknown')
    assert.equal(provenanceOf('https://example.com/blog/some-post').why, '')
    assert.equal(kind('https://www.reuters.com/world/article-123'), 'unknown')
  })

  test('an unparseable URL makes no claim either way', () => {
    assert.equal(kind('not a url'), 'unknown')
  })
})

describe('provenanceNote', () => {
  test('stays quiet when nothing is search-bait', () => {
    assert.equal(
      provenanceNote(['https://en.wikipedia.org/wiki/X', 'https://example.com/a']),
      null
    )
  })

  test('stays quiet on an empty result set', () => {
    assert.equal(provenanceNote([]), null)
  })

  test('counts the bait and names the missing record', () => {
    const note = provenanceNote([
      'https://thechronex.com/how-to-buy-spacex-stock-spcx-ipo-guide/',
      'https://example.com/analysis'
    ])
    assert.ok(note)
    assert.match(note, /1 of these 2/)
    assert.match(note, /No primary or official source/i)
  })

  test('does not claim a primary source is missing when one is present', () => {
    const note = provenanceNote([
      'https://thechronex.com/how-to-buy-spacex-stock-spcx-ipo-guide/',
      'https://www.sec.gov/edgar/browse'
    ])
    assert.ok(note)
    assert.doesNotMatch(note, /No primary or official source/i)
  })

  test('says so plainly when every result is bait', () => {
    const note = provenanceNote([
      'https://thechronex.com/how-to-buy-spacex-stock-spcx-ipo-guide/',
      'https://top10.com/best-brokers'
    ])
    assert.match(String(note), /Every result/i)
  })

  test('names repetition across SEO pages as the thing that is not evidence', () => {
    const note = String(provenanceNote(['https://top10.com/best-x']))
    assert.match(note, /not evidence/i)
  })
})
