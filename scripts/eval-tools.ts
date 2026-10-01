/**
 * Layer 0b — the tool-choice eval harness (CLI shell).
 *
 * Scores a locally loaded model on the four numbers the routing/tools
 * strategy is judged by, against the fixtures in test/fixtures/toolchoice/.
 * All scoring logic lives in src/renderer/src/lib/evalRunner.ts, shared with
 * the in-app "Run eval" button so the two shells can never drift; this script
 * supplies only the transport, the system prompt, and the report.
 *
 * Two deliberate divergences from the app, both disclosed in the report:
 *
 *   1. Tool results are canned stubs, not real executions — the eval scores
 *      what the model *chooses*, and real execution would make scores depend
 *      on the network and the filesystem. Loop rate is therefore "loops
 *      against plausible results," not "loops in the wild."
 *   2. temperature is pinned to 0 for reproducible scores; the app uses the
 *      slot's configured sampling.
 *
 * Requires a running LM Studio and is gated behind LMSTUDIO_EVAL=1 so CI
 * stays offline:
 *
 *   LMSTUDIO_EVAL=1 npm run eval:tools -- <model-id> [model-id ...]
 *
 * Base URL defaults to http://127.0.0.1:1234/v1 (LMSTUDIO_BASE_URL overrides).
 * EVAL_FIXTURES=3-7 runs a 1-based inclusive slice — slow models (a 12B on a
 * laptop) can be evaluated in chunks that each fit a command time budget, and
 * the per-chunk JSON files aggregate to the same rates.
 * EVAL_FORCE_PREAMBLE=1 pins the Layer 1d tool-call preamble on regardless of
 * the reasoning gate: an A/B probe, not app behavior.
 * EVAL_VIBE=1 (v3.1, M3) runs the VIBE arm: VIBE's line in the system prompt,
 * where the app puts it. Its results are written as vibe-toolchoice-*.json so
 * the model picker's score line — the full view's number — never folds them in.
 * EVAL_SUBSET=1 (v2.5) is an arm the same way since v4.3: subset-toolchoice-*.json,
 * `arm: 'subset'` (with both, vibe-subset).
 * Results are written as JSON to .eval-results/ and folded into the model
 * picker's score line (Layer 0c).
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ApiMessage, ApiToolCall } from '../src/renderer/src/lib/agentLoop'
import { withGrounding, withToolCallPreamble, webToolsForTurn, TOOL_PREAMBLE_INSTRUCTION } from '../src/renderer/src/lib/grounding'
import { vibeSystemBlock } from '../src/renderer/src/lib/vibe'
import {
  parseCompletionMessage,
  runToolChoiceEval,
  summarizeRuns,
  type EvalFixture,
  type EvalFixtureRun
} from '../src/renderer/src/lib/evalRunner'
import { TOOL_SCHEMAS, TOOL_TURN_BUDGETS } from '../src/shared/tools'
import { createMcpManager } from '../src/main/ipc/mcp/manager'
import { selectTurnTools, withBudgetNotes, withForcedTools, TURN_TOOL_CAP } from '../src/renderer/src/lib/toolSelection'
import type { ToolSchema } from '../src/renderer/src/types'

// Compiled by scripts/eval-tools.sh to .eval-build/scripts/eval-tools.js —
// the repo root is two levels up from there.
const REPO_ROOT = join(__dirname, '..', '..')
const FIXTURES_DIR = join(REPO_ROOT, 'test', 'fixtures', 'toolchoice')
const RESULTS_DIR = join(REPO_ROOT, '.eval-results')

/**
 * The system prompt exactly as the app builds it: grounding preamble always,
 * plus the Layer 1d tool-call preamble when the model id gates on as a
 * reasoning model — so the eval measures what the app actually sends.
 *
 * EVAL_FORCE_PREAMBLE=1 pins the instruction on regardless of the reasoning
 * gate: an A/B probe for whether prompting would move the under-call failure
 * mode on reasoning models, which the app deliberately does not instruct.
 */
/**
 * v3.1 (M3): the VIBE arm. The app appends VIBE's line to the persona, the
 * slot's rules and the project's instructions — none of which the eval has —
 * and wraps the lot in the grounding block when it builds a chat turn's system
 * prompt, so here it rides the persona, ahead of the grounding. 3.0 measured that placement on one
 * question, "What time is it right now?", 7 turns in 8 (docs/evals.md, "VIBE:
 * where the brevity line goes"); this arm is the whole suite.
 */
