// Tabulates .render-bench/results.jsonl, grouped by label.
//
// Reports the mean and the spread across runs of a label rather than a single
// number: one run of a GUI benchmark on a machine doing other things is not
// evidence, and a wide spread is the signal to re-run rather than to publish.
const fs = require('fs')
const path = require('path')

const FILE = process.argv[2] || path.join(__dirname, '../../.render-bench/results.jsonl')
if (!fs.existsSync(FILE)) {
  console.error(`no results at ${FILE} — run scripts/render-bench.sh first`)
  process.exit(1)
}

const rows = fs
  .readFileSync(FILE, 'utf-8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))

const byLabel = new Map()
for (const r of rows) {
  if (!byLabel.has(r.label)) byLabel.set(r.label, [])
  byLabel.get(r.label).push(r)
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
const fmt = (xs, unit = 'ms') => {
  const m = mean(xs)
  const lo = Math.min(...xs)
  const hi = Math.max(...xs)
  const body = unit === 's' ? `${(m / 1000).toFixed(1)}s` : `${Math.round(m)}ms`
  return xs.length > 1 ? `${body} (${Math.round(lo)}–${Math.round(hi)})` : body
}

const COLS = [
  ['runs', (rs) => String(rs.length)],
  ['CPU', (rs) => fmt(rs.map((r) => r.taskMs), 's')],
  ['JS', (rs) => fmt(rs.map((r) => r.scriptMs), 's')],
  ['layout', (rs) => fmt(rs.map((r) => r.layoutMs), 's')],
  ['input p95', (rs) => fmt(rs.map((r) => r.evalP95))],
  ['input max', (rs) => fmt(rs.map((r) => r.evalMax))],
  ['render lag', (rs) => fmt(rs.filter((r) => r.renderLagMs != null).map((r) => r.renderLagMs))]
]

const labels = [...byLabel.keys()]
const widths = COLS.map(([h], i) =>
  Math.max(h.length, ...labels.map((l) => COLS[i][1](byLabel.get(l)).length))
)
const labelWidth = Math.max('label'.length, ...labels.map((l) => l.length))

const line = (cells) =>
  cells.map((c, i) => String(c).padEnd(i === 0 ? labelWidth : widths[i - 1])).join('  ')

console.log(line(['label', ...COLS.map(([h]) => h)]))
console.log(line(['-'.repeat(labelWidth), ...widths.map((w) => '-'.repeat(w))]))
for (const label of labels) {
  const rs = byLabel.get(label)
  console.log(line([label, ...COLS.map(([, f]) => f(rs))]))
}

const chars = [...new Set(rows.map((r) => r.finalChars))]
const bubbles = [...new Set(rows.map((r) => r.priorBubbles))]
console.log(
  `\nrendered ${chars.join('/')} chars into ${bubbles.join('/')} prior bubbles` +
    (chars.length > 1 ? '  ← labels rendered DIFFERENT text; the comparison is invalid' : '')
)
