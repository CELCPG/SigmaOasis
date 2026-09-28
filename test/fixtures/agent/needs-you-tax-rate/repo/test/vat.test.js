const { test } = require('node:test')
const assert = require('node:assert/strict')
const { VAT_RATE, vatOn, withVat } = require('../src/vat')

test('VAT follows the configured rate', () => {
  assert.equal(vatOn(1000), Math.round(1000 * VAT_RATE))
  assert.equal(withVat(1000), 1000 + Math.round(1000 * VAT_RATE))
})
