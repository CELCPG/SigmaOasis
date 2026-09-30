import { planHistory, estimateTokens } from '../../renderer/src/lib/contextBudget'
import type { ApiMessage } from '../../renderer/src/lib/agentLoop'
import type { ChatMessage } from '../../renderer/src/types'
import { fmtMs, median, type RoundLatency } from './latency'

/**
 * v4.1 (M7): the latency bench's workload and its report — the pure half of
 * `npm run bench:latency` (the runner is scripts/bench-latency.ts).
 *
 * The 4.1 gate reads "TTFT at turn 10 of a full chat … down against 4.0.1,
 * numbers recorded, not estimated", and every Track S item claims a prefill
 * saving. This is the fixed workload those numbers come from, one request at
 * a time, against a real model:
 *
 *   cold          a prompt whose first bytes the server has never seen
 *   warm          the same request again: its prefix is cached
 *   turn-1…10     one chat growing a turn at a time, as a user types it —
 *                 each request extends the last, the case a prompt cache is for
 *   window-first  a chat past its window, trimmed by the app's own planner
 *   window-next   the next turn of it: the planner drops the oldest messages,
 *                 so the prefix changes just after the system prompt and the
 *                 whole window is prefilled again (Track S1's cost)
 *
 * Every text is fixed, and the assistant turns are canned rather than the
 * model's, so two runs send the same bytes. Each run's system prompt opens
 * with a nonce, so no run starts on another's cache.
 */

export interface BenchStep {
  scenario: string
  messages: ApiMessage[]
}

const SYSTEM = 'You are a helpful local assistant. Answer in two or three sentences.'

const TOPICS = [
  'the water cycle',
  'how bread rises',
  'why the sky is blue',
  'how a bicycle stays upright',
  'what a compiler does',
  'how vaccines train the immune system',
  'why ice floats',
  'how tides work',
  'what causes the seasons',
  'how a refrigerator moves heat',
  'why leaves change colour',
  'how a battery stores energy'
]

/** A user turn of roughly 250 tokens: a question and fixed context, distinct per turn. */
export function userTurn(i: number): string {
  const topic = TOPICS[i % TOPICS.length]!
  const context = Array.from({ length: 8 }, (_, k) => `Note ${i}.${k + 1}: I have read a little about ${topic} and want the short version, with one concrete example I can picture.`).join(' ')
  return `Question ${i + 1}: explain ${topic}. ${context}`
}

/** A canned assistant reply of roughly 80 tokens. */
export function assistantTurn(i: number): string {
  const topic = TOPICS[i % TOPICS.length]!
  return `Here is the short version of ${topic}. It comes down to one mechanism acting again and again, and the example to picture is an everyday one you have already seen. Ask if you want the longer explanation of ${topic} with the numbers.`
}

/** A chat at turn `n` (1-based): n user turns, the n−1 replies between them. */
export function conversation(n: number): ApiMessage[] {
  const out: ApiMessage[] = []
  for (let i = 0; i < n; i++) {
    out.push({ role: 'user', content: userTurn(i) })
    if (i < n - 1) out.push({ role: 'assistant', content: assistantTurn(i) })
  }
  return out
}

/** The app's own history planner, over the bench's messages: what fits `budgetTokens`, newest kept. */
export function withinWindow(messages: ApiMessage[], budgetTokens: number): ApiMessage[] {
  const chat = messages.map((m, i) => ({ id: String(i), role: m.role as 'user' | 'assistant', content: String(m.content ?? '') }) as ChatMessage)
  const { keep } = planHistory(chat, budgetTokens)
  // Some chat templates refuse a history that opens on the assistant; the chat's first kept turn is the user's.
  const from = keep[0]?.role === 'assistant' ? 1 : 0
  return keep.slice(from).map((m) => ({ role: m.role, content: m.content }))
}

export interface BenchPlanOptions {
  /** The loaded context, in tokens: the window scenarios are built past it. */
  window: number
  /** Tokens held back for the reply. */
  maxTokens: number
  /** One per request group, so no group reads another's cache. */
  nonce: () => string
}

