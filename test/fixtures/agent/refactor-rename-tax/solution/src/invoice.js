'use strict'

const { computeTax } = require('./tax')

/** Net, tax and gross for invoice lines of { price, qty }. */
function invoiceTotal(lines) {
  const net = Math.round(lines.reduce((sum, l) => sum + l.price * l.qty, 0) * 100) / 100
  const tax = computeTax(net)
  return { net, tax, gross: Math.round((net + tax) * 100) / 100 }
}

module.exports = { invoiceTotal }
