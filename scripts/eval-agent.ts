/**
 * The agent eval (v3.1, ROADMAP-v3.1.md M1) — the shell around
 * src/main/agent/evalHarness.ts, which holds every rule that decides a score.
 *
 * Each case in test/fixtures/agent/ is run on a fresh copy of its repository
 * by the shipping engine, then scored off the disk and the event stream:
 * solved (hidden checks, or for read-only and needs-you the report), false
 * claims, collateral edits, Undo, and cost. See the harness's header.
 *
 * Requires a running LM Studio and is gated behind LMSTUDIO_EVAL=1 so CI stays
 * offline:
 *
 *   LMSTUDIO_EVAL=1 npm run eval:agent -- <model-id> [model-id ...]
 *
 *   EVAL_PASSES=3        repeat the suite; the report names stable and flaky cases
 *   EVAL_CASES=1-5       a 1-based inclusive slice, or case ids: fix-paginate,chain-stats
 *   EVAL_KEEP=1          keep each run's scratch folder
 *   EVAL_EXPERIMENTS=a,b turn those experiments on for every case (one arm of an A/B)
 *   EVAL_ROUND_MAX_TOKENS=8192  one round's output cap (16384, 8192 or 4096; default 16384)
 *   LMSTUDIO_BASE_URL=…  default http://127.0.0.1:1234/v1 (loopback only, as in the CLI); any
 *                        OpenAI-compatible server on this machine — llama-server too (v4.4, G6)
 *   EVAL_CONTROL=1       with an arm (EVAL_EXPERIMENTS or EVAL_ROUND_MAX_TOKENS): the same-day control
 *                        too — every switch off, a pass of each in turn, ABBA (v4.4, G1); arm-first
 *                        starts with the arm. Two results files, tagged control and arm.
 *   EVAL_SESSION=<id>    tag the results with a session, so a control and an arm run as separate
 *                        commands (EVAL_CASES slices) are read as one session by eval:diff
 *   EVAL_GPU=none        the server is not on this machine's NVIDIA card (the B60's llama-server):
 *                        skip the PCIe replay check, which would read the wrong card
 *   EVAL_AGENT_BASE_URL=…  4.6 (J1): run the agent through the app's agent connection — that server,
 *                        loopback only, routed and checked as the app routes and checks it
 *                        (src/main/agent/connection.ts); LMSTUDIO_BASE_URL stays the main connection
 *                        beside it. EVAL_AGENT_MODEL names its model (default: the one it serves);
 *                        give no model ids then. Results files record `connection`.
 *
 *     EVAL_AGENT_BASE_URL=http://127.0.0.1:8081/v1 EVAL_GPU=none LMSTUDIO_EVAL=1 npm run eval:agent
 *
 * Needs Node on the PATH: the cases' tests run with `node --test`, in the shell
 * the agent itself is given. Temperature is pinned to 0. Results are written to
 * .eval-results/agent-<model>-<time>.json after every case, so a stopped run
 * keeps what it finished.
 *
 * Needs LM Studio to itself. LM Studio unloads a model loaded on demand when
 * another client asks for a different one, and the first live run of this
 * suite lost its model that way to a Sigma Oasis window asking for its own:
 * seven runs, one silent server, six refusals. So the model is warmed before
 * the first case (a cold load is not charged to case one), a run the server
 * ended is excluded rather than failed, and two such runs in a row stop the
 * model's run — nothing after that point would be a measurement.
 */

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { defaultShell } from '../src/main/agent/command'
import { describeGpu, GPU_NOT_WATCHED, machineMoved, readGpuSync, watchesGpu } from './gpuHealth'
import {
  agentResultsFile,
  describeRun,
  evalAgentConnection,
  formatSummary,
  loadCases,
  runCase,
  summarize,
  type AgentCase,
  type CaseRun,
  type ModelSummary
} from '../src/main/agent/evalHarness'
import { isLoopback } from '../src/cli/sigma'
import { EXPERIMENT_KEYS, ROUND_MAX_TOKENS_OPTIONS, type AgentExperiments } from '../src/main/agent/types'
import { controlOrderFrom, sessionId, sidesForPass, type SessionRole } from '../src/main/agent/evalSession'
import { checkAgentServer, routeAgent, type AgentRoute } from '../src/main/agent/connection'

