// Generates this fixture's repo/, solution/, check/, task.md and case.json,
// deterministically: the same files every run. The expected totals in the
// tests are computed from the fixed rules, so they are exact by construction.
//
//   node test/fixtures/agent/long-discount-rules/generate.js
'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

const out = process.argv[2] || __dirname

// ---- a deterministic PRNG ---------------------------------------------------
let seed = 20260928
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const pick = (xs) => xs[Math.floor(rand() * xs.length)]

// ---- catalog ------------------------------------------------------------------
const CATEGORIES = {
  tea: ['Assam', 'Darjeeling', 'Earl Grey', 'Lapsang', 'Sencha', 'Oolong', 'Rooibos', 'Chai', 'Jasmine', 'Ceylon', 'Nilgiri', 'Genmaicha'],
  coffee: ['Colombia', 'Ethiopia', 'Kenya', 'Sumatra', 'Guatemala', 'Brazil', 'Espresso', 'Decaf', 'Costa Rica', 'Peru'],
  biscuits: ['Shortbread', 'Oat', 'Ginger', 'Chocolate chip', 'Almond', 'Lemon', 'Hazelnut', 'Spelt'],
  crockery: ['Mug', 'Teapot', 'Cup and saucer', 'Milk jug', 'Sugar bowl', 'Espresso cup', 'Tea caddy', 'Tray'],
  kit: ['Kettle', 'Cafetière', 'Grinder', 'Scale', 'Thermometer', 'Strainer', 'Infuser', 'Timer', 'Filter papers'],
  gifts: ['Taster box', 'Hamper', 'Gift card', 'Advent calendar', 'Subscription']
}
const FORMS = { tea: ['tin', 'pouch', 'bags x40'], coffee: ['beans 250g', 'ground 250g', 'beans 1kg'], biscuits: ['box', 'tin'], crockery: ['white', 'blue', 'speckled'], kit: ['standard', 'pro'], gifts: ['small', 'large'] }
const PRICE = { tea: [450, 1450], coffee: [650, 2400], biscuits: [250, 900], crockery: [800, 4500], kit: [900, 12900], gifts: [1500, 7500] }
const catalog = []
let n = 1
for (const [cat, names] of Object.entries(CATEGORIES)) {
  for (const name of names) {
    for (const form of FORMS[cat]) {
      if (catalog.length >= 130) break
      const [lo, hi] = PRICE[cat]
      const price = Math.round((lo + rand() * (hi - lo)) / 5) * 5
      catalog.push({ sku: `${cat.slice(0, 3).toUpperCase()}-${String(n++).padStart(4, '0')}`, name: `${name} ${form}`, category: cat, priceCents: price })
    }
  }
}
const q = (s) => `'${s.replace(/'/g, "\\'")}'`
const catalogJs = `'use strict'

/**
 * Everything the shop sells. Prices are in cents, before any discount.
 * Categories: ${Object.keys(CATEGORIES).join(', ')}.
 */
const CATALOG = [
${catalog.map((p) => `  { sku: ${q(p.sku)}, name: ${q(p.name)}, category: ${q(p.category)}, priceCents: ${p.priceCents} },`).join('\n')}
]

const BY_SKU = new Map(CATALOG.map((p) => [p.sku, p]))

/** The product for a SKU; throws for one the shop does not sell. */
function product(sku) {
  const p = BY_SKU.get(sku)
  if (!p) throw new Error(\`Unknown SKU: \${sku}\`)
  return p
}

module.exports = { CATALOG, product }
`

