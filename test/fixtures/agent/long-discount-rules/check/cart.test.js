const { test } = require('node:test')
const assert = require('node:assert/strict')
const { priceCart } = require('../src/cart')
const { RULES } = require('../src/rules')

const MIXED = {"lines":[{"sku":"TEA-0028","qty":12},{"sku":"TEA-0026","qty":2},{"sku":"COF-0039","qty":1},{"sku":"CRO-0083","qty":4},{"sku":"BIS-0069","qty":3}],"member":true}
const KETTLE = {"lines":[{"sku":"KIT-0107","qty":1},{"sku":"TEA-0026","qty":1},{"sku":"TEA-0031","qty":1}]}
const SMALL = {"lines":[{"sku":"BIS-0069","qty":1}]}
const BULK = {"lines":[{"sku":"TEA-0031","qty":10}]}

test('the mixed basket', () => {
  const r = priceCart(MIXED)
  assert.equal(r.total, 17027)
  assert.equal(r.lines[0].rule, 'tea-bulk-tins')
})

test('ten tins alone take the bulk discount', () => {
  const r = priceCart(BULK)
  assert.equal(r.lines[0].rule, 'tea-bulk-tins')
  assert.equal(r.total, 7820)
})

test('nine tins do not', () => {
  const r = priceCart({ lines: [{ sku: 'TEA-0031', qty: 9 }] })
  assert.notEqual(r.lines[0].rule, 'tea-bulk-tins')
})

test('the other baskets are unchanged', () => {
  assert.equal(priceCart(KETTLE).total, 12449)
  assert.equal(priceCart(SMALL).total, 795)
})

test('every rule is still there', () => {
  assert.equal(RULES.length, 55)
})
