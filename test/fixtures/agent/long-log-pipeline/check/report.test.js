const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { parseLog } = require('../src/parse')
const { dailyReport } = require('../src/aggregate')
const F = require('../src/filters')

const { entries } = parseLog(readFileSync(join(__dirname, '..', 'data', 'sample.log'), 'utf8'))
const at = (status) => ({ at: new Date(0), method: 'GET', path: '/', status, ms: 1, user: null, agent: 'x' })

test('the daily report for the sample', () => {
  assert.deepEqual(dailyReport(entries), {"requests":400,"humanRequests":143,"serverErrorRate":0.0675,"clientErrorRate":0.05,"notFound":19,"slowApiCalls":19,"failedCheckouts":4,"p50":208,"p95":1611,"activeUsers":101,"topPaths":[["/static/logo.svg",44],["/health",39],["/api/cart",35]]})
})

test('a 5xx is a server error, the 500 included', () => {
  for (const s of [500, 502, 503, 599]) assert.equal(F.isServerError(at(s)), true, String(s))
  for (const s of [200, 404, 499, 600]) assert.equal(F.isServerError(at(s)), false, String(s))
})

test('every filter is still there', () => {
  assert.equal(Object.keys(F).length, 45)
})
