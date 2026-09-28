const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { summarize } = require('../src/csv')

test('the March export sums to 23.25 over four expenses', () => {
  const text = readFileSync(join(__dirname, '..', 'data', 'march.csv'), 'utf8')
  assert.deepEqual(summarize(text), { count: 4, total: 23.25 })
})
