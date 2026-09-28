'use strict'

/**
 * Line discounts. Each rule says when it applies to a cart line and how much
 * it takes off that line, in cents. A cart line is { sku, qty, product }, with
 * product from the catalog. Only the single best rule counts for a line — see
 * bestDiscount() at the end — and member and voucher discounts come after, in
 * cart.js.
 *
 * Add a rule by appending to RULES; ids must be unique.
 */
const RULES = [
  {
    id: 'tea-multibuy-3',
    description: '3 or more of one tea item: 5% off that line',
    applies: (line, cart) => line.product.category === 'tea' && line.qty >= 3,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 5) / 100
  },
  {
    id: 'tea-multibuy-6',
    description: '6 or more of one tea item: 8% off that line',
    applies: (line, cart) => line.product.category === 'tea' && line.qty >= 6,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 8) / 100
  },
  {
    id: 'coffee-multibuy-3',
    description: '3 or more of one coffee item: 5% off that line',
    applies: (line, cart) => line.product.category === 'coffee' && line.qty >= 3,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 5) / 100
  },
  {
    id: 'coffee-multibuy-6',
    description: '6 or more of one coffee item: 8% off that line',
    applies: (line, cart) => line.product.category === 'coffee' && line.qty >= 6,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 8) / 100
  },
  {
    id: 'biscuits-multibuy-3',
    description: '3 or more of one biscuits item: 5% off that line',
    applies: (line, cart) => line.product.category === 'biscuits' && line.qty >= 3,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 5) / 100
  },
  {
    id: 'biscuits-multibuy-6',
    description: '6 or more of one biscuits item: 8% off that line',
    applies: (line, cart) => line.product.category === 'biscuits' && line.qty >= 6,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 8) / 100
  },
  {
    id: 'crockery-multibuy-3',
    description: '3 or more of one crockery item: 5% off that line',
    applies: (line, cart) => line.product.category === 'crockery' && line.qty >= 3,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 5) / 100
  },
  {
    id: 'crockery-multibuy-6',
    description: '6 or more of one crockery item: 8% off that line',
    applies: (line, cart) => line.product.category === 'crockery' && line.qty >= 6,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 8) / 100
  },
  {
    id: 'kit-multibuy-3',
    description: '3 or more of one kit item: 5% off that line',
    applies: (line, cart) => line.product.category === 'kit' && line.qty >= 3,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 5) / 100
  },
  {
    id: 'kit-multibuy-6',
    description: '6 or more of one kit item: 8% off that line',
    applies: (line, cart) => line.product.category === 'kit' && line.qty >= 6,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 8) / 100
  },
  {
    id: 'gifts-multibuy-3',
    description: '3 or more of one gifts item: 5% off that line',
    applies: (line, cart) => line.product.category === 'gifts' && line.qty >= 3,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 5) / 100
  },
  {
    id: 'gifts-multibuy-6',
    description: '6 or more of one gifts item: 8% off that line',
    applies: (line, cart) => line.product.category === 'gifts' && line.qty >= 6,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 8) / 100
  },
  {
    id: 'tea-bulk-tins',
    description: '10 or more tins of one tea: 15% off that line',
    applies: (line, cart) => line.product.category === 'tea' && line.product.name.endsWith('tin') && line.qty >= 10,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 15) / 100
  },
  {
    id: 'coffee-kilo',
    description: 'Any 1kg bag of beans: 150 off each bag',
    applies: (line, cart) => line.product.category === 'coffee' && line.product.name.endsWith('1kg'),
    discount: (line, cart) => line.qty * 150
  },
  {
    id: 'kettle-with-tea',
    description: 'A kettle with at least 2 tea lines in the cart: 10% off the kettle',
    applies: (line, cart) => line.product.name.startsWith('Kettle') && cart.lines.filter((l) => l.product.category === 'tea').length >= 2,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 10) / 100
  },
  {
    id: 'crockery-set',
    description: '4 or more of one crockery item: 12% off that line',
    applies: (line, cart) => line.product.category === 'crockery' && line.qty >= 4,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 12) / 100
  },
  {
    id: 'biscuit-dozen',
    description: '12 or more of one biscuit: one in twelve free',
    applies: (line, cart) => line.product.category === 'biscuits' && line.qty >= 12,
    discount: (line, cart) => Math.floor(line.qty / 12) * line.product.priceCents
  },
  {
    id: 'gift-season',
    description: 'Gifts in the season (cart.season true): 7% off',
    applies: (line, cart) => line.product.category === 'gifts' && cart.season === true,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 7) / 100
  },
  {
    id: 'kit-pro-trade',
    description: 'Pro kit for trade accounts: 20% off',
    applies: (line, cart) => line.product.category === 'kit' && line.product.name.endsWith('pro') && cart.account === 'trade',
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 20) / 100
  },
  {
    id: 'filter-papers-pack',
    description: 'Filter papers in packs of 5: 1 free per 5',
    applies: (line, cart) => line.product.name.startsWith('Filter papers') && line.qty >= 5,
    discount: (line, cart) => Math.floor(line.qty / 5) * line.product.priceCents
  },
  {
    id: 'tea-of-the-month-assam',
    description: 'Assam is a tea of the month when cart.month matches: 10% off',
    applies: (line, cart) => line.product.name.startsWith('Assam') && cart.month === 'assam',
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 10) / 100
  },
  {
    id: 'tea-of-the-month-darjeeling',
    description: 'Darjeeling is a tea of the month when cart.month matches: 10% off',
    applies: (line, cart) => line.product.name.startsWith('Darjeeling') && cart.month === 'darjeeling',
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 10) / 100
  },
  {
    id: 'tea-of-the-month-sencha',
    description: 'Sencha is a tea of the month when cart.month matches: 10% off',
    applies: (line, cart) => line.product.name.startsWith('Sencha') && cart.month === 'sencha',
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 10) / 100
  },
  {
    id: 'tea-of-the-month-oolong',
    description: 'Oolong is a tea of the month when cart.month matches: 10% off',
    applies: (line, cart) => line.product.name.startsWith('Oolong') && cart.month === 'oolong',
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 10) / 100
  },
  {
    id: 'tea-of-the-month-chai',
    description: 'Chai is a tea of the month when cart.month matches: 10% off',
    applies: (line, cart) => line.product.name.startsWith('Chai') && cart.month === 'chai',
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 10) / 100
  },
  {
    id: 'tea-of-the-month-rooibos',
    description: 'Rooibos is a tea of the month when cart.month matches: 10% off',
    applies: (line, cart) => line.product.name.startsWith('Rooibos') && cart.month === 'rooibos',
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 10) / 100
  },
  {
    id: 'origin-week-colombia',
    description: 'Colombia origin week (cart.originWeek): 12% off',
    applies: (line, cart) => line.product.name.startsWith('Colombia') && cart.originWeek === 'colombia',
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 12) / 100
  },
  {
    id: 'origin-week-ethiopia',
    description: 'Ethiopia origin week (cart.originWeek): 12% off',
    applies: (line, cart) => line.product.name.startsWith('Ethiopia') && cart.originWeek === 'ethiopia',
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 12) / 100
  },
  {
    id: 'origin-week-kenya',
    description: 'Kenya origin week (cart.originWeek): 12% off',
    applies: (line, cart) => line.product.name.startsWith('Kenya') && cart.originWeek === 'kenya',
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 12) / 100
  },
  {
    id: 'origin-week-sumatra',
    description: 'Sumatra origin week (cart.originWeek): 12% off',
    applies: (line, cart) => line.product.name.startsWith('Sumatra') && cart.originWeek === 'sumatra',
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 12) / 100
  },
  {
    id: 'staff',
    description: 'Staff accounts: 25% off anything but gifts',
    applies: (line, cart) => cart.account === 'staff' && line.product.category !== 'gifts',
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 25) / 100
  },
  {
    id: 'clearance-tea-0004',
    description: 'Clearance: Darjeeling tin, 25% off while stock lasts',
    applies: (line, cart) => line.sku === 'TEA-0004' && cart.clearance === true,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 25) / 100
  },
  {
    id: 'clearance-tea-0011',
    description: 'Clearance: Lapsang pouch, 20% off while stock lasts',
    applies: (line, cart) => line.sku === 'TEA-0011' && cart.clearance === true,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 20) / 100
  },
  {
    id: 'clearance-tea-0018',
    description: 'Clearance: Oolong bags x40, 20% off while stock lasts',
    applies: (line, cart) => line.sku === 'TEA-0018' && cart.clearance === true,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 20) / 100
  },
  {
    id: 'clearance-tea-0025',
    description: 'Clearance: Jasmine tin, 30% off while stock lasts',
    applies: (line, cart) => line.sku === 'TEA-0025' && cart.clearance === true,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 30) / 100
  },
  {
    id: 'clearance-tea-0032',
    description: 'Clearance: Nilgiri pouch, 20% off while stock lasts',
    applies: (line, cart) => line.sku === 'TEA-0032' && cart.clearance === true,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 20) / 100
  },
  {
    id: 'clearance-cof-0039',
    description: 'Clearance: Colombia beans 1kg, 40% off while stock lasts',
    applies: (line, cart) => line.sku === 'COF-0039' && cart.clearance === true,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 40) / 100
  },
  {
    id: 'clearance-cof-0046',
    description: 'Clearance: Sumatra beans 250g, 30% off while stock lasts',
    applies: (line, cart) => line.sku === 'COF-0046' && cart.clearance === true,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 30) / 100
  },
  {
    id: 'clearance-cof-0053',
    description: 'Clearance: Brazil ground 250g, 20% off while stock lasts',
    applies: (line, cart) => line.sku === 'COF-0053' && cart.clearance === true,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 20) / 100
  },
  {
    id: 'clearance-cof-0060',
    description: 'Clearance: Decaf beans 1kg, 40% off while stock lasts',
    applies: (line, cart) => line.sku === 'COF-0060' && cart.clearance === true,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 40) / 100
  },
  {
    id: 'clearance-bis-0067',
    description: 'Clearance: Shortbread box, 30% off while stock lasts',
    applies: (line, cart) => line.sku === 'BIS-0067' && cart.clearance === true,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 30) / 100
  },
  {
    id: 'clearance-bis-0074',
    description: 'Clearance: Chocolate chip tin, 20% off while stock lasts',
    applies: (line, cart) => line.sku === 'BIS-0074' && cart.clearance === true,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 20) / 100
  },
  {
    id: 'clearance-bis-0081',
    description: 'Clearance: Spelt box, 30% off while stock lasts',
    applies: (line, cart) => line.sku === 'BIS-0081' && cart.clearance === true,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 30) / 100
  },
  {
    id: 'clearance-cro-0088',
    description: 'Clearance: Teapot speckled, 25% off while stock lasts',
    applies: (line, cart) => line.sku === 'CRO-0088' && cart.clearance === true,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 25) / 100
  },
  {
    id: 'clearance-cro-0095',
    description: 'Clearance: Sugar bowl white, 40% off while stock lasts',
    applies: (line, cart) => line.sku === 'CRO-0095' && cart.clearance === true,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 40) / 100
  },
  {
    id: 'clearance-cro-0102',
    description: 'Clearance: Tea caddy blue, 40% off while stock lasts',
    applies: (line, cart) => line.sku === 'CRO-0102' && cart.clearance === true,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 40) / 100
  },
  {
    id: 'clearance-kit-0109',
    description: 'Clearance: Cafetière standard, 40% off while stock lasts',
    applies: (line, cart) => line.sku === 'KIT-0109' && cart.clearance === true,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 40) / 100
  },
  {
    id: 'clearance-kit-0116',
    description: 'Clearance: Thermometer pro, 20% off while stock lasts',
    applies: (line, cart) => line.sku === 'KIT-0116' && cart.clearance === true,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 20) / 100
  },
  {
    id: 'clearance-kit-0123',
    description: 'Clearance: Filter papers standard, 20% off while stock lasts',
    applies: (line, cart) => line.sku === 'KIT-0123' && cart.clearance === true,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 20) / 100
  },
  {
    id: 'clearance-gif-0130',
    description: 'Clearance: Gift card large, 40% off while stock lasts',
    applies: (line, cart) => line.sku === 'GIF-0130' && cart.clearance === true,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 40) / 100
  },
  {
    id: 'clearance-tea-0007',
    description: 'Clearance: Earl Grey tin, 30% off while stock lasts',
    applies: (line, cart) => line.sku === 'TEA-0007' && cart.clearance === true,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 30) / 100
  },
  {
    id: 'clearance-tea-0014',
    description: 'Clearance: Sencha pouch, 25% off while stock lasts',
    applies: (line, cart) => line.sku === 'TEA-0014' && cart.clearance === true,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 25) / 100
  },
  {
    id: 'clearance-tea-0021',
    description: 'Clearance: Rooibos bags x40, 30% off while stock lasts',
    applies: (line, cart) => line.sku === 'TEA-0021' && cart.clearance === true,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 30) / 100
  },
  {
    id: 'clearance-tea-0028',
    description: 'Clearance: Ceylon tin, 25% off while stock lasts',
    applies: (line, cart) => line.sku === 'TEA-0028' && cart.clearance === true,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 25) / 100
  },
  {
    id: 'clearance-tea-0035',
    description: 'Clearance: Genmaicha pouch, 40% off while stock lasts',
    applies: (line, cart) => line.sku === 'TEA-0035' && cart.clearance === true,
    discount: (line, cart) => Math.round(line.product.priceCents * line.qty * 40) / 100
  },
]

/** Every rule that applies to a line, with what it would take off. */
function applicableRules(line, cart) {
  return RULES.filter((r) => r.applies(line, cart)).map((r) => ({ id: r.id, cents: Math.round(r.discount(line, cart)) }))
}

/** The best single discount for a line: { id, cents }, or null when none applies. */
function bestDiscount(line, cart) {
  const all = applicableRules(line, cart)
  if (all.length === 0) return null
  return all.reduce((best, r) => (r.cents > best.cents ? r : best))
}

module.exports = { RULES, applicableRules, bestDiscount }