const system = (nonce: string): ApiMessage => ({ role: 'system', content: `Session ${nonce}. ${SYSTEM}` })

/** One repeat of the whole workload, in the order it is sent. */
export function benchPlan(o: BenchPlanOptions): BenchStep[] {
  const steps: BenchStep[] = []
  const cold: ApiMessage[] = [system(o.nonce()), { role: 'user', content: userTurn(0) }]
  steps.push({ scenario: 'cold', messages: cold }, { scenario: 'warm', messages: cold })
  const chat = system(o.nonce())
  for (let n = 1; n <= 10; n++) steps.push({ scenario: `turn-${n}`, messages: [chat, ...conversation(n)] })
  // Past the window: enough turns that the planner must drop some, then one more.
  const budget = o.window - o.maxTokens - estimateTokens(String(chat.content)) - 256
  let n = 1
  while (conversation(n).reduce((t, m) => t + estimateTokens(String(m.content)), 0) <= budget * 1.5) n++
  const past = system(o.nonce())
  steps.push({ scenario: 'window-first', messages: [past, ...withinWindow(conversation(n), budget)] })
  steps.push({ scenario: 'window-next', messages: [past, ...withinWindow(conversation(n + 1), budget)] })
  return steps
}

/** The scenarios a report shows, in order; the other turns are kept in the line but not tabled. */
export const REPORTED = ['cold', 'warm', 'turn-1', 'turn-10', 'window-first', 'window-next'] as const

export interface ScenarioResult {
  ttftMs: number | null
  prefillMs: number | null
  promptTokens: number | null
  cachedTokens: number | null
  decodeTokPerSec: number | null
  /** Completed rounds the medians are over. */
  n: number
}

/** Median per scenario over the repeats; failed rounds are left out. */
export function summarizeBench(rounds: { scenario: string; latency: RoundLatency }[]): Record<string, ScenarioResult> {
  const by = new Map<string, RoundLatency[]>()
  for (const r of rounds) if (r.latency.ok) by.set(r.scenario, [...(by.get(r.scenario) ?? []), r.latency])
  const med = (xs: (number | null | undefined)[]): number | null => {
    const n = xs.filter((x): x is number => typeof x === 'number')
    return n.length ? Math.round(median(n) * 10) / 10 : null
  }
  const out: Record<string, ScenarioResult> = {}
  for (const [s, ls] of by) {
    out[s] = {
      ttftMs: med(ls.map((l) => l.ttftMs)),
      prefillMs: med(ls.map((l) => l.prefillMs)),
      promptTokens: med(ls.map((l) => l.promptTokens)),
      cachedTokens: med(ls.map((l) => l.cachedTokens)),
      decodeTokPerSec: med(ls.map((l) => l.decodeTokPerSec)),
      n: ls.length
    }
  }
  return out
}

export interface BenchLine {
  label: string
  model: string
  at: string
  window: number
  repeats: number
  /** Set when the GPU's error counter moved during the run: its times describe the machine (v4.1, decision 1). */
  machine?: string
  scenarios: Record<string, ScenarioResult>
}

/** The results file, tabled: one row per line, TTFT per reported scenario, then decode speed. */
export function formatBenchReport(lines: BenchLine[]): string {
  const out = [
    `| label | model | ${REPORTED.join(' | ')} | decode tok/s | prompt at window |`,
    `| --- | --- | ${REPORTED.map(() => '---').join(' | ')} | --- | --- |`
  ]
  for (const l of lines) {
    const s = l.scenarios
    const decode = median(Object.values(s).map((x) => x.decodeTokPerSec).filter((x): x is number => x !== null))
    out.push(
      `| ${l.label}${l.machine ? ' (machine)' : ''} | ${l.model} | ${REPORTED.map((k) => fmtMs(s[k]?.ttftMs)).join(' | ')} | ${decode ? decode.toFixed(1) : '—'} | ${s['window-next']?.promptTokens?.toLocaleString('en-US') ?? '—'} tok |`
    )
  }
  return out.join('\n')
}
