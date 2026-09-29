const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const { readXlsx } = require('./xlsx')
const ROOT = join(__dirname, '..')

test('the total row is at the bottom, and every original row is still there', () => {
  const sheets = readXlsx(readFileSync(join(ROOT, 'expenses.xlsx')))
  assert.equal(sheets.length, 1)
  assert.equal(sheets[0].name, 'March')
  const rows = sheets[0].rows
  assert.deepEqual(rows[0].slice(0, 3), ['Date', 'Category', 'Amount'])
  const originals = [
    ['2026-03-02', 'Travel', 120.5],
    ['2026-03-04', 'Meals', 42.1],
    ['2026-03-09', 'Software', 299],
    ['2026-03-15', 'Meals', 18.4],
    ['2026-03-22', 'Travel', 305.25],
    ['2026-03-28', 'Office', 64.99]
  ]
  for (let i = 0; i < originals.length; i++) assert.deepEqual(rows[i + 1].slice(0, 3), originals[i], 'row ' + (i + 1))
  const last = rows[rows.length - 1]
  assert.equal(String(last[1]).trim().toLowerCase(), 'total')
  assert.equal(Math.round(Number(last[2]) * 100) / 100, 850.24)
})
