import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { summarizeLatency, timedTransport, type RoundLatency } from '../src/main/agent/latency'
import { streamRound } from '../src/main/agent/stream'
import { formatSummary, loadCases, runCase, summarize, type CaseRun } from '../src/main/agent/evalHarness'
import { cachedTokens } from '../src/shared/sse'
import type { ChunkTransport, ShellSpec } from '../src/main/agent/types'

/**
 * v4.1 (M3): per-round latency, timed at the transport. The clock is the
 * test's, so every figure below is exact.
 */

type Frame = Record<string, unknown>
const enc = new TextEncoder()
const sse = (f: Frame | '[DONE]'): Uint8Array => enc.encode(`data: ${f === '[DONE]' ? f : JSON.stringify(f)}\n\n`)

/** A transport that plays (time, frame) pairs, moving the shared clock to each time before it delivers the frame. */
function played(clock: { t: number }, steps: [number, Frame | '[DONE]' | Uint8Array][], result = { ok: true, status: 200 }): ChunkTransport {
  return async (_url, init) => {
    for (const [at, f] of steps) {
      clock.t = at
      init.onChunk(f instanceof Uint8Array ? f : sse(f))
    }
    return result
  }
}

const INIT = { body: '{}', signal: new AbortController().signal, stallMs: 1000 }

async function timeOne(steps: [number, Frame | '[DONE]' | Uint8Array][], end: number, result?: { ok: boolean; status: number }): Promise<{ r: RoundLatency; seen: Uint8Array[] }> {
  const clock = { t: 0 }
  const rounds: RoundLatency[] = []
  const seen: Uint8Array[] = []
  const inner = played(clock, steps, result)
  const t = timedTransport(
    async (url, init) => {
      const res = await inner(url, init)
      clock.t = end
      return res
    },
    (r) => rounds.push(r),
    () => clock.t
  )
  await t('http://127.0.0.1:1234/v1/chat/completions', { ...INIT, onChunk: (c) => seen.push(c) })
  assert.equal(rounds.length, 1)
  return { r: rounds[0]!, seen }
}

describe('a round, timed at the transport', () => {
  test('TTFT runs to the first token — reasoning counts, a role-only frame does not; decode is tokens after the first over first-to-last', async () => {
    const { r, seen } = await timeOne(
      [
        [50, { choices: [{ delta: { role: 'assistant' } }] }],
        [400, { choices: [{ delta: { reasoning_content: 'thinking' } }] }],
        [600, { choices: [{ delta: { content: 'Hello' } }] }],
        [1400, { choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }] }],
        [1450, { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 41, prompt_tokens_details: { cached_tokens: 800 } } }],
        [1460, '[DONE]']
      ],
      1500
    )
    assert.deepEqual(r, { ok: true, ttftMs: 400, prefillMs: 400, prefillFrom: 'ttft', promptTokens: 1000, cachedTokens: 800, completionTokens: 41, decodeTokPerSec: 40, totalMs: 1500 })
    assert.equal(seen.length, 6, 'every chunk reaches the engine, unchanged')
  })

  test("a tool call is a first token too; the server's own prefill figure wins when it sends one", async () => {
    const { r } = await timeOne(
      [
        [900, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{}' } }] } }] }],
        [1000, { choices: [], usage: { prompt_tokens: 5000, completion_tokens: 12 }, timings: { prompt_ms: 812.34 } }]
      ],
      1000
    )
    assert.equal(r.ttftMs, 900)
    assert.equal(r.prefillMs, 812.3)
    assert.equal(r.prefillFrom, 'server')
    assert.equal(r.cachedTokens, undefined, 'no cache figure is not a zero')
    assert.equal(r.decodeTokPerSec, undefined, 'one token frame: no span to divide by')
  })

  test('a frame split across two chunks is read once, at the chunk that completed it', async () => {
    const whole = `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`
    const { r } = await timeOne(
      [
        [100, enc.encode(whole.slice(0, 20))],
        [300, enc.encode(whole.slice(20))]
      ],
      300
    )
    assert.equal(r.ttftMs, 300)
  })

  test('a refused request and a thrown one are reported as failed rounds; the throw still reaches the engine', async () => {
    const { r } = await timeOne([], 20, { ok: false, status: 400 })
    assert.equal(r.ok, false)
    assert.equal(r.ttftMs, null)
    const rounds: RoundLatency[] = []
    const t = timedTransport(async () => {
      throw new Error('terminated')
    }, (x) => rounds.push(x))
    await assert.rejects(t('u', { ...INIT, onChunk: () => undefined }), /terminated/)
    assert.equal(rounds[0]?.ok, false)
  })
})

