// Generates this fixture's repo/, solution/, check/, task.md and case.json,
// deterministically: the same files every run. The expected figures in the
// tests are computed from the fixed code, so they are exact by construction.
//
//   node test/fixtures/agent/long-log-pipeline/generate.js
'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

const out = process.argv[2] || __dirname

let seed = 424242
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const pick = (xs) => xs[Math.floor(rand() * xs.length)]

// ---- the sample log ----------------------------------------------------------------
const PATHS = ['/api/items', '/api/items/17', '/api/cart', '/api/checkout', '/api/users/me', '/api/search', '/static/app.js', '/static/app.css', '/static/logo.svg', '/', '/help', '/health']
const AGENTS = ['Mozilla/5.0 (Windows NT 10.0)', 'Mozilla/5.0 (Macintosh)', 'Mozilla/5.0 (iPhone)', 'curl/8.4.0', 'Googlebot/2.1', 'bingbot/2.0', 'python-requests/2.31']
const lines = []
let t = Date.UTC(2026, 2, 1, 9, 0, 0)
for (let i = 0; i < 400; i++) {
  t += Math.floor(rand() * 9000)
  const p = pick(PATHS)
  const method = p.startsWith('/api/checkout') || (p === '/api/cart' && rand() < 0.5) ? 'POST' : 'GET'
  const r = rand()
  // 500s are deliberately common enough that missing them moves the rate.
  const status = r < 0.03 ? 500 : r < 0.045 ? 502 : r < 0.055 ? 503 : r < 0.09 ? 404 : r < 0.1 ? 401 : r < 0.11 ? 304 : 200
  const ms = Math.floor(p.startsWith('/static') ? 5 + rand() * 40 : 20 + rand() * (rand() < 0.1 ? 3000 : 600))
  const user = rand() < 0.6 ? Math.floor(rand() * 120) + 1 : '-'
  lines.push(`${new Date(t).toISOString()} ${method} ${p} ${status} ${ms}ms user=${user} ua="${pick(AGENTS)}"`)
}
const sampleLog = lines.join('\n') + '\n'

// ---- the code ------------------------------------------------------------------------
const parseJs = `'use strict'

/**
 * One access-log line:
 *
 *   2026-03-01T09:00:03.000Z GET /api/items 200 123ms user=42 ua="curl/8.4.0"
 *
 * becomes { at: Date, method, path, status, ms, user: number | null, agent }.
 * A line that does not match returns null; parseLog skips those and counts them.
 */
const LINE = /^(\\S+) (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\\S+) (\\d{3}) (\\d+)ms user=(\\d+|-) ua="([^"]*)"$/

function parseLine(line) {
  const m = LINE.exec(line.trim())
  if (!m) return null
  const at = new Date(m[1])
  if (Number.isNaN(at.getTime())) return null
  return {
    at,
    method: m[2],
    path: m[3],
    status: Number(m[4]),
    ms: Number(m[5]),
    user: m[6] === '-' ? null : Number(m[6]),
    agent: m[7]
  }
}

/** Every entry in a log text, and how many lines were not entries. */
function parseLog(text) {
  const entries = []
  let skipped = 0
  for (const line of text.split('\\n')) {
    if (!line.trim()) continue
    const e = parseLine(line)
    if (e) entries.push(e)
    else skipped++
  }
  return { entries, skipped }
}

module.exports = { parseLine, parseLog }
`

