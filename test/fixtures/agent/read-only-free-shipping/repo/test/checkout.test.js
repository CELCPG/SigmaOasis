const { test } = require('node:test')
const assert = require('node:assert/strict')
const { checkout } = require('../src')

const mug = { priceCents: 1200, qty: 1 }
const chair = { priceCents: 8900, qty: 1, oversized: true }

test('a small order pays standard shipping', () => {
  assert.equal(checkout({ lines: [mug] }).shipping, 495)
})

test('a large order ships free', () => {
  assert.equal(checkout({ lines: [{ ...mug, qty: 5 }] }).shipping, 0)
})

test('an oversized item never ships free', () => {
  assert.equal(checkout({ lines: [chair] }).shipping, 2995)
})