// Compiled by scripts/eval-agent.sh to .eval-build/scripts/eval-agent.js — the
// repo root is two levels up from there.
const REPO_ROOT = join(__dirname, '..', '..')
const CASES_DIR = join(REPO_ROOT, 'test', 'fixtures', 'agent')
const RESULTS_DIR = join(REPO_ROOT, '.eval-results')
const BASE_URL = process.env.LMSTUDIO_BASE_URL ?? 'http://127.0.0.1:1234/v1'
const USAGE = 'usage: LMSTUDIO_EVAL=1 npm run eval:agent -- <model-id> [model-id ...]'

/** v4.1 (M1): a comma list of experiment keys, each checked against the engine's own list. */
function experimentsFrom(spec: string | undefined): Partial<AgentExperiments> {
  const keys = (spec ?? '').split(',').map((k) => k.trim()).filter(Boolean)
  const unknown = keys.filter((k) => !(EXPERIMENT_KEYS as readonly string[]).includes(k))
  if (unknown.length) throw new Error(`EVAL_EXPERIMENTS names no such experiment: ${unknown.join(', ')} (known: ${EXPERIMENT_KEYS.join(', ')})`)
  return Object.fromEntries(keys.map((k) => [k, true])) as Partial<AgentExperiments>
}

function selectCases(all: AgentCase[], spec: string | undefined): AgentCase[] {
  if (!spec) return all
  const range = /^(\d+)-(\d+)$/.exec(spec.trim())
  if (range) return all.slice(Number(range[1]) - 1, Number(range[2]))
  const ids = spec.split(',').map((s) => s.trim()).filter(Boolean)
  const unknown = ids.filter((id) => !all.some((c) => c.id === id))
  if (unknown.length) throw new Error(`EVAL_CASES names no such case: ${unknown.join(', ')}`)
  return all.filter((c) => ids.includes(c.id))
}

