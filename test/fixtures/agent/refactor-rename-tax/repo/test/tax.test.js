const { test } = require('node:test')
const assert = require('node:assert/strict')
const { calcTax } = require('../src/tax')
const { invoiceTotal } = require('../src/invoice')
const { taxLine } = require('../src/report')

test('tax is a fifth of the net, to the cent', () => {
  assert.equal(calcTax(100), 20)
  assert.equal(calcTax(10.05), 2.01)
})

test('an invoice adds tax to the net', () => {
  assert.deepEqual(invoiceTotal([{ price: 12.5, qty: 2 }, { price: 5, qty: 1 }]), { net: 30, tax: 6, gross: 36 })
})

test('the report prints the tax line', () => {
  assert.equal(taxLine(30), 'Tax (20%): 6.00')
})
