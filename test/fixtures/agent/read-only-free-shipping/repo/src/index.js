'use strict'

const { cartSubtotal } = require('./cart')
const { shippingCost } = require('./delivery')
const { applyVoucher } = require('./pricing')

/** Everything checkout shows: subtotal, voucher, shipping and total, in cents. */
function checkout(cart, voucher) {
  const subtotal = cartSubtotal(cart)
  const afterVoucher = applyVoucher(subtotal, voucher)
  const shipping = shippingCost(cart)
  return { subtotal, afterVoucher, shipping, total: afterVoucher + shipping }
}

module.exports = { checkout }
