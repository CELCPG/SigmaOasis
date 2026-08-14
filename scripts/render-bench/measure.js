// Drives the running app over CDP: sends one prompt, waits for the reply to
// finish rendering, and reports what it cost.
//
// The primary number is Performance.getMetrics TaskDuration — cumulative
// main-thread processor time in the renderer. It answers "how much work was
// this", which holds whether or not the app keeps up with the stream, and at a
// realistic token rate it may well keep up either way.
//
// Do not reach for a 'longtask' PerformanceObserver here. It is listed in
// PerformanceObserver.supportedEntryTypes, observe() accepts it without error,
// and in the app's file:// renderer it silently never fires: 900ms of
// deliberate blocking registered zero long tasks while getMetrics recorded
// 0.901s. The first version of this benchmark reported a confident null result
// from that dead instrument. Sanity-check any instrument against a known block
// before trusting a number it produces.
const fs = require('fs')
const path = require('path')

const LABEL = process.argv[2] || 'run'
const OUT = process.argv[3] || path.join(__dirname, '../../.render-bench/results.jsonl')
const CDP_PORT = Number(process.env.BENCH_CDP_PORT || 9223)
const STUB_PORT = Number(process.env.BENCH_STUB_PORT || 1235)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pct = (arr, p) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

async function main() {
  if (typeof WebSocket === 'undefined') {
    throw new Error('no WebSocket global — run this under Node 22+, or pass --experimental-websocket')
  }

  let target
  for (let i = 0; i < 90; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
      target = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
      if (target) break
    } catch {
      // app not listening yet
    }
    await sleep(1000)
  }
  if (!target) throw new Error('no page target on the debugging port')

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value

  await send('Runtime.enable')
  await send('Performance.enable')
  const metrics = async () => {
    const r = await send('Performance.getMetrics')
    const m = {}
    for (const x of r.result.metrics) m[x.name] = x.value
    return m
  }

  for (let i = 0; i < 90; i++) {
    if (await evaluate(`document.querySelector('textarea') !== null`)) break
    await sleep(1000)
  }
  // Wait for the seeded conversation to be on screen — measuring before it
  // renders would measure an empty chat, which is the case that shows nothing.
  for (let i = 0; i < 40; i++) {
    if ((await evaluate(`document.querySelectorAll('.markdown-body').length`)) > 0) break
    await sleep(500)
  }
  const priorBubbles = await evaluate(`document.querySelectorAll('.markdown-body').length`)
  if (!priorBubbles) throw new Error('seeded conversation never rendered — check the profile')
  await sleep(1500)

  // Unique text so the opt-in response cache can never serve a hit and turn
  // this into a cache benchmark.
  const prompt = `Write a complete annotated Python implementation, run ${LABEL} ${Date.now()}`
  await evaluate(`(() => {
    const ta = document.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, ${JSON.stringify(prompt)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)

  const before = await metrics()
  const t0 = Date.now()
  await evaluate(`(() => {
    const ta = document.querySelector('textarea')
    ta.focus()
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })()`)

  const lat = []
  let lastLen = 0
  let lastGrowth = t0
  let firstPaint = null

  while (Date.now() - t0 < 600_000) {
    const s = Date.now()
    await evaluate('1+1')
    lat.push(Date.now() - s)
    // textContent, not innerText: innerText forces layout, so the probe would
    // add the very cost it is trying to measure, and unevenly as the DOM grows.
    const len = await evaluate(
      `(() => { const b = document.querySelectorAll('.markdown-body'); const e = b[b.length - 1]; return e ? e.textContent.length : 0 })()`
    )
    if (len > lastLen) {
      if (firstPaint === null && len > 0) firstPaint = Date.now() - t0
      lastLen = len
      lastGrowth = Date.now()
    }
    if (lastLen > 1000 && Date.now() - lastGrowth > 6000) break
    await sleep(100)
  }

  const after = await metrics()
  let streamEnd = null
  try {
    streamEnd = (await (await fetch(`http://127.0.0.1:${STUB_PORT}/stats`)).json()).lastStreamEnd || null
  } catch {
    // stub already gone; renderLag is simply unavailable
  }

  const ms = (k) => Math.round((after[k] - before[k]) * 1000)
  const result = {
    label: LABEL,
    priorBubbles,
    finalChars: lastLen,
    /** Cumulative renderer main-thread processor time over the turn. */
    taskMs: ms('TaskDuration'),
    scriptMs: ms('ScriptDuration'),
    layoutMs: ms('LayoutDuration'),
    styleMs: ms('RecalcStyleDuration'),
    firstPaintMs: firstPaint,
    /** How far the visible text finished behind the last byte off the socket. */
    renderLagMs: streamEnd ? lastGrowth - streamEnd : null,
    /** Round-trip of a trivial evaluate: what a keystroke would have felt. */
    evalP50: pct(lat, 50),
    evalP95: pct(lat, 95),
    evalMax: Math.max(...lat)
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.appendFileSync(OUT, JSON.stringify(result) + '\n')
  console.log(JSON.stringify(result))
  ws.close()
  process.exit(0)
}

main().catch((err) => {
  console.error('measure: ' + err.message)
  process.exit(1)
})
