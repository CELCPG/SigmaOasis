const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const { readXlsx } = require('./xlsx')
const ROOT = join(__dirname, '..')

test('merged.xlsx has the four orders joined to their customers', () => {
  const file = join(ROOT, 'merged.xlsx')
  assert.ok(existsSync(file), 'merged.xlsx is missing')
  const sheets = readXlsx(readFileSync(file))
  const sheet = sheets.find((s) => s.name === 'Orders') || sheets[0]
  assert.equal(sheet.name, 'Orders')
  const header = sheet.rows[0].map((c) => String(c).trim().toLowerCase())
  assert.deepEqual(header.slice(0, 4), ['order_id', 'name', 'email', 'amount'])
  const body = sheet.rows.slice(1).filter((r) => r.some((c) => c !== null && c !== '')).map((r) => [Number(r[0]), String(r[1]), String(r[2]), Number(r[3])])
  assert.deepEqual(body, [
    [1001, 'Grace Hopper', 'grace@example.com', 49.99],
    [1002, 'Ada Lovelace', 'ada@example.com', 15],
    [1003, 'Linus Torvalds', 'linus@example.com', 120],
    [1004, 'Ada Lovelace', 'ada@example.com', 7.25]
  ])
})
