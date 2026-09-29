'use strict'

const { calcTax, RATE } = require('./tax')

/** The tax line printed at the foot of a report. */
function taxLine(net) {
  return `Tax (${Math.round(RATE * 100)}%): ${calcTax(net).toFixed(2)}`
}

module.exports = { taxLine }
