'use strict'

const { product } = require('./catalog')
const { bestDiscount } = require('./rules')

/** Members get this off the subtotal after line discounts. */
const MEMBER_PERCENT = 5
/** Delivery, free from this subtotal (after discounts) upward. */
const DELIVERY_CENTS = 395
const FREE_DELIVERY_FROM_CENTS = 4000

/**
 * Price a cart: { lines: [{ sku, qty }], member?, account?, season?, month?, originWeek? }.
 * Returns every step, in cents, so a receipt can show its working.
 */
function priceCart(cart) {
  if (!cart || !Array.isArray(cart.lines)) throw new TypeError('cart.lines must be an array')
  const lines = cart.lines.map((l) => {
    if (!Number.isInteger(l.qty) || l.qty < 1) throw new RangeError(`bad quantity for ${l.sku}`)
    return { sku: l.sku, qty: l.qty, product: product(l.sku) }
  })
  const full = { ...cart, lines }
  const priced = lines.map((line) => {
    const gross = line.product.priceCents * line.qty
    const best = bestDiscount(line, full)
    const off = best ? Math.min(best.cents, gross) : 0
    return { sku: line.sku, qty: line.qty, gross, discount: off, rule: best ? best.id : null, net: gross - off }
  })
  const subtotal = priced.reduce((s, l) => s + l.net, 0)
  const member = cart.member ? Math.round((subtotal * MEMBER_PERCENT) / 100) : 0
  const afterMember = subtotal - member
  const delivery = afterMember >= FREE_DELIVERY_FROM_CENTS || lines.length === 0 ? 0 : DELIVERY_CENTS
  return { lines: priced, subtotal, member, delivery, total: afterMember + delivery }
}

module.exports = { priceCart, MEMBER_PERCENT, DELIVERY_CENTS, FREE_DELIVERY_FROM_CENTS }