const filters = []
const f = (name, doc, body) => filters.push({ name, doc, body })
f('isGet', 'A GET request.', "e.method === 'GET'")
f('isPost', 'A POST request.', "e.method === 'POST'")
f('isWrite', 'Anything that can change state: POST, PUT, PATCH or DELETE.', "['POST', 'PUT', 'PATCH', 'DELETE'].includes(e.method)")
f('isApi', 'A request to the JSON API.', "e.path.startsWith('/api/')")
f('isStatic', 'A static asset: scripts, styles, images.', "e.path.startsWith('/static/')")
f('isPage', 'A page a person reads: neither the API nor a static asset.', "!e.path.startsWith('/api/') && !e.path.startsWith('/static/')")
f('isHealthCheck', 'The load balancer probe.', "e.path === '/health'")
f('isCheckout', 'The checkout endpoint.', "e.path.startsWith('/api/checkout')")
f('isCart', 'The cart endpoint.', "e.path.startsWith('/api/cart')")
f('isSearch', 'Search, from the search box or the API.', "e.path.startsWith('/api/search')")
f('isItem', 'A single item, as opposed to the item list.', "/^\\/api\\/items\\/\\d+$/.test(e.path)")
f('isItemList', 'The item list.', "e.path === '/api/items'")
f('isUserEndpoint', 'Anything under /api/users.', "e.path.startsWith('/api/users')")
f('isSuccess', 'A 2xx response.', 'e.status >= 200 && e.status < 300')
f('isRedirect', 'A 3xx response, 304 Not Modified included.', 'e.status >= 300 && e.status < 400')
f('isNotModified', 'A 304, served from the client cache.', 'e.status === 304')
f('isClientError', 'A 4xx response: the request was at fault.', 'e.status >= 400 && e.status < 500')
f('isNotFound', 'A 404.', 'e.status === 404')
f('isUnauthorized', 'A 401: no session, or an expired one.', 'e.status === 401')
f('isServerError', 'A 5xx response: the server was at fault.', 'e.status >= 500 && e.status < 600', 'e.status > 500 && e.status < 600')
f('isBadGateway', 'A 502 from the proxy: the app did not answer it.', 'e.status === 502')
f('isUnavailable', 'A 503: shedding load, or deploying.', 'e.status === 503')
f('isFast', 'Answered in under 100 ms.', 'e.ms < 100')
f('isSlow', 'Took a second or more.', 'e.ms >= 1000')
f('isVerySlow', 'Took two seconds or more.', 'e.ms >= 2000')
f('isSignedIn', 'Made with a session: the log carries a user id.', 'e.user !== null')
f('isAnonymous', 'Made without a session.', 'e.user === null')
f('isBot', 'A crawler by its user agent.', '/bot|crawler|spider/i.test(e.agent)')
f('isScript', 'A script or tool, not a browser.', '/^(curl|wget|python-requests|Go-http-client)\\//i.test(e.agent)')
f('isBrowser', 'A browser by its user agent.', "e.agent.startsWith('Mozilla/') && !/bot/i.test(e.agent)")
f('isMobile', 'A phone or tablet browser.', '/iPhone|iPad|Android/.test(e.agent)')
f('isWindows', 'A Windows browser.', "e.agent.includes('Windows')")
f('isMac', 'A Mac browser.', "e.agent.includes('Macintosh')")
f('isMorning', 'Between 06:00 and 12:00 UTC.', 'e.at.getUTCHours() >= 6 && e.at.getUTCHours() < 12')
f('isAfternoon', 'Between 12:00 and 18:00 UTC.', 'e.at.getUTCHours() >= 12 && e.at.getUTCHours() < 18')
f('isWeekend', 'On a Saturday or Sunday, UTC.', '[0, 6].includes(e.at.getUTCDay())')
f('isHumanTraffic', 'A browser, not a bot, not the health probe.', "e.agent.startsWith('Mozilla/') && !/bot/i.test(e.agent) && e.path !== '/health'")
f('isFailedCheckout', 'A checkout that did not succeed.', "e.path.startsWith('/api/checkout') && (e.status < 200 || e.status >= 300)")
f('isSlowApi', 'An API call that took a second or more.', "e.path.startsWith('/api/') && e.ms >= 1000")
f('isCacheable', 'A GET for a static asset.', "e.method === 'GET' && e.path.startsWith('/static/')")
f('isHome', 'The home page.', "e.path === '/'")
f('isHelp', 'The help pages.', "e.path.startsWith('/help')")
f('isScriptAsset', 'A JavaScript file.', "e.path.endsWith('.js')")
f('isStyleAsset', 'A stylesheet.', "e.path.endsWith('.css')")
f('isImageAsset', 'An image.', '/\\.(svg|png|jpe?g|gif|webp)$/.test(e.path)')

const filtersJs = (fixed) => `'use strict'

/**
 * Predicates over parsed log entries (see parse.js for the shape). Each takes
 * one entry and says whether it belongs to a group; aggregate.js combines them.
 * Keep each one a single expression so the dashboard can show its source.
 */

${filters
  .map((x) => `/** ${x.doc} */\nfunction ${x.name}(e) {\n  return ${!fixed && x.doc && filtersBuggy(x) ? filtersBuggy(x) : x.body}\n}`)
  .join('\n\n')}

module.exports = {
${filters.map((x) => `  ${x.name}`).join(',\n')}
}
`
function filtersBuggy(x) {
  return x.name === 'isServerError' ? 'e.status > 500 && e.status < 600' : null
}

const aggregateJs = `'use strict'

const F = require('./filters')

/** The share of entries matching \`pred\`, to four decimal places; 0 for no entries. */
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
`

const reportJs = `'use strict'

const { readFileSync } = require('fs')
const { parseLog } = require('./parse')
const { dailyReport } = require('./aggregate')

/** Print the daily report for a log file. */
function main(file) {
  const { entries, skipped } = parseLog(readFileSync(file, 'utf8'))
  const r = dailyReport(entries)
  console.log(\`\${r.requests} requests (\${r.humanRequests} human), \${skipped} lines skipped\`)
  console.log(\`server errors \${(r.serverErrorRate * 100).toFixed(2)}%, client errors \${(r.clientErrorRate * 100).toFixed(2)}%\`)
  console.log(\`p50 \${r.p50} ms, p95 \${r.p95} ms, \${r.slowApiCalls} slow API calls, \${r.failedCheckouts} failed checkouts\`)
  console.log(\`\${r.activeUsers} active users; busiest: \${r.topPaths.map(([p, n]) => \`\${p} (\${n})\`).join(', ')}\`)
}

if (require.main === module) main(process.argv[2] || 'data/sample.log')

module.exports = { main }
`

