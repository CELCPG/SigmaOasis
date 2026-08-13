/**
 * Verifies the Electron-net transport against a real local HTTP server.
 *
 * This cannot be a node:test file, and it is not optional coverage: the node
 * suite stubs `./net`, so the actual transport every outbound request now uses is
 * never exercised there. Since Phase 5 replaced Node's `fetch` with this
 * adapter — so that proxy settings apply at all — a regression here would break
 * every network path in the app while the whole node suite stayed green.
 *
 * Run through scripts/test-render.sh (Electron proper).
 */
import { app, session } from 'electron'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { httpRequest } from '../src/main/ipc/httpClient'

let passed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ''))
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function main(): Promise<void> {
  const received: { method: string; url: string; body: string }[] = []

  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', body })

      if (req.url === '/text') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('hello world')
      } else if (req.url === '/json') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ value: 42 }))
      } else if (req.url === '/missing') {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('nope')
      } else if (req.url === '/redirect') {
        res.writeHead(302, { location: '/text' })
        res.end()
      } else if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('x'.repeat(100_000))
      } else if (req.url === '/slow') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('late')
        }, 3000)
      } else if (req.url === '/drip') {
        // Headers, then a chunk every 100ms — a model streaming steadily.
        res.writeHead(200, { 'content-type': 'text/plain' })
        let sent = 0
        const tick = setInterval(() => {
          if (sent++ >= 12) {
            clearInterval(tick)
            res.end()
            return
          }
          // Same reason as /stall: big enough that each write really lands.
          res.write('x'.repeat(64 * 1024))
        }, 100)
      } else if (req.url === '/stall') {
        // Headers and one chunk, then silence — a connection that died after
        // the first token. A total deadline cannot tell this from /drip.
        //
        // Deliberately large: Chromium coalesces small writes, and a handful of
        // bytes never surfaces as a 'data' event at all, so a tiny fixture here
        // measures the buffer rather than the stall clock.
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.write('x'.repeat(64 * 1024))
      } else if (req.url === '/echo-header') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end(String(req.headers['x-custom'] ?? ''))
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('root')
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${port}`
  const ses = session.fromPartition('test-http', { cache: false })

  console.log('\nElectron net transport')

  const text = await httpRequest(`${origin}/text`, { session: ses })
  check('200 is ok with the right status', text.ok && text.status === 200)
  check('text() returns the body', (await text.text()) === 'hello world')
  check(
    'headers.get is case-insensitive',
    text.headers.get('Content-Type')?.includes('text/plain') === true,
    String(text.headers.get('Content-Type'))
  )
  check('a missing header returns null', text.headers.get('x-nope') === null)
  check('body is null so callers use arrayBuffer/text', text.body === null)

  const json = await httpRequest(`${origin}/json`, { session: ses })
  check('json() parses the body', ((await json.json()) as { value: number }).value === 42)

  const bytes = await httpRequest(`${origin}/text`, { session: ses })
  const buffer = await bytes.arrayBuffer()
  check('arrayBuffer() returns the exact bytes', Buffer.from(buffer).toString() === 'hello world')

  const missing = await httpRequest(`${origin}/missing`, { session: ses })
  check('404 is not ok but still resolves', !missing.ok && missing.status === 404)
  check('an error body is still readable', (await missing.text()) === 'nope')

  console.log('\nredirects')
  const manual = await httpRequest(`${origin}/redirect`, { session: ses, redirect: 'manual' })
  check('manual redirect returns the 3xx itself', manual.status === 302, String(manual.status))
  check(
    'manual redirect exposes Location, which the SSRF guard needs',
    manual.headers.get('location') === '/text',
    String(manual.headers.get('location'))
  )

  const followed = await httpRequest(`${origin}/redirect`, { session: ses, redirect: 'follow' })
  check('follow mode follows the redirect', (await followed.text()) === 'hello world')

  console.log('\ncaps and cancellation')
  const capped = await httpRequest(`${origin}/big`, { session: ses, maxBytes: 1000 })
  const cappedText = await capped.text()
  check('maxBytes stops the body at the cap', cappedText.length === 1000, `${cappedText.length}`)
  check('truncation is reported', capped.truncated === true)

  const uncapped = await httpRequest(`${origin}/text`, { session: ses, maxBytes: 1000 })
  check('a body under the cap is not marked truncated', uncapped.truncated === false)

  let timedOut = false
  try {
    await httpRequest(`${origin}/slow`, { session: ses, timeoutMs: 300 })
  } catch (err) {
    timedOut = (err as Error).name === 'AbortError'
  }
  check('a slow response times out as AbortError', timedOut)

  /**
   * v1.5. A single deadline cannot tell a hung server from a slow one, so it
   * had to be set generously enough for the slow case — and a dead LM Studio
   * then held the caller for the full five minutes. Liveness is measured
   * between chunks instead, and only after the first one, because the silence
   * before it is prompt processing and is legitimately long.
   */
  let stalled = false
  const stallStarted = Date.now()
  try {
    await httpRequest(`${origin}/stall`, { session: ses, timeoutMs: 30_000, stallTimeoutMs: 400 })
  } catch (err) {
    stalled = (err as Error).name === 'AbortError'
  }
  const stallElapsed = Date.now() - stallStarted
  // The timing is the whole assertion: without a stall clock this request also
  // ends in an AbortError, thirty seconds later. Failing fast is the feature.
  check(
    `a stream that goes silent is cut without waiting for the deadline (${stallElapsed}ms)`,
    stalled && stallElapsed < 5_000
  )

  const dripStarted = Date.now()
  const dripped = await httpRequest(`${origin}/drip`, {
    session: ses,
    timeoutMs: 30_000,
    maxBytes: 4 * 1024 * 1024,
    // Twenty times the 100ms between chunks. An earlier 400ms was under four
    // times, which passed locally and failed on a loaded CI runner where
    // scheduling a timer and delivering a chunk can slip past it — a flaky
    // test that would have taught us to distrust a real signal. Still well
    // under the 1.2s the whole response takes, so a stream that genuinely
    // stopped would be caught before it finished.
    stallTimeoutMs: 2_000
  })
  check(
    'a steadily streaming response is left alone',
    (await dripped.text()).length === 12 * 64 * 1024 && Date.now() - dripStarted > 1_000
  )

  let prefillSurvived = false
  try {
    // /slow sends nothing for 3s, then everything. The stall clock must not be
    // running yet — that silence is the model reading the prompt.
    const late = await httpRequest(`${origin}/slow`, {
      session: ses,
      timeoutMs: 10_000,
      // Far under the 3s of silence /slow opens with, so this fails loudly if
      // the clock ever starts before the first chunk.
      stallTimeoutMs: 1_000
    })
    prefillSurvived = (await late.text()) === 'late'
  } catch {
    prefillSurvived = false
  }
  check('silence before the first chunk is not a stall', prefillSurvived)

  const controller = new AbortController()
  let aborted = false
  const inflight = httpRequest(`${origin}/slow`, { session: ses, signal: controller.signal }).catch(
    (err: Error) => {
      aborted = err.name === 'AbortError'
      return null
    }
  )
  controller.abort()
  await inflight
  check('an abort signal cancels the request', aborted)

  let preAborted = false
  const already = new AbortController()
  already.abort()
  try {
    await httpRequest(`${origin}/text`, { session: ses, signal: already.signal })
  } catch (err) {
    preAborted = (err as Error).name === 'AbortError'
  }
  check('an already-aborted signal rejects immediately', preAborted)

  console.log('\nrequest shaping')
  await httpRequest(`${origin}/post`, {
    session: ses,
    method: 'POST',
    body: 'payload=1',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }
  })
  const post = received.find((r) => r.url === '/post')
  check('POST sends the method and body', post?.method === 'POST' && post?.body === 'payload=1')

  const echo = await httpRequest(`${origin}/echo-header`, {
    session: ses,
    headers: { 'x-custom': 'sigma' }
  })
  check('custom request headers are sent', (await echo.text()) === 'sigma')

  let refused = false
  try {
    await httpRequest(`${origin.replace(String(port), '1')}/text`, {
      session: ses,
      timeoutMs: 2000
    })
  } catch {
    refused = true
  }
  check('a connection failure rejects rather than hanging', refused)

  server.close()

  console.log(`\n${'='.repeat(58)}`)
  if (failures.length === 0) {
    console.log(`ALL ${passed} TRANSPORT CHECKS PASSED`)
    app.exit(0)
  } else {
    console.log(`${passed} passed, ${failures.length} FAILED:`)
    for (const f of failures) console.log(`  - ${f}`)
    app.exit(1)
  }
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('TRANSPORT CHECK ERROR:', err)
    app.exit(1)
  })
)
