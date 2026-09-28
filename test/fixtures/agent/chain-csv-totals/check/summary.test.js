const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { parseCsv, summarize } = require('../src/csv')

test('the March export', () => {
  const text = readFileSync(join(__dirname, '..', 'data', 'march.csv'), 'utf8')
  assert.deepEqual(summarize(text), { count: 4, total: 23.25 })
})

test('with or without a final newline', () => {
  const body = 'date,category,amount\n2026-04-01,meals,3.10\n2026-04-02,meals,0.20'
  assert.deepEqual(summarize(body), { count: 2, total: 3.3 })
  assert.deepEqual(summarize(`${body}\n`), { count: 2, total: 3.3 })
})

test('amounts are numbers, refunds included', () => {
  assert.deepEqual(summarize('date,category,amount\n2026-04-01,travel,10\n2026-04-02,travel,-10.5\n'), { count: 2, total: -0.5 })
})

test('a genuinely malformed row still throws', () => {
  assert.throws(() => parseCsv('a,b\n1,2\n3\n'), /bad row at line 3/)
})
