'use strict'

const { qualifiesForFreeShipping } = require('./shipping')

const STANDARD_CENTS = 495
const OVERSIZED_SURCHARGE_CENTS = 2500

/** What delivery costs for a cart, in cents. */
function shippingCost(cart) {
  if (qualifiesForFreeShipping(cart)) return 0
  const surcharge = cart.lines.some((l) => l.oversized) ? OVERSIZED_SURCHARGE_CENTS : 0
  return STANDARD_CENTS + surcharge
}

module.exports = { shippingCost }
