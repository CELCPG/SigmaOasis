'use strict'

/** 12345 → '123.45' */
function money(cents) {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** A receipt, one line per cart line, then the totals. */
function receipt(priced) {
  const rows = priced.lines.map((l) => `${l.qty} × ${l.sku}  ${money(l.gross)}${l.discount ? `  -${money(l.discount)} (${l.rule})` : ''}`)
  rows.push(`Subtotal  ${money(priced.subtotal)}`)
  if (priced.member) rows.push(`Member  -${money(priced.member)}`)
  rows.push(`Delivery  ${money(priced.delivery)}`)
  rows.push(`Total  ${money(priced.total)}`)
  return rows.join('\n')
}

module.exports = { money, receipt }
