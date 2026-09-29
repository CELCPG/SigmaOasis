const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { parseLog } = require('../src/parse')
const { dailyReport } = require('../src/aggregate')

const { entries, skipped } = parseLog(readFileSync(join(__dirname, '..', 'data', 'sample.log'), 'utf8'))

test('every line of the sample parses', () => {
  assert.equal(skipped, 0)
  assert.equal(entries.length, 400)
})

test('the daily report for the sample matches the ops dashboard', () => {
  const report = dailyReport(entries)
  assert.equal(report.p95, 1611)
  assert.equal(report.clientErrorRate, 0.05)
  assert.equal(report.serverErrorRate, 0.0675)
})
