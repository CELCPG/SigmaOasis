'use strict'

const VOUCHERS = {
  WELCOME10: { kind: 'percent', value: 10 },
  FIVEOFF: { kind: 'fixed', valueCents: 500 }
}

/** The subtotal after a voucher, never below zero. Unknown codes change nothing. */
function applyVoucher(subtotalCents, code) {
  const v = code ? VOUCHERS[code.toUpperCase()] : undefined
  if (!v) return subtotalCents
  const off = v.kind === 'percent' ? Math.round((subtotalCents * v.value) / 100) : v.valueCents
  return Math.max(0, subtotalCents - off)
}

module.exports = { applyVoucher, VOUCHERS }
