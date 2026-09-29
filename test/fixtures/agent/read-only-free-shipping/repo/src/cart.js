'use strict'

/** Sum of price × quantity over the cart's lines, in cents. */
function cartSubtotal(cart) {
  return cart.lines.reduce((sum, line) => sum + line.priceCents * line.qty, 0)
}

/** True when any line is flagged as oversized (furniture, large appliances). */
function hasOversizedItem(cart) {
  return cart.lines.some((line) => line.oversized === true)
}

module.exports = { cartSubtotal, hasOversizedItem }