// ---- rules ----------------------------------------------------------------------
// Each rule: id, description, applies(line, cart), discount(line, cart) in cents.
// line = { sku, qty, product }. Only the best rule for a line is used.
const rules = []
const pct = (p) => `Math.round(line.product.priceCents * line.qty * ${p}) / 100`
for (const [cat] of Object.entries(CATEGORIES)) {
  rules.push({ id: `${cat}-multibuy-3`, desc: `3 or more of one ${cat} item: 5% off that line`, applies: `line.product.category === '${cat}' && line.qty >= 3`, discount: `${pct(5)}` })
  rules.push({ id: `${cat}-multibuy-6`, desc: `6 or more of one ${cat} item: 8% off that line`, applies: `line.product.category === '${cat}' && line.qty >= 6`, discount: `${pct(8)}` })
}
// The rule with the bug in the shipped repo: it reads line.quantity.
rules.push({ id: 'tea-bulk-tins', desc: '10 or more tins of one tea: 15% off that line', applies: "line.product.category === 'tea' && line.product.name.endsWith('tin') && line.qty >= 10", discount: `${pct(15)}`, buggy: true })
rules.push({ id: 'coffee-kilo', desc: 'Any 1kg bag of beans: 150 off each bag', applies: "line.product.category === 'coffee' && line.product.name.endsWith('1kg')", discount: 'line.qty * 150' })
rules.push({ id: 'kettle-with-tea', desc: 'A kettle with at least 2 tea lines in the cart: 10% off the kettle', applies: "line.product.name.startsWith('Kettle') && cart.lines.filter((l) => l.product.category === 'tea').length >= 2", discount: `${pct(10)}` })
rules.push({ id: 'crockery-set', desc: '4 or more of one crockery item: 12% off that line', applies: "line.product.category === 'crockery' && line.qty >= 4", discount: `${pct(12)}` })
rules.push({ id: 'biscuit-dozen', desc: '12 or more of one biscuit: one in twelve free', applies: "line.product.category === 'biscuits' && line.qty >= 12", discount: 'Math.floor(line.qty / 12) * line.product.priceCents' })
rules.push({ id: 'gift-season', desc: 'Gifts in the season (cart.season true): 7% off', applies: "line.product.category === 'gifts' && cart.season === true", discount: `${pct(7)}` })
rules.push({ id: 'kit-pro-trade', desc: 'Pro kit for trade accounts: 20% off', applies: "line.product.category === 'kit' && line.product.name.endsWith('pro') && cart.account === 'trade'", discount: `${pct(20)}` })
rules.push({ id: 'filter-papers-pack', desc: 'Filter papers in packs of 5: 1 free per 5', applies: "line.product.name.startsWith('Filter papers') && line.qty >= 5", discount: 'Math.floor(line.qty / 5) * line.product.priceCents' })
for (const name of ['Assam', 'Darjeeling', 'Sencha', 'Oolong', 'Chai', 'Rooibos']) {
  rules.push({ id: `tea-of-the-month-${name.toLowerCase()}`, desc: `${name} is a tea of the month when cart.month matches: 10% off`, applies: `line.product.name.startsWith('${name}') && cart.month === '${name.toLowerCase()}'`, discount: `${pct(10)}` })
}
for (const name of ['Colombia', 'Ethiopia', 'Kenya', 'Sumatra']) {
  rules.push({ id: `origin-week-${name.toLowerCase().replace(/\s+/g, '-')}`, desc: `${name} origin week (cart.originWeek): 12% off`, applies: `line.product.name.startsWith('${name}') && cart.originWeek === '${name.toLowerCase()}'`, discount: `${pct(12)}` })
}
rules.push({ id: 'staff', desc: 'Staff accounts: 25% off anything but gifts', applies: "cart.account === 'staff' && line.product.category !== 'gifts'", discount: `${pct(25)}` })
// Clearance lines: live only while cart.clearance is set, so no test basket uses them.
for (let i = 0; i < 24; i++) {
  const p = catalog[(i * 7 + 3) % catalog.length]
  const off = pick([20, 25, 30, 40])
  rules.push({ id: `clearance-${p.sku.toLowerCase()}`, desc: `Clearance: ${p.name}, ${off}% off while stock lasts`, applies: `line.sku === '${p.sku}' && cart.clearance === true`, discount: `${pct(off)}` })
}

const ruleJs = (fixed) => `'use strict'

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
${rules
  .map((r) => {
    const applies = r.buggy && !fixed ? r.applies.replace('line.qty', 'line.quantity') : r.applies
    return `  {
    id: ${q(r.id)},
    description: ${q(r.desc)},
    applies: (line, cart) => ${applies},
    discount: (line, cart) => ${r.discount}
  },`
  })
  .join('\n')}
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
`

