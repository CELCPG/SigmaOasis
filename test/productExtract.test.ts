import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractProduct,
  extractSpecTables,
  findUrgencyClaims,
  normalizeSpec,
  parseAvailability,
  parseCapacityGb,
  parseHours,
  parseInches,
  parsePrice,
  parseWeightKg
} from '../src/main/ipc/productExtract'

/**
 * The rung a value came from is as important as the value. A price the model
 * read off a page and a price parsed from schema.org data are different kinds
 * of fact, and the ladder exists so the difference survives to the UI.
 */

describe('parsePrice', () => {
  test('handles symbols and thousands separators', () => {
    assert.equal(parsePrice('$1,299.00'), 1299)
    assert.equal(parsePrice('1299'), 1299)
    assert.equal(parsePrice(1299.5), 1299.5)
  })

  test('handles European decimal commas', () => {
    assert.equal(parsePrice('1.299,00 €'), 1299)
    assert.equal(parsePrice('99,95'), 99.95)
  })

  test('returns null rather than guessing', () => {
    assert.equal(parsePrice('call for price'), null)
    assert.equal(parsePrice(''), null)
    assert.equal(parsePrice(undefined), null)
    assert.equal(parsePrice(-5), null)
  })
})

describe('unit parsers', () => {
  test('capacity normalizes to GB', () => {
    assert.equal(parseCapacityGb('16 GB'), 16)
    assert.equal(parseCapacityGb('16GB'), 16)
    assert.equal(parseCapacityGb('1 TB'), 1024)
    assert.equal(parseCapacityGb('512 MB'), 0.5)
    assert.equal(parseCapacityGb('lots'), null)
  })

  test('weight normalizes to kg', () => {
    assert.equal(parseWeightKg('1.24 kg'), 1.24)
    assert.equal(parseWeightKg('1,24 kg'), 1.24)
    assert.equal(parseWeightKg('2.8 lbs'), 1.27)
    assert.equal(parseWeightKg('900 g'), 0.9)
  })

  test('hours and inches', () => {
    assert.equal(parseHours('18 hours'), 18)
    assert.equal(parseHours('Up to 10.5 hrs'), 10.5)
    assert.equal(parseInches('13.6"'), 13.6)
    assert.equal(parseInches('27 inch'), 27)
  })
})

describe('parseAvailability', () => {
  test('maps schema.org URLs', () => {
    assert.equal(parseAvailability('https://schema.org/InStock'), 'in_stock')
    assert.equal(parseAvailability('http://schema.org/OutOfStock'), 'out_of_stock')
    assert.equal(parseAvailability('https://schema.org/PreOrder'), 'preorder')
  })

  test('unknown stays unknown rather than defaulting to in stock', () => {
    assert.equal(parseAvailability(''), 'unknown')
    assert.equal(parseAvailability('maybe'), 'unknown')
  })
})

describe('normalizeSpec', () => {
  test('maps a label onto a canonical key with a normalized magnitude', () => {
    const ram = normalizeSpec('Memory', '16 GB', 'json-ld')
    assert.equal(ram?.key, 'ram_gb')
    assert.equal(ram?.value.value, 16)
    assert.equal(ram?.value.raw, '16 GB')
    assert.equal(ram?.value.rung, 'json-ld')
  })

  test('drops an unrecognized label rather than storing it under a guessed key', () => {
    assert.equal(normalizeSpec('Vibe', 'immaculate', 'json-ld'), null)
  })

  test('drops a recognized label whose value has no parseable magnitude', () => {
    assert.equal(normalizeSpec('RAM', 'plenty', 'json-ld'), null)
  })

  test('free-text specs are kept as strings', () => {
    const cpu = normalizeSpec('Processor', 'Apple M4 Pro', 'meta')
    assert.equal(cpu?.key, 'cpu')
    assert.equal(cpu?.value.value, undefined)
    assert.equal(cpu?.value.raw, 'Apple M4 Pro')
  })
})

