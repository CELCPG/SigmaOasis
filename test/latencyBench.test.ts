import { test } from 'node:test'
import assert from 'node:assert/strict'
import { benchPlan, conversation, formatBenchReport, summarizeBench, withinWindow, type BenchLine } from '../src/main/agent/latencyBench'
import { estimateTokens } from '../src/renderer/src/lib/contextBudget'
import type { RoundLatency } from '../src/main/agent/latency'

/**
 * v4.1 (M7): the latency bench's workload is fixed and its scenarios are the
 * ones they say — checked here, since the bench itself needs a model.
 */

const plan = (): ReturnType<typeof benchPlan> => {
  let n = 0
  return benchPlan({ window: 8192, maxTokens: 64, nonce: () => `n${++n}` })
}
const text = (s: { messages: { content: unknown }[] }): string => s.messages.map((m) => String(m.content)).join('\n')
const tokens = (s: { messages: { content: unknown }[] }): number => s.messages.reduce((t, m) => t + estimateTokens(String(m.content)), 0)

test('the plan sends the scenarios in order, and the same bytes every run', () => {
  const p = plan()
  assert.deepEqual(
    p.map((s) => s.scenario),
    ['cold', 'warm', ...Array.from({ length: 10 }, (_, i) => `turn-${i + 1}`), 'window-first', 'window-next']
  )
  assert.deepEqual(JSON.stringify(plan()), JSON.stringify(p))
})

test('warm repeats cold byte for byte; each group opens on its own nonce so none starts on another\'s cache', () => {
  const p = plan()
  assert.equal(JSON.stringify(p[1]!.messages), JSON.stringify(p[0]!.messages))
  const sys = (i: number): string => String(p[i]!.messages[0]!.content)
  assert.notEqual(sys(0), sys(2))
  assert.notEqual(sys(2), sys(12))
  assert.match(sys(0), /^Session n1\. /)
})

test('turn n extends turn n−1 exactly — the case a prompt cache is for — and alternates user, assistant, ending on the user', () => {
  const p = plan()
  for (let n = 2; n <= 10; n++) {
    const prev = JSON.stringify(p[n]!.messages).slice(0, -1)
    assert.ok(JSON.stringify(p[n + 1]!.messages).startsWith(prev), `turn ${n} is not a prefix of turn ${n + 1}`)
  }
  const ten = p[11]!.messages.slice(1)
  assert.equal(ten.length, 19)
  ten.forEach((m, i) => assert.equal(m.role, i % 2 === 0 ? 'user' : 'assistant'))
  assert.ok(tokens(p[11]!) > 2000, 'turn 10 carries a real history')
})

test('past the window: both requests fit it, and the next one drops the oldest turns — its prefix changes right after the system prompt', () => {
  const p = plan()
  const first = p[12]!
  const next = p[13]!
  for (const s of [first, next]) {
    assert.ok(tokens(s) <= 8192 - 64, `${s.scenario} does not fit the window`)
    assert.equal(s.messages[1]!.role, 'user')
  }
  assert.equal(first.messages[0]!.content, next.messages[0]!.content, 'the same chat')
  assert.notEqual(JSON.stringify(first.messages[1]), JSON.stringify(next.messages[1]), 'the oldest kept turn moved: nothing after the system prompt is cached')
  assert.ok(text(next).includes(String(next.messages.at(-1)!.content)))
  // And the conversation behind it really was past the window.
  const all = conversation(40)
  assert.ok(withinWindow(all, 4000).length < all.length)
})

test('the summary takes medians over the repeats, and the report tables the scenarios that matter', () => {
  const lat = (ttftMs: number, extra: Partial<RoundLatency> = {}): RoundLatency => ({ ok: true, ttftMs, prefillMs: ttftMs, prefillFrom: 'ttft', totalMs: ttftMs + 500, decodeTokPerSec: 50, promptTokens: 1000, ...extra })
  const s = summarizeBench([
    { scenario: 'cold', latency: lat(900) },
    { scenario: 'cold', latency: lat(1100) },
    { scenario: 'cold', latency: lat(1000) },
    { scenario: 'warm', latency: lat(120, { cachedTokens: 990 }) },
    { scenario: 'warm', latency: { ...lat(99_999), ok: false } },
    { scenario: 'window-next', latency: lat(4200, { promptTokens: 7800 }) }
  ])
  assert.deepEqual(s.cold, { ttftMs: 1000, prefillMs: 1000, promptTokens: 1000, cachedTokens: null, decodeTokPerSec: 50, n: 3 })
  assert.equal(s.warm?.n, 1)
  assert.equal(s.warm?.cachedTokens, 990)
  const line: BenchLine = { label: '4.1-dev', model: 'qwen3.8-9b-distill', at: '2026-09-30T00:00:00Z', window: 8192, repeats: 3, scenarios: s }
  const report = formatBenchReport([line, { ...line, label: 'noisy', machine: 'PCIe replays rose by 40' }])
  assert.match(report, /\| label \| model \| cold \| warm \| turn-1 \| turn-10 \| window-first \| window-next \| decode tok\/s \| prompt at window \|/)
  assert.match(report, /\| 4\.1-dev \| qwen3\.8-9b-distill \| 1\.0 s \| 120 ms \| — \| — \| — \| 4\.2 s \| 50\.0 \| 7,800 tok \|/)
  assert.match(report, /\| noisy \(machine\) \|/)
})
