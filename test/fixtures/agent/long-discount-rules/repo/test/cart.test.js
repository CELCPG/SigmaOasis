const { test } = require('node:test')
const assert = require('node:assert/strict')
const { priceCart } = require('../src/cart')

const MIXED = {"lines":[{"sku":"TEA-0028","qty":12},{"sku":"TEA-0026","qty":2},{"sku":"COF-0039","qty":1},{"sku":"CRO-0083","qty":4},{"sku":"BIS-0069","qty":3}],"member":true}
const KETTLE = {"lines":[{"sku":"KIT-0107","qty":1},{"sku":"TEA-0026","qty":1},{"sku":"TEA-0031","qty":1}]}
const SMALL = {"lines":[{"sku":"BIS-0069","qty":1}]}

test('a small basket pays delivery', () => {
  assert.equal(priceCart(SMALL).total, 795)
})

test('a kettle bought with two teas is discounted', () => {
  assert.equal(priceCart(KETTLE).total, 12449)
})

test('the mixed basket from the March receipts totals 17027', () => {
  assert.equal(priceCart(MIXED).total, 17027)
})
