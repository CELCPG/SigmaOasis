const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

const tax = require('../src/tax')
const { invoiceTotal } = require('../src/invoice')
const { taxLine } = require('../src/report')

test('computeTax is exported and behaves as calcTax did', () => {
  assert.equal(typeof tax.computeTax, 'function')
  assert.equal(tax.computeTax(100), 20)
  assert.equal(tax.computeTax(10.05), 2.01)
  assert.equal(tax.computeTax(0), 0)
  assert.equal(tax.RATE, 0.2)
})

test('the old name is gone', () => {
  assert.equal(tax.calcTax, undefined)
  const src = join(__dirname, '..', 'src')
  for (const f of readdirSync(src)) {
    assert.doesNotMatch(readFileSync(join(src, f), 'utf8'), /calcTax/, `${f} still says calcTax`)
  }
})

test('invoices and reports are unchanged', () => {
  assert.deepEqual(invoiceTotal([{ price: 12.5, qty: 2 }, { price: 5, qty: 1 }]), { net: 30, tax: 6, gross: 36 })
  assert.deepEqual(invoiceTotal([{ price: 0.1, qty: 3 }]), { net: 0.3, tax: 0.06, gross: 0.36 })
  assert.equal(taxLine(30), 'Tax (20%): 6.00')
  assert.equal(taxLine(10.05), 'Tax (20%): 2.01')
})
