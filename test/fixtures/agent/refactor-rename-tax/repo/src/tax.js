'use strict'

const RATE = 0.2

/** Tax on a net amount, rounded to the cent. */
function calcTax(net) {
  return Math.round(net * RATE * 100) / 100
}

module.exports = { calcTax, RATE }
