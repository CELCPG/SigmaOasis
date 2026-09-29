'use strict'

const { cartSubtotal, hasOversizedItem } = require('./cart')

const FREE_SHIPPING_THRESHOLD_CENTS = 5000

/**
 * Orders of 50.00 or more ship free, unless something in them is oversized,
 * or the address is outside the mainland.
 */
function qualifiesForFreeShipping(cart) {
  if (hasOversizedItem(cart)) return false
  if (cart.address && cart.address.region !== 'mainland') return false
  return cartSubtotal(cart) >= FREE_SHIPPING_THRESHOLD_CENTS
}

module.exports = { qualifiesForFreeShipping, FREE_SHIPPING_THRESHOLD_CENTS }