/** One short completion, so the model is loaded and answering before anything is timed. */
async function warmUp(baseUrl: string, model: string): Promise<{ ok: true; ms: number } | { ok: false; error: string }> {
  const started = Date.now()
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the word ready.' }], max_tokens: 16, temperature: 0, stream: false }),
      // A cold load of a large model can take minutes.
      signal: AbortSignal.timeout(10 * 60_000)
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` }
    await res.json()
    return { ok: true, ms: Date.now() - started }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function main(): Promise<void> {
  if (!process.env.LMSTUDIO_EVAL) {
    console.log('The agent eval needs a live LM Studio and takes a long time, so it is gated: set LMSTUDIO_EVAL=1 first.\n\n  ' + USAGE)
    return
  }
  const models = process.argv.slice(2).filter((a) => a !== 'help')
  // 4.6 (J1): the agent connection, as the app builds it from its settings.
  const agentConnection = evalAgentConnection(process.env)
  if (!agentConnection.ok) {
    console.error(agentConnection.error)
    process.exitCode = 1
    return
  }
  if (agentConnection.connection && models.length > 0) {
    console.error('With EVAL_AGENT_BASE_URL the model is the agent connection\'s (EVAL_AGENT_MODEL, or the one that server serves): give no model ids.')
    process.exitCode = 1
    return
  }
  if (models.length === 0 && !agentConnection.connection) {
    console.error(USAGE)
    process.exitCode = 1
    return
  }
  if (!isLoopback(BASE_URL)) {
    console.error(`Refusing ${BASE_URL}: the eval talks only to a model server on this machine, as the CLI does.`)
    process.exitCode = 1
    return
  }
  // Where each model's run goes: the app's route, and on the agent connection
  // the app's check first — a server down or without the model stops here.
  let routes: AgentRoute[]
  if (agentConnection.connection) {
    const checked = await checkAgentServer(routeAgent(BASE_URL, agentConnection.connection, ''))
    if (!checked.ok) {
      console.error(checked.error)
      process.exitCode = 1
      return
    }
    routes = [checked.route]
  } else {
    routes = models.map((m) => routeAgent(BASE_URL, undefined, m))
  }
  const cases = selectCases(await loadCases(CASES_DIR), process.env.EVAL_CASES)
  const passes = Math.max(1, Math.min(9, Math.round(Number(process.env.EVAL_PASSES ?? '1')) || 1))
  const shell = defaultShell()
  // v4.1 (M1): EVAL_EXPERIMENTS=resultDigests,verifyRound turns those on for every case — one arm of an A/B.
  const experiments = experimentsFrom(process.env.EVAL_EXPERIMENTS)
  // v4.2 (A3): the round cap under test, one of the caps Settings offers.
  const roundMaxTokens = process.env.EVAL_ROUND_MAX_TOKENS ? Number(process.env.EVAL_ROUND_MAX_TOKENS) : undefined
  if (roundMaxTokens !== undefined && !ROUND_MAX_TOKENS_OPTIONS.includes(roundMaxTokens)) {
    throw new Error(`EVAL_ROUND_MAX_TOKENS must be one of ${ROUND_MAX_TOKENS_OPTIONS.join(', ')}`)
  }
  // v4.4 (G1): the same-day control, in this process (EVAL_CONTROL) or as a tag (EVAL_SESSION).
  const armOn = Object.keys(experiments).length > 0 || roundMaxTokens !== undefined
  const order = controlOrderFrom(process.env.EVAL_CONTROL)
  if (order && !armOn) throw new Error('EVAL_CONTROL runs a control beside an arm: name the arm with EVAL_EXPERIMENTS or EVAL_ROUND_MAX_TOKENS')
  const tagged = Boolean(order || process.env.EVAL_SESSION)
  sessionId(process.env.EVAL_SESSION, 'check') // a bad id stops here, before any model is asked anything
  // v4.4 (G6): a server on another card — the B60's llama-server — is not watched through nvidia-smi.
  const watchGpu = watchesGpu(process.env.EVAL_GPU)
  mkdirSync(RESULTS_DIR, { recursive: true })

  const controller = new AbortController()
  process.on('SIGINT', () => {
    if (controller.signal.aborted) process.exit(130)
    console.log('\n  stopping the current case (Ctrl+C again to quit at once)…')
    controller.abort()
  })

  const where = agentConnection.connection ? `agent connection ${routes[0]!.baseUrl} (main connection ${BASE_URL})` : BASE_URL
  console.log(`agent eval · ${cases.length} case${cases.length === 1 ? '' : 's'} × ${passes} pass${passes === 1 ? '' : 'es'} · ${where} · shell: ${shell.name}`)
  console.log('caveats: temperature 0; commands limited to each case\'s test runner; one model loaded at a time.')
  console.log('Close other LM Studio clients (a Sigma Oasis window included) for the length of the run.')
  // v4.0 (E9): the GPU's error counter, before the run and after each case.
  let gpu = watchGpu ? readGpuSync() : null
  console.log(`${watchGpu ? describeGpu(gpu) : GPU_NOT_WATCHED}\n`)
  if (order) console.log(`same-day control: every switch off, a pass of each in turn (${order}, then alternating)\n`)

  const summaries: ModelSummary[] = []
  for (const route of routes) {
    const model = route.model
    process.stdout.write(`warming ${model} … `)
    const warm = await warmUp(route.baseUrl, model)
    if (!warm.ok) {
      console.log(`failed: ${warm.error}\n  skipping ${model}.`)
      process.exitCode = 1
      continue
    }
    console.log(`answering after ${(warm.ms / 1000).toFixed(1)} s`)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const session = tagged ? sessionId(process.env.EVAL_SESSION, stamp) : undefined
    const slug = model.replace(/[^a-z0-9._-]+/gi, '_')
    // One side per results file: the arm as asked, and with EVAL_CONTROL its
    // control — no experiment, the default cap — beside it.
    interface Side {
      role: SessionRole
      experiments: Partial<AgentExperiments>
      roundMaxTokens?: number
      outFile: string
      byPass: CaseRun[][]
    }
    const armName = (Object.keys(experiments).length > 0 ? `-x-${Object.keys(experiments).sort().join('+')}` : '') + (roundMaxTokens ? `-cap${roundMaxTokens}` : '')
    const asked: Side = {
      role: armOn ? 'arm' : 'control',
      experiments,
      roundMaxTokens,
      outFile: join(RESULTS_DIR, `agent-${slug}${armName || (tagged ? '-control' : '')}-${stamp}.json`),
      byPass: []
    }
    const control: Side | null = order ? { role: 'control', experiments: {}, outFile: join(RESULTS_DIR, `agent-${slug}-control-${stamp}.json`), byPass: [] } : null
    const save = (side: Side): void =>
      writeFileSync(
        side.outFile,
        JSON.stringify(
          agentResultsFile({
            model,
            experiments: side.experiments,
            baseUrl: route.baseUrl,
            shell: shell.name,
            startedAt: stamp,
            passes,
            cases: cases.map((c) => c.id),
            runs: side.byPass,
            ...(session ? { session: { id: session, role: side.role } } : {}),
            ...(route.via === 'agent' ? { connection: { via: 'agent' as const, baseUrl: route.baseUrl, model, mainBaseUrl: BASE_URL } } : {})
          }),
          null,
          2
        )
      )
    let serverFailures = 0
    let lost = false
    for (let p = 0; p < passes && !controller.signal.aborted && !lost; p++) {
      const turn = order && control ? sidesForPass(p, order).map((r) => (r === 'control' ? control : asked)) : [asked]
      for (const side of turn) {
        if (controller.signal.aborted || lost) break
        const runs: CaseRun[] = []
        side.byPass.push(runs)
        const label = control ? ` · ${side.role}` : ''
        for (const c of cases) {
          if (controller.signal.aborted) break
          process.stdout.write(`[${model}${label} · pass ${p + 1}/${passes}] ${c.id} (${c.kind}) … `)
          const run = await runCase(c, {
            baseUrl: route.baseUrl,
            model,
            shell,
            signal: controller.signal,
            keep: Boolean(process.env.EVAL_KEEP),
            experiments: side.experiments,
            roundMaxTokens: side.roundMaxTokens
          })
          // A case during which the GPU's error counter moved measured the
          // machine: excluded and named, like a run the server ended.
          const after = watchGpu ? readGpuSync() : null
          const moved = machineMoved(gpu, after)
          gpu = after
          // v4.1 (decision 1): corrected replays taint the time, not the score.
          if (moved.moved) run.machine = `PCIe replay counter rose by ${moved.delta} during this case (time not counted)`
          runs.push(run)
          console.log(describeRun(run) + (moved.moved ? `  [machine: ${run.machine}]` : ''))
          save(side)
          serverFailures = run.excluded ? serverFailures + 1 : 0
          if (serverFailures >= 2) {
            console.log(`\n  stopping ${model}: the server failed two runs in a row, so nothing after this would be a measurement.`)
            console.log('  Is another client using LM Studio? Close it, then rerun the cases that were not scored (EVAL_CASES).')
            lost = true
            process.exitCode = 1
            break
          }
        }
      }
    }
    for (const side of control ? [control, asked] : [asked]) {
      summaries.push(summarize(control ? `${model} · ${side.role}` : model, side.byPass))
      console.log(`\n  results${control ? ` (${side.role})` : ''}: ${side.outFile}${session ? ` · session ${session}, ${side.role}` : ''}`)
    }
    console.log('')
  }

  console.log(formatSummary(summaries))
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exitCode = 1
})