const VIBE_ARM = Boolean(process.env.EVAL_VIBE)
/**
 * v4.3: EVAL_SUBSET=1 is an arm too. Through 4.2 its runs were written as
 * toolchoice-*.json with `arm: 'full'` — the picker folded them over the full
 * view's number (newest wins), and `eval:diff` could not tell the two apart, so
 * it would have merged them into one baseline.
 */
const SUBSET_ARM = Boolean(process.env.EVAL_SUBSET)
/**
 * v4.3: EVAL_FORCED_ON_TOP=1 (with EVAL_SUBSET) — an eval-only arm for a
 * decision the app has not taken (ROADMAP-v4.3, F6): tools the turn forces
 * ride on top of the cap instead of evicting the ranked picks. The app keeps
 * the cap (toolSelection.ts withForcedTools, since 4.0.1).
 */
const ON_TOP_ARM = SUBSET_ARM && Boolean(process.env.EVAL_FORCED_ON_TOP)
/** 'full', 'vibe', 'subset', 'vibe-subset', and '-ontop' after subset: the results file's `arm` and its name's prefix. */
const ARM = [VIBE_ARM ? 'vibe' : '', SUBSET_ARM ? 'subset' : '', ON_TOP_ARM ? 'ontop' : ''].filter(Boolean).join('-') || 'full'

function systemPromptFor(model: string): string {
  const base = withGrounding('You are a helpful local assistant.' + vibeSystemBlock(VIBE_ARM))
  if (process.env.EVAL_FORCE_PREAMBLE) return `${base}\n\n${TOOL_PREAMBLE_INSTRUCTION}`
  return withToolCallPreamble(base, model)
}

// ---- fixtures -----------------------------------------------------------------

function loadFixtures(): EvalFixture[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => {
      const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf-8')) as {
        prompt?: unknown
        expect?: unknown
      }
      if (typeof raw.prompt !== 'string' || !raw.prompt) {
        throw new Error(`${file}: missing "prompt"`)
      }
      const e = raw.expect
      const expect =
        e === 'no_tool'
          ? 'no_tool'
          : e && typeof e === 'object' && typeof (e as { tool?: unknown }).tool === 'string'
            ? ({ tool: (e as { tool: string }).tool } as const)
            : null
      if (!expect) throw new Error(`${file}: "expect" must be "no_tool" or { "tool": name }`)
      if (expect !== 'no_tool' && !TOOL_SCHEMAS.some((t) => t.function.name === expect.tool)) {
        throw new Error(`${file}: expected tool "${expect.tool}" is not in the shipped toolbox`)
      }
      return { file, prompt: raw.prompt, expect }
    })
}

// ---- one completion, shaped like the app's ------------------------------------

async function complete(
  baseUrl: string,
  model: string,
  messages: ApiMessage[],
  tools: ToolSchema[]
): Promise<{ content: string; toolCalls: ApiToolCall[] }> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // A reasoning model can think for many minutes on one fixture; cap the
    // wait so a single pathological generation fails that fixture instead of
    // killing the whole chunked run with no results written.
    signal: AbortSignal.timeout(240_000),
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      temperature: 0,
      ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {})
    })
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
  }
  const json = (await res.json()) as {
    choices?: {
      message?: {
        content?: string | null
        tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[]
      }
    }[]
  }
  return parseCompletionMessage(json.choices?.[0]?.message ?? {})
}

// ---- report --------------------------------------------------------------------

function pct(part: number, whole: number): string {
  return whole === 0 ? '—' : `${Math.round((part / whole) * 100)}%`
}

function mark(run: EvalFixtureRun): string {
  return run.error ? '!' : run.correct === false || run.spurious === true || run.looped ? '✗' : '✓'
}

