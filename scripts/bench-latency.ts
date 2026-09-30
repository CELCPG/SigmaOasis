/**
 * v4.1 (M7): the latency bench — what a request costs in time on a real
 * model, per release. The workload and the report are
 * src/main/agent/latencyBench.ts; the timing is the eval's own
 * (src/main/agent/latency.ts). Not part of the test suite; CI never runs it.
 *
 *   npm run bench:latency -- <model-id> [label]
 *   npm run bench:latency -- --report
 *
 *   BENCH_REPEATS=3        repeats of the whole workload; the line keeps the medians
 *   BENCH_WINDOW=16384     the context the window scenarios are built past — set it
 *                          to the model's loaded context
 *   BENCH_MAX_TOKENS=64    the reply cap: enough to time decoding, short enough not to dominate
 *   LMSTUDIO_BASE_URL=…    default http://127.0.0.1:1234/v1 (loopback only, as in the CLI)
 *
 * One line per run is appended to .latency-bench/results.jsonl, like
 * `bench:render`. Needs LM Studio to itself, the model already loaded (a cold
 * *load* is not what "cold" measures here — a cold *prefix* is), and the
 * machine quiet: a run the GPU's error counter moved in is marked, not dropped.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { fetchTransport } from '../src/main/agent/stream'
import { timedTransport, type RoundLatency } from '../src/main/agent/latency'
import { benchPlan, formatBenchReport, summarizeBench, type BenchLine } from '../src/main/agent/latencyBench'
import { describeGpu, machineMoved, readGpuSync } from './gpuHealth'
import { isLoopback } from '../src/cli/sigma'

// Compiled by scripts/bench-latency.sh to .latency-bench/build/scripts/bench-latency.js.
const REPO_ROOT = join(__dirname, '..', '..', '..')
const RESULTS = join(REPO_ROOT, '.latency-bench', 'results.jsonl')
const BASE_URL = process.env.LMSTUDIO_BASE_URL ?? 'http://127.0.0.1:1234/v1'
const num = (v: string | undefined, d: number): number => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : d)

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args[0] === '--report') {
    if (!existsSync(RESULTS)) throw new Error(`no results at ${RESULTS}: run the bench first`)
    const lines = readFileSync(RESULTS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as BenchLine)
    console.log(formatBenchReport(lines))
    return
  }
  const [model, label = 'unlabelled'] = args
  if (!model) {
    console.error('usage: npm run bench:latency -- <model-id> [label]\n       npm run bench:latency -- --report')
    process.exitCode = 1
    return
  }
  if (!isLoopback(BASE_URL)) throw new Error(`refusing ${BASE_URL}: the bench talks only to a model server on this machine`)
  const repeats = num(process.env.BENCH_REPEATS, 3)
  const window = num(process.env.BENCH_WINDOW, 16_384)
  const maxTokens = num(process.env.BENCH_MAX_TOKENS, 64)
  const url = `${BASE_URL.replace(/\/+$/, '')}/chat/completions`
  const signal = new AbortController().signal

  let current = ''
  const rounds: { scenario: string; latency: RoundLatency }[] = []
  const send = timedTransport(fetchTransport, (latency) => rounds.push({ scenario: current, latency }))
  const request = async (scenario: string, messages: unknown[]): Promise<void> => {
    current = scenario
    const res = await send(url, {
      body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true }, temperature: 0, max_tokens: maxTokens }),
      signal,
      stallMs: 180_000,
      onChunk: () => undefined
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(res.errorText ?? '').slice(0, 300)}`)
  }

  const gpuBefore = readGpuSync()
  console.log(`latency bench · ${model} · ${BASE_URL} · window ${window} · ${repeats} repeat${repeats === 1 ? '' : 's'}\n${describeGpu(gpuBefore)}`)
  // Not recorded: the model answers before anything is timed.
  await request('warm-up', [{ role: 'user', content: 'Reply with the word ready.' }])
  rounds.length = 0
  for (let r = 0; r < repeats; r++) {
    for (const step of benchPlan({ window, maxTokens, nonce: () => randomUUID().slice(0, 8) })) {
      await request(step.scenario, step.messages)
      const last = rounds[rounds.length - 1]!.latency
      process.stdout.write(`  [${r + 1}/${repeats}] ${step.scenario.padEnd(12)} TTFT ${String(last.ttftMs ?? '—').padStart(8)} ms · prompt ${last.promptTokens ?? '—'} tok${last.cachedTokens !== undefined ? ` (${last.cachedTokens} cached)` : ''} · ${last.decodeTokPerSec ?? '—'} tok/s\n`)
    }
  }
  const moved = machineMoved(gpuBefore, readGpuSync())
  const line: BenchLine = {
    label,
    model,
    at: new Date().toISOString(),
    window,
    repeats,
    ...(moved.moved ? { machine: `PCIe replay counter rose by ${moved.delta} during the run (times describe the machine)` } : {}),
    scenarios: summarizeBench(rounds)
  }
  mkdirSync(join(REPO_ROOT, '.latency-bench'), { recursive: true })
  appendFileSync(RESULTS, JSON.stringify(line) + '\n')
  console.log(`\n${formatBenchReport([line])}\n\nappended to ${RESULTS}`)
}

main().catch((err) => {
  console.error(`bench:latency: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