// ---- cart ------------------------------------------------------------------------
const cartJs = `'use strict'

const { product } = require('./catalog')
const { bestDiscount } = require('./rules')

/** Members get this off the subtotal after line discounts. */
const MEMBER_PERCENT = 5
/** Delivery, free from this subtotal (after discounts) upward. */
const DELIVERY_CENTS = 395
const FREE_DELIVERY_FROM_CENTS = 4000

/**
 * Price a cart: { lines: [{ sku, qty }], member?, account?, season?, month?, originWeek? }.
 * Returns every step, in cents, so a receipt can show its working.
 */
function priceCart(cart) {
  if (!cart || !Array.isArray(cart.lines)) throw new TypeError('cart.lines must be an array')
  const lines = cart.lines.map((l) => {
    if (!Number.isInteger(l.qty) || l.qty < 1) throw new RangeError(\`bad quantity for \${l.sku}\`)
    return { sku: l.sku, qty: l.qty, product: product(l.sku) }
  })
  const full = { ...cart, lines }
  const priced = lines.map((line) => {
    const gross = line.product.priceCents * line.qty
    const best = bestDiscount(line, full)
    const off = best ? Math.min(best.cents, gross) : 0
    return { sku: line.sku, qty: line.qty, gross, discount: off, rule: best ? best.id : null, net: gross - off }
  })
  const subtotal = priced.reduce((s, l) => s + l.net, 0)
  const member = cart.member ? Math.round((subtotal * MEMBER_PERCENT) / 100) : 0
  const afterMember = subtotal - member
  const delivery = afterMember >= FREE_DELIVERY_FROM_CENTS || lines.length === 0 ? 0 : DELIVERY_CENTS
  return { lines: priced, subtotal, member, delivery, total: afterMember + delivery }
}

module.exports = { priceCart, MEMBER_PERCENT, DELIVERY_CENTS, FREE_DELIVERY_FROM_CENTS }
`

const formatJs = `'use strict'

/** 12345 → '123.45' */
function money(cents) {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return \`\${sign}\${Math.floor(abs / 100)}.\${String(abs % 100).padStart(2, '0')}\`
}

/** A receipt, one line per cart line, then the totals. */
function receipt(priced) {
  const rows = priced.lines.map((l) => \`\${l.qty} × \${l.sku}  \${money(l.gross)}\${l.discount ? \`  -\${money(l.discount)} (\${l.rule})\` : ''}\`)
  rows.push(\`Subtotal  \${money(priced.subtotal)}\`)
  if (priced.member) rows.push(\`Member  -\${money(priced.member)}\`)
  rows.push(\`Delivery  \${money(priced.delivery)}\`)
  rows.push(\`Total  \${money(priced.total)}\`)
  return rows.join('\\n')
}

module.exports = { money, receipt }
`

// ---- baskets ----------------------------------------------------------------------
const bySku = (pred) => catalog.find(pred).sku
const teaTin = catalog.find((p) => p.category === 'tea' && p.name.endsWith('tin') && p.name.startsWith('Ceylon'))
const teaTin2 = catalog.find((p) => p.category === 'tea' && p.name.endsWith('tin') && p.name.startsWith('Nilgiri'))
const pouch = bySku((p) => p.category === 'tea' && p.name.endsWith('pouch') && p.name.startsWith('Jasmine'))
const kilo = bySku((p) => p.category === 'coffee' && p.name.endsWith('1kg'))
const mug = bySku((p) => p.category === 'crockery' && p.name.startsWith('Mug'))
const biscuit = bySku((p) => p.category === 'biscuits' && p.name.startsWith('Oat'))
const kettle = bySku((p) => p.name.startsWith('Kettle'))
const baskets = {
  mixed: { lines: [{ sku: teaTin.sku, qty: 12 }, { sku: pouch, qty: 2 }, { sku: kilo, qty: 1 }, { sku: mug, qty: 4 }, { sku: biscuit, qty: 3 }], member: true },
  kettle: { lines: [{ sku: kettle, qty: 1 }, { sku: pouch, qty: 1 }, { sku: teaTin2.sku, qty: 1 }] },
  small: { lines: [{ sku: biscuit, qty: 1 }] },
  bulkOnly: { lines: [{ sku: teaTin2.sku, qty: 10 }] }
}