// ---- main -------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!process.env.LMSTUDIO_EVAL) {
    console.log(
      'The tool-choice eval runs live completions against a local LM Studio server,\n' +
        'so it is gated: set LMSTUDIO_EVAL=1 (and start LM Studio) first.\n\n' +
        '  LMSTUDIO_EVAL=1 npm run eval:tools -- <model-id> [model-id ...]'
    )
    return
  }
  const models = process.argv.slice(2)
  if (models.length === 0) {
    console.error('usage: LMSTUDIO_EVAL=1 npm run eval:tools -- <model-id> [model-id ...]')
    process.exitCode = 1
    return
  }
  const baseUrl = process.env.LMSTUDIO_BASE_URL ?? 'http://127.0.0.1:1234/v1'
  let fixtures = loadFixtures()
  const range = /^(\d+)-(\d+)$/.exec(process.env.EVAL_FIXTURES ?? '')
  if (range) {
    fixtures = fixtures.slice(Number(range[1]) - 1, Number(range[2]))
    if (fixtures.length === 0) {
      console.error(`EVAL_FIXTURES=${range[0]} selects no fixtures.`)
      process.exitCode = 1
      return
    }
  }
  console.log(
    `tool-choice eval — ${fixtures.length} fixtures, ${models.length} model(s), ${baseUrl}\n` +
      'notes: tool results are canned stubs (choices are real, executions are not);\n' +
      '       temperature is pinned to 0. Loop rate means "looped against stub results."\n' +
      (process.env.EVAL_FORCE_PREAMBLE
        ? '       EVAL_FORCE_PREAMBLE=1 — tool-call preamble instruction pinned ON for all models\n' +
          '       (the app skips it for reasoning-gated models; this is an A/B probe, not app behavior).\n'
        : '') +
      (VIBE_ARM ? "       EVAL_VIBE=1 — the VIBE arm: VIBE's line in the system prompt, where the app puts it.\n" : '') +
      (ARM !== 'full' ? `       results go to ${ARM}-toolchoice-*.json, outside the model picker's score.\n` : '')
  )

  mkdirSync(RESULTS_DIR, { recursive: true })

  // v2.5: EVAL_MCP_STUB=<n> connects n stub MCP servers (three tools each,
  // deliberately overlapping descriptions) through the real manager and puts
  // their tools on the wire after the built-ins, exactly as the app does. The
  // question the run answers is whether their presence moves the built-in
  // correct-tool and spurious-call rates — nobody else shipping MCP publishes
  // that number. A call to a stub tool is spurious by construction: no fixture
  // expects one.
  const stubServers = Math.max(0, Math.round(Number(process.env.EVAL_MCP_STUB ?? '0')) || 0)
  // v2.7: run_code rides only a slot in Code Mode; the graded toolbox is the native one.
  const NATIVE_TOOLS = TOOL_SCHEMAS.filter((t) => t.function.name !== 'run_code')
  let tools = NATIVE_TOOLS
  let mcp: ReturnType<typeof createMcpManager> | null = null
  if (stubServers > 0) {
    mcp = createMcpManager({ builtInNames: new Set(TOOL_SCHEMAS.map((t) => t.function.name)) })
    const stub = join(REPO_ROOT, 'test', 'fixtures', 'mcp', 'stub-server.mjs')
    await mcp.apply(
      Array.from({ length: stubServers }, (_, i) => ({
        id: `stub${i + 1}`,
        name: `Stub ${i + 1}`,
        command: process.execPath,
        args: [stub],
        env: { ELECTRON_RUN_AS_NODE: '1' },
        enabled: true,
        disabledTools: []
      }))
    )
    const extra = mcp.schemas()
    tools = [...NATIVE_TOOLS, ...extra]
    console.log(`       EVAL_MCP_STUB=${stubServers} — ${extra.length} MCP tool(s) on the wire after the ${NATIVE_TOOLS.length} built-ins\n`)
  }

  // v2.5: EVAL_SUBSET=1 puts on the wire what the app puts on the wire — the
  // always-on tools plus the top embedding matches against the fixture's own
  // prompt, capped at TURN_TOOL_CAP, with the budgets disclosed — instead of
  // the whole toolbox. Without it the eval measures a list the app never
  // sends, and with MCP servers connected that list did not even fit an 8K
  // context. Ranking is the app's cosine over LM Studio's /v1/embeddings,
  // done here with plain fetch because this shell runs under node.
  let toolsFor: ((fixture: { prompt: string }, all: ToolSchema[]) => Promise<ToolSchema[]>) | undefined
  let wireSizes: number[] = []
  if (SUBSET_ARM) {
    const embedModel = await (async (): Promise<string | null> => {
      try {
        const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`)
        const json = (await res.json()) as { data?: { id: string }[] }
        return json.data?.find((m) => /embed/i.test(m.id))?.id ?? null
      } catch {
        return null
      }
    })()
    if (!embedModel) {
      console.error('EVAL_SUBSET=1 needs an embedding model in LM Studio (none listed).')
      process.exitCode = 1
      return
    }
    const embed = async (texts: string[]): Promise<number[][]> => {
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: embedModel, input: texts })
      })
      if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`)
      const json = (await res.json()) as { data: { index: number; embedding: number[] }[] }
      return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
    }
    const cosine = (a: number[], b: number[]): number => {
      let dot = 0
      let na = 0
      let nb = 0
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i]
        na += a[i] * a[i]
        nb += b[i] * b[i]
      }
      return na && nb ? dot / Math.sqrt(na * nb) : 0
    }
    const toolVectors = new Map<string, number[]>()
    const queryVectors = new Map<string, number[]>()
    toolsFor = async (fixture, all) => {
      const missing = all.filter((t) => !toolVectors.has(t.function.name))
      if (missing.length) {
        const vs = await embed(missing.map((t) => `${t.function.name}: ${t.function.description}`))
        missing.forEach((t, i) => toolVectors.set(t.function.name, vs[i]))
      }
      if (!queryVectors.has(fixture.prompt)) queryVectors.set(fixture.prompt, (await embed([fixture.prompt]))[0])
      const q = queryVectors.get(fixture.prompt)!
      const scores: Record<string, number> = {}
      for (const t of all) scores[t.function.name] = cosine(q, toolVectors.get(t.function.name)!)
      // v4.3: and the tools the chat forces onto the turn whatever the rank —
      // the web pair on a live or web-named question (chatTurn.ts, since
      // 4.0.1). Without it this arm was not the app's wire: on 2026-10-01 its
      // first wire record showed live weather and futures questions with no
      // web_search to call.
      const forced = webToolsForTurn(fixture.prompt)
      const cap = ON_TOP_ARM ? TURN_TOOL_CAP + forced.length : TURN_TOOL_CAP
      const selected = withBudgetNotes(withForcedTools(all, selectTurnTools(all, scores), forced, cap), TOOL_TURN_BUDGETS)
      wireSizes.push(selected.length)
      return selected
    }
    console.log(
      `       EVAL_SUBSET=1 — the app's per-turn selection (cap ${TURN_TOOL_CAP}), ranked by ${embedModel}, the web pair forced as the chat forces it\n` +
        (ON_TOP_ARM ? '       EVAL_FORCED_ON_TOP=1 — forced tools ride on top of the cap (an eval-only arm; not the app)\n' : '')
    )
  }

  // v2.5: EVAL_PASSES=N repeats the whole run and reports per-fixture
  // stability, the way the answer suites do — a ±1 between single runs at
  // temperature 0 is within what identical prompts produce.
  const passesWanted = Math.max(1, Math.min(9, Math.round(Number(process.env.EVAL_PASSES ?? '1')) || 1))
  const allPasses: Awaited<ReturnType<typeof runToolChoiceEval>>[] = []
  for (let pass = 0; pass < passesWanted; pass++) {
    if (passesWanted > 1) console.log(`  — pass ${pass + 1}/${passesWanted} —`)
    allPasses.push(
      await runToolChoiceEval({
        models,
        fixtures,
        tools,
        toolsFor,
        systemPromptFor,
        complete: (model, messages, tools) => complete(baseUrl, model, messages, tools),
        onFixture: (_model, _i, _total, run) => {
          process.stdout.write(`${mark(run)} ${run.file}\n`)
        }
      })
    )
  }
  if (mcp) await mcp.closeAll()
  if (wireSizes.length) {
    const avg = wireSizes.reduce((a, b) => a + b, 0) / wireSizes.length
    console.log(`\n  tools on the wire per fixture: ${avg.toFixed(1)} on average (of ${tools.length} registered)`)
  }

  // One result per model, aggregated over every pass.
  const results = models.map((model) => {
    const runs = allPasses.flatMap((p) => p.find((r) => r.model === model)?.runs ?? [])
    return { model, runs, rates: summarizeRuns(runs) }
  })

  if (passesWanted > 1) {
    for (const { model } of results) {
      const perPass = allPasses.map((p) => (p.find((r) => r.model === model)?.runs ?? []).filter((r) => r.correct !== false && !r.spurious && !r.looped && !r.error).length)
      const byFile = new Map<string, boolean[]>()
      for (const p of allPasses) for (const r of p.find((x) => x.model === model)?.runs ?? []) {
        const ok = r.correct !== false && !r.spurious && !r.looped && !r.error
        byFile.set(r.file, [...(byFile.get(r.file) ?? []), ok])
      }
      const flaky = [...byFile].filter(([, oks]) => oks.some(Boolean) && !oks.every(Boolean)).map(([f]) => f)
      const stablePass = [...byFile].filter(([, oks]) => oks.every(Boolean)).length
      const stableFail = [...byFile].filter(([, oks]) => !oks.some(Boolean)).length
      console.log(
        `\n${model}: clean across ${passesWanted} passes: [${perPass.join(', ')}] · stable-pass ${stablePass} · stable-fail ${stableFail} · flaky ${flaky.length}` +
          (flaky.length ? ` (${flaky.join(', ')})` : '')
      )
    }
  }

  for (const { model, runs, rates } of results) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    console.log(`\n${model}`)
    console.log(
      `  correct-tool rate   ${rates.correctTool.hit}/${rates.correctTool.of}   ${pct(rates.correctTool.hit, rates.correctTool.of)}`
    )
    console.log(
      `  spurious-call rate  ${rates.spuriousCall.hit}/${rates.spuriousCall.of}    ${pct(rates.spuriousCall.hit, rates.spuriousCall.of)}`
    )
    console.log(
      `  arg-validity rate   ${rates.argValidity.hit}/${rates.argValidity.of}   ${pct(rates.argValidity.hit, rates.argValidity.of)}`
    )
    console.log(`  loop rate           ${rates.loop.hit}/${rates.loop.of}   ${pct(rates.loop.hit, rates.loop.of)}`)

    const failures = runs.filter((r) => r.correct === false || r.spurious === true || r.looped || r.error)
    if (failures.length > 0) {
      console.log('  failures:')
      for (const f of failures) {
        if (f.error) console.log(`    ! ${f.file} — ${f.error}`)
        else if (f.correct === false) {
          const want = (f.expect as { tool: string }).tool
          // v4.3: in the subset arm, whether the ranking offered the tool at all.
          const offered = f.wire ? (f.wire.includes(want) ? ' (it was on the wire)' : ` (not on the wire: ${f.wire.join(', ')})`) : ''
          console.log(`    ✗ ${f.file} — expected ${want}, round 1 called: ${f.round1Calls.join(', ') || '(nothing)'}${offered}`)
        } else if (f.spurious) {
          console.log(`    ✗ ${f.file} — spurious call: ${f.round1Calls.join(', ')}`)
        } else if (f.looped) {
          console.log(`    ✗ ${f.file} — hit the iteration cap (${f.allCalls.length} calls)`)
        }
      }
    }
    if (runs.some((r) => r.error)) {
      console.log('  (fixtures marked ! errored at the server and are excluded from rates)')
    }

    const outFile = join(RESULTS_DIR, `${ARM === 'full' ? '' : `${ARM}-`}toolchoice-${model.replace(/[^a-z0-9._-]+/gi, '_')}-${stamp}.json`)
    writeFileSync(
      outFile,
      JSON.stringify(
        {
          model,
          baseUrl,
          ranAt: new Date().toISOString(),
          arm: ARM,
          caveats: [
            'tool results canned stubs',
            'temperature 0',
            ...(process.env.EVAL_FORCE_PREAMBLE
              ? ['EVAL_FORCE_PREAMBLE=1: preamble pinned on (not app behavior for reasoning models)']
              : []),
            ...(VIBE_ARM ? ['EVAL_VIBE=1: VIBE system line in place'] : []),
            ...(SUBSET_ARM ? [`EVAL_SUBSET=1: the app's per-turn selection, capped at ${TURN_TOOL_CAP}, web tools forced as the chat forces them (since 4.3)`] : []),
            ...(ON_TOP_ARM ? ['EVAL_FORCED_ON_TOP=1: forced tools on top of the cap — not the app'] : [])
          ],
          scores: {
            correctTool: rates.correctTool,
            spuriousCall: rates.spuriousCall,
            argValidity: rates.argValidity,
            loop: rates.loop
          },
          runs
        },
        null,
        2
      )
    )
    console.log(`  results: ${outFile}\n`)
  }
}

void main()