// ---- compute the expected figures from the fixed code ------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-logs-'))
fs.mkdirSync(path.join(tmp, 'src'))
fs.writeFileSync(path.join(tmp, 'src', 'parse.js'), parseJs)
fs.writeFileSync(path.join(tmp, 'src', 'aggregate.js'), aggregateJs)
fs.writeFileSync(path.join(tmp, 'sample.log'), sampleLog)
const calc = `const { parseLog } = require('./src/parse'); const { dailyReport } = require('./src/aggregate'); const fs = require('fs'); console.log(JSON.stringify({ parsed: parseLog(fs.readFileSync('${path.join(tmp, 'sample.log').replace(/\\/g, '/')}', 'utf8')).skipped, report: dailyReport(parseLog(fs.readFileSync('${path.join(tmp, 'sample.log').replace(/\\/g, '/')}', 'utf8')).entries) }))`
fs.writeFileSync(path.join(tmp, 'calc.js'), calc)
fs.writeFileSync(path.join(tmp, 'src', 'filters.js'), filtersJs(true))
const fixed = JSON.parse(execFileSync(process.execPath, [path.join(tmp, 'calc.js')]).toString())
fs.writeFileSync(path.join(tmp, 'src', 'filters.js'), filtersJs(false))
const buggy = JSON.parse(execFileSync(process.execPath, [path.join(tmp, 'calc.js')]).toString())
fs.rmSync(tmp, { recursive: true, force: true })
if (fixed.parsed !== 0) throw new Error(`the sample log has ${fixed.parsed} unparsed lines`)
if (fixed.report.serverErrorRate === buggy.report.serverErrorRate) throw new Error('the bug does not move the server error rate')
const r = fixed.report

// ---- write -------------------------------------------------------------------------------
const write = (rel, body) => {
  const p = path.join(out, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}
write('repo/package.json', JSON.stringify({ name: 'ops-report', version: '1.8.0', private: true, scripts: { report: 'node src/report.js data/sample.log', test: 'node --test' } }, null, 2) + '\n')
write('repo/data/sample.log', sampleLog)
write('repo/src/parse.js', parseJs)
write('repo/src/filters.js', filtersJs(false))
write('repo/src/aggregate.js', aggregateJs)
write('repo/src/report.js', reportJs)
write('solution/src/filters.js', filtersJs(true))
write(
  'repo/test/report.test.js',
  `const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { parseLog } = require('../src/parse')
const { dailyReport } = require('../src/aggregate')

const { entries, skipped } = parseLog(readFileSync(join(__dirname, '..', 'data', 'sample.log'), 'utf8'))

test('every line of the sample parses', () => {
  assert.equal(skipped, 0)
  assert.equal(entries.length, ${r.requests})
})

test('the daily report for the sample matches the ops dashboard', () => {
  const report = dailyReport(entries)
  assert.equal(report.p95, ${r.p95})
  assert.equal(report.clientErrorRate, ${r.clientErrorRate})
  assert.equal(report.serverErrorRate, ${r.serverErrorRate})
})
`
)
write(
  'check/report.test.js',
  `const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { parseLog } = require('../src/parse')
const { dailyReport } = require('../src/aggregate')
const F = require('../src/filters')

const { entries } = parseLog(readFileSync(join(__dirname, '..', 'data', 'sample.log'), 'utf8'))
const at = (status) => ({ at: new Date(0), method: 'GET', path: '/', status, ms: 1, user: null, agent: 'x' })

test('the daily report for the sample', () => {
  assert.deepEqual(dailyReport(entries), ${JSON.stringify(r)})
})

test('a 5xx is a server error, the 500 included', () => {
  for (const s of [500, 502, 503, 599]) assert.equal(F.isServerError(at(s)), true, String(s))
  for (const s of [200, 404, 499, 600]) assert.equal(F.isServerError(at(s)), false, String(s))
})

test('every filter is still there', () => {
  assert.equal(Object.keys(F).length, ${filters.length})
})
`
)
write('task.md', 'The ops report test fails: the server error rate for the sample log does not match the dashboard. Find out why and fix it, then run the tests. The sample log and the dashboard figure are right.\n')
write(
  'case.json',
  JSON.stringify({ kind: 'long', files: ['src/filters.js', 'src/aggregate.js', 'src/parse.js', 'test/'], commands: ['npm test', 'node --test'], contextTokens: 16384 }, null, 2) + '\n'
)
const size = (s) => `${s.split('\n').length} lines, ${s.length} chars`
console.log('log', size(sampleLog), '| filters', size(filtersJs(false)), '| aggregate', size(aggregateJs), '| parse', size(parseJs))
console.log('server error rate fixed', r.serverErrorRate, 'buggy', buggy.report.serverErrorRate)
