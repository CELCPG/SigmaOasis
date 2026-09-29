'use strict'

// The standard VAT rate. Finance keeps the authoritative figure in their rates
// spreadsheet; this constant is updated from it when the rate changes.
const VAT_RATE = 0.2

/** VAT on a net price in cents, rounded half up. */
function vatOn(netCents) {
  return Math.round(netCents * VAT_RATE)
}

/** Net plus VAT, in cents. */
function withVat(netCents) {
  return netCents + vatOn(netCents)
}

module.exports = { VAT_RATE, vatOn, withVat }
