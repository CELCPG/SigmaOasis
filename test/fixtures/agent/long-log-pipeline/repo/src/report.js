'use strict'

const { readFileSync } = require('fs')
const { parseLog } = require('./parse')
const { dailyReport } = require('./aggregate')

/** Print the daily report for a log file. */
function main(file) {
  const { entries, skipped } = parseLog(readFileSync(file, 'utf8'))
  const r = dailyReport(entries)
  console.log(`${r.requests} requests (${r.humanRequests} human), ${skipped} lines skipped`)
  console.log(`server errors ${(r.serverErrorRate * 100).toFixed(2)}%, client errors ${(r.clientErrorRate * 100).toFixed(2)}%`)
  console.log(`p50 ${r.p50} ms, p95 ${r.p95} ms, ${r.slowApiCalls} slow API calls, ${r.failedCheckouts} failed checkouts`)
  console.log(`${r.activeUsers} active users; busiest: ${r.topPaths.map(([p, n]) => `${p} (${n})`).join(', ')}`)
}

if (require.main === module) main(process.argv[2] || 'data/sample.log')

module.exports = { main }