// ---- write and compute ----------------------------------------------------------
const write = (rel, body) => {
  const p = path.join(out, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-long-'))
fs.mkdirSync(path.join(tmp, 'src'))
fs.writeFileSync(path.join(tmp, 'src', 'catalog.js'), catalogJs)
fs.writeFileSync(path.join(tmp, 'src', 'rules.js'), ruleJs(true))
fs.writeFileSync(path.join(tmp, 'src', 'cart.js'), cartJs)
const script = `const { priceCart } = require('./src/cart'); const b = ${JSON.stringify(baskets)}; const r = {}; for (const k in b) r[k] = priceCart(b[k]); console.log(JSON.stringify(r))`
fs.writeFileSync(path.join(tmp, 'calc.js'), script)
const priced = JSON.parse(execFileSync(process.execPath, [path.join(tmp, 'calc.js')]).toString())
fs.writeFileSync(path.join(tmp, 'src', 'rules.js'), ruleJs(false))
const buggy = JSON.parse(execFileSync(process.execPath, [path.join(tmp, 'calc.js')]).toString())
fs.rmSync(tmp, { recursive: true, force: true })
if (priced.mixed.total === buggy.mixed.total) throw new Error('the bug does not change the mixed basket')
if (priced.kettle.total !== buggy.kettle.total) throw new Error('the bug should not change the kettle basket')

const pkg = JSON.stringify({ name: 'tea-shop', version: '4.2.0', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n'
write('repo/package.json', pkg)
write('repo/src/catalog.js', catalogJs)
write('repo/src/rules.js', ruleJs(false))
write('repo/src/cart.js', cartJs)
write('repo/src/format.js', formatJs)
write('solution/src/rules.js', ruleJs(true))
write(
  'repo/test/cart.test.js',
  `const { test } = require('node:test')
const assert = require('node:assert/strict')
const { priceCart } = require('../src/cart')

const MIXED = ${JSON.stringify(baskets.mixed)}
const KETTLE = ${JSON.stringify(baskets.kettle)}
const SMALL = ${JSON.stringify(baskets.small)}

test('a small basket pays delivery', () => {
  assert.equal(priceCart(SMALL).total, ${priced.small.total})
})

test('a kettle bought with two teas is discounted', () => {
  assert.equal(priceCart(KETTLE).total, ${priced.kettle.total})
})

test('the mixed basket from the March receipts totals ${priced.mixed.total}', () => {
  assert.equal(priceCart(MIXED).total, ${priced.mixed.total})
})
`
)
write(
  'check/cart.test.js',
  `const { test } = require('node:test')
const assert = require('node:assert/strict')
const { priceCart } = require('../src/cart')
const { RULES } = require('../src/rules')

const MIXED = ${JSON.stringify(baskets.mixed)}
const KETTLE = ${JSON.stringify(baskets.kettle)}
const SMALL = ${JSON.stringify(baskets.small)}
const BULK = ${JSON.stringify(baskets.bulkOnly)}

test('the mixed basket', () => {
  const r = priceCart(MIXED)
  assert.equal(r.total, ${priced.mixed.total})
  assert.equal(r.lines[0].rule, 'tea-bulk-tins')
})

test('ten tins alone take the bulk discount', () => {
  const r = priceCart(BULK)
  assert.equal(r.lines[0].rule, 'tea-bulk-tins')
  assert.equal(r.total, ${priced.bulkOnly.total})
})

test('nine tins do not', () => {
  const r = priceCart({ lines: [{ sku: ${q(teaTin2.sku)}, qty: 9 }] })
  assert.notEqual(r.lines[0].rule, 'tea-bulk-tins')
})

test('the other baskets are unchanged', () => {
  assert.equal(priceCart(KETTLE).total, ${priced.kettle.total})
  assert.equal(priceCart(SMALL).total, ${priced.small.total})
})

test('every rule is still there', () => {
  assert.equal(RULES.length, ${rules.length})
})
`
)
write('task.md', 'One of the cart tests fails: the mixed basket from the March receipts comes out at the wrong total. Find out why and fix it, then run the tests.\n')
write(
  'case.json',
  JSON.stringify({ kind: 'long', files: ['src/rules.js', 'src/cart.js', 'src/catalog.js', 'test/'], commands: ['npm test', 'node --test'], contextTokens: 16384 }, null, 2) + '\n'
)
const size = (s) => `${s.split('\n').length} lines, ${s.length} chars`
console.log('catalog', size(catalogJs), '| rules', size(ruleJs(false)), '| cart', size(cartJs))
console.log('mixed total fixed', priced.mixed.total, 'buggy', buggy.mixed.total)