describe('the extraction ladder', () => {
  const jsonLd = (body: string): string =>
    `<html><head><script type="application/ld+json">${body}</script></head><body></body></html>`

  test('reads price, currency, availability and specs from JSON-LD', () => {
    const html = jsonLd(
      JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: 'Example Laptop 14',
        brand: { '@type': 'Brand', name: 'Example' },
        additionalProperty: [
          { '@type': 'PropertyValue', name: 'RAM', value: '32 GB' },
          { '@type': 'PropertyValue', name: 'Weight', value: '1.24 kg' }
        ],
        offers: {
          '@type': 'Offer',
          price: '1899.00',
          priceCurrency: 'USD',
          availability: 'https://schema.org/InStock',
          seller: { '@type': 'Organization', name: 'Example Store' }
        }
      })
    )
    const product = extractProduct(html, 'https://shop.example/p/1')
    assert.equal(product.price, 1899)
    assert.equal(product.currency, 'USD')
    assert.equal(product.availability, 'in_stock')
    assert.equal(product.priceRung, 'json-ld')
    assert.equal(product.seller, 'Example Store')
    assert.equal(product.brand, 'Example')
    assert.equal(product.specs.ram_gb.value, 32)
    assert.equal(product.specs.weight_kg.value, 1.24)
  })

  test('flattens @graph and finds the Product node inside it', () => {
    const html = jsonLd(
      JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'BreadcrumbList' },
          { '@type': ['Product'], name: 'Nested', offers: { '@type': 'Offer', price: 42, priceCurrency: 'GBP' } }
        ]
      })
    )
    const product = extractProduct(html, 'https://shop.example/p/2')
    assert.equal(product.price, 42)
    assert.equal(product.currency, 'GBP')
    assert.equal(product.name, 'Nested')
  })

  test('AggregateOffer lowPrice is used when there is no single price', () => {
    const html = jsonLd(
      JSON.stringify({
        '@type': 'Product',
        name: 'Ranged',
        offers: { '@type': 'AggregateOffer', lowPrice: '249.99', priceCurrency: 'USD' }
      })
    )
    assert.equal(extractProduct(html, 'https://shop.example/p/3').price, 249.99)
  })

  test('malformed JSON-LD is skipped, not fatal — the page still yields meta data', () => {
    const html =
      '<html><head><script type="application/ld+json">{ not json </script>' +
      '<meta property="product:price:amount" content="55.00">' +
      '<meta property="product:price:currency" content="USD"></head></html>'
    const product = extractProduct(html, 'https://shop.example/p/4')
    assert.equal(product.price, 55)
    assert.equal(product.priceRung, 'meta')
  })

  test('structured data wins over a contradicting visible price', () => {
    // The visible "$1,099" is a strike-through "was" price; JSON-LD is the sale.
    const html =
      jsonLd(JSON.stringify({ '@type': 'Product', name: 'X', offers: { price: '899.00', priceCurrency: 'USD' } })) +
      '<div class="was-price">$1,099.00</div>' +
      '<span itemprop="price" content="1099.00"></span>'
    const product = extractProduct(html, 'https://shop.example/p/5')
    assert.equal(product.price, 899)
    assert.equal(product.priceRung, 'json-ld')
  })

  test('microdata is used when there is no JSON-LD', () => {
    const html =
      '<html><body><div itemscope itemtype="https://schema.org/Product">' +
      '<meta itemprop="price" content="129.99">' +
      '<meta itemprop="priceCurrency" content="EUR">' +
      '<link itemprop="availability" href="https://schema.org/OutOfStock">' +
      '</div></body></html>'
    const product = extractProduct(html, 'https://shop.example/p/6')
    assert.equal(product.price, 129.99)
    assert.equal(product.currency, 'EUR')
    assert.equal(product.priceRung, 'microdata')
  })

  test('no rung produced a price → priceRung is null and price is absent', () => {
    const product = extractProduct('<html><body>Call for pricing</body></html>', 'https://shop.example/p/7')
    assert.equal(product.price, undefined)
    assert.equal(product.priceRung, null)
  })
})

describe('spec tables', () => {
  test('two-column table rows become canonical specs', () => {
    const html =
      '<table><tr><th>RAM</th><td>64 GB</td></tr>' +
      '<tr><th>Battery life</th><td>Up to 18 hours</td></tr>' +
      '<tr><th>Colour</th><td>Space Grey</td></tr></table>'
    const specs = extractSpecTables(html, 'microdata')
    assert.equal(specs.ram_gb.value, 64)
    assert.equal(specs.battery_h.value, 18)
    assert.equal(specs.colour, undefined, 'unrecognized labels are dropped, not guessed')
  })

  test('definition lists work too', () => {
    const specs = extractSpecTables('<dl><dt>Weight</dt><dd>1.5 kg</dd></dl>', 'json-ld')
    assert.equal(specs.weight_kg.value, 1.5)
  })

  test('spec tables fill gaps but never overwrite structured data', () => {
    const html =
      '<script type="application/ld+json">' +
      JSON.stringify({
        '@type': 'Product',
        additionalProperty: [{ name: 'RAM', value: '32 GB' }],
        offers: { price: '1.00', priceCurrency: 'USD' }
      }) +
      '</script><table><tr><th>RAM</th><td>8 GB</td></tr><tr><th>Weight</th><td>2 kg</td></tr></table>'
    const product = extractProduct(html, 'https://shop.example/p/8')
    assert.equal(product.specs.ram_gb.value, 32, 'structured data must win')
    assert.equal(product.specs.weight_kg.value, 2, 'the table fills what structured data omitted')
  })
})

describe('dark patterns', () => {
  test('urgency claims are collected, not treated as fact', () => {
    const claims = findUrgencyClaims('Only 3 left in stock! 14 people are viewing this. Deal ends in 2 hours')
    assert.ok(claims.some((c) => /only 3 left/i.test(c)))
    assert.ok(claims.some((c) => /14 people are viewing/i.test(c)))
    assert.ok(claims.some((c) => /deal ends/i.test(c)))
  })

  test('they land in their own field, never in the factual ones', () => {
    const product = extractProduct(
      '<html><body>Only 2 left!</body></html>',
      'https://shop.example/p/9',
      'Only 2 left!'
    )
    assert.equal(product.urgencyClaims.length, 1)
    assert.equal(product.price, undefined)
  })

  test('an ordinary page produces none', () => {
    assert.deepEqual(findUrgencyClaims('A perfectly normal product description.'), [])
  })
})