test('the summary takes median and max over completed rounds, and says when the server reports no cache', () => {
  const round = (ttftMs: number, extra: Partial<RoundLatency> = {}): RoundLatency => ({ ok: true, ttftMs, prefillMs: ttftMs, prefillFrom: 'ttft', totalMs: ttftMs + 1000, ...extra })
  const s = summarizeLatency([
    round(100, { decodeTokPerSec: 50, promptTokens: 2000, cachedTokens: 1500 }),
    round(300, { decodeTokPerSec: 40, promptTokens: 4000, cachedTokens: 3500 }),
    round(2000, { decodeTokPerSec: 30, promptTokens: 6000 }),
    { ok: false, ttftMs: 99_999, prefillMs: 99_999, prefillFrom: 'ttft', totalMs: 99_999 }
  ])
  assert.deepEqual(s, {
    rounds: 3,
    ttftMedianMs: 300,
    ttftMaxMs: 2000,
    prefillMedianMs: 300,
    prefillMaxMs: 2000,
    prefillFrom: 'ttft',
    decodeTokPerSecMedian: 40,
    promptTokensMax: 6000,
    // Only the rounds that reported a cache figure: 5000 of 6000.
    cachedShare: 0.833
  })
  assert.equal(summarizeLatency([round(10)])?.cachedShare, null)
  assert.equal(summarizeLatency([]), null)
})

test('the agent stream keeps the cache figure in its usage (additive)', async () => {
  const clock = { t: 0 }
  const r = await streamRound({
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    signal: new AbortController().signal,
    transport: played(clock, [
      [1, { choices: [{ delta: { content: 'ok' } }] }],
      [2, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 8 } } }]
    ])
  })
  assert.equal(r.usage?.prompt_tokens, 10)
  assert.equal(cachedTokens(r.usage), 8)
  assert.equal(cachedTokens({ prompt_tokens: 3 }), undefined)
})

// ---- a whole eval pass carries its rounds' timing -------------------------------

const CASES_DIR = join(__dirname, '..', '..', 'test', 'fixtures', 'agent')
const NODE_SHELL: ShellSpec =
  process.platform === 'win32'
    ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c'], name: 'cmd.exe' }
    : { file: '/bin/sh', args: ['-c'], name: 'sh' }

test('an eval run records one timing per round, summarized per case and per model; a tainted run keeps its score, not its time', async () => {
  const c = (await loadCases(CASES_DIR)).find((x) => x.id === 'read-only-free-shipping')!
  const clock = { t: 0 }
  let request = 0
  // Round n: first token 100·n ms after the request, 21 tokens over the next second.
  const transport: ChunkTransport = async (_url, init) => {
    const n = ++request
    const t0 = clock.t
    const reply: Frame =
      n === 1
        ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'grep', arguments: JSON.stringify({ pattern: 'FreeShipping' }) } }] } }] }
        : { choices: [{ delta: { content: '`qualifiesForFreeShipping` in src/shipping.js decides it.' } }] }
    clock.t = t0 + 100 * n
    init.onChunk(sse(reply))
    clock.t = t0 + 100 * n + 1000
    init.onChunk(sse({ choices: [{ delta: { content: ' ' } }] }))
    init.onChunk(sse({ choices: [], usage: { prompt_tokens: 1000 * n, completion_tokens: 21, prompt_tokens_details: { cached_tokens: n === 1 ? 0 : 900 } } }))
    init.onChunk(sse('[DONE]'))
    return { ok: true, status: 200 }
  }
  const run = await runCase(c, { baseUrl: 'http://127.0.0.1:1234/v1', model: 'scripted', transport, shell: NODE_SHELL, clock: () => clock.t })
  assert.equal(run.solved, true, run.why)
  assert.equal(run.latency?.length, 2)
  assert.deepEqual(
    run.latency!.map((r) => [r.ttftMs, r.promptTokens, r.cachedTokens, r.decodeTokPerSec]),
    [
      [100, 1000, 0, 20],
      [200, 2000, 900, 20]
    ]
  )
  assert.equal(run.latencySummary?.ttftMaxMs, 200)
  assert.equal(run.latencySummary?.ttftMedianMs, 150)
  assert.equal(run.latencySummary?.cachedShare, 0.3)

  const tainted: CaseRun = { ...run, machine: 'PCIe replay counter rose by 12', latency: run.latency!.map((r) => ({ ...r, ttftMs: 60_000 })) }
  const s = summarize('scripted', [[run], [tainted]])
  assert.deepEqual(s.solvedPerPass, [1, 1], 'the tainted run is scored')
  assert.equal(s.latency?.ttftMaxMs, 200, 'its time is not counted')
  const table = formatSummary([s])
  assert.match(table, /\| TTFT median · max \| decode tok\/s \|/)
  assert.match(table, /\| 150 ms · 200 ms \| 20 \|/)
  assert.match(table, /prefill 150 ms median, 200 ms max \(TTFT; the server reports no prefill of its own\).*cached 30% of prompt tokens/)
})
