'use strict'

const F = require('./filters')

/** The share of entries matching `pred`, to four decimal places; 0 for no entries. */
function share(entries, pred) {
  if (entries.length === 0) return 0
  return Math.round((entries.filter(pred).length / entries.length) * 10000) / 10000
}

/** The p-th percentile of response times, nearest-rank. */
function percentile(entries, p) {
  if (entries.length === 0) return 0
  const ms = entries.map((e) => e.ms).sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil((p / 100) * ms.length))
  return ms[rank - 1]
}

/** The n most requested paths as [path, count], busiest first, ties by path. */
function topPaths(entries, n) {
  const counts = new Map()
  for (const e of entries) counts.set(e.path, (counts.get(e.path) || 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n)
}

/** Distinct signed-in users. */
function activeUsers(entries) {
  return new Set(entries.filter(F.isSignedIn).map((e) => e.user)).size
}

/** The numbers on the daily ops report. */
function dailyReport(entries) {
  const human = entries.filter(F.isHumanTraffic)
  return {
    requests: entries.length,
    humanRequests: human.length,
    serverErrorRate: share(entries, F.isServerError),
    clientErrorRate: share(entries, F.isClientError),
    notFound: entries.filter(F.isNotFound).length,
    slowApiCalls: entries.filter(F.isSlowApi).length,
    failedCheckouts: entries.filter(F.isFailedCheckout).length,
    p50: percentile(entries, 50),
    p95: percentile(entries, 95),
    activeUsers: activeUsers(entries),
    topPaths: topPaths(entries, 3)
  }
}

module.exports = { share, percentile, topPaths, activeUsers, dailyReport }
