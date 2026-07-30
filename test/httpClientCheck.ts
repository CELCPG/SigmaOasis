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
