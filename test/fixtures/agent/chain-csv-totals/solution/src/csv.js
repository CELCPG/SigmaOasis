'use strict'

/**
 * Parse a CSV export: a header row, then one row per line. No quoting — the
 * exports this reads never contain commas inside a field.
 */
function parseCsv(text) {
  const [header, ...lines] = text.split('\n').filter((l) => l.trim() !== '')
  const cols = header.split(',').map((c) => c.trim())
  return lines.map((line, i) => {
    const cells = line.split(',').map((c) => c.trim())
    if (cells.length !== cols.length) throw new Error(`bad row at line ${i + 2}: ${JSON.stringify(line)}`)
    return Object.fromEntries(cols.map((c, j) => [c, cells[j]]))
  })
}

/** How many expenses, and what they add up to (refunds are negative). */
function summarize(text) {
  const rows = parseCsv(text)
  const total = rows.reduce((sum, r) => sum + Number(r.amount), 0)
  return { count: rows.length, total: Math.round(total * 100) / 100 }
}

module.exports = { parseCsv, summarize }
