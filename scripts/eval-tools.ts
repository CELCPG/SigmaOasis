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
 * Results are written as JSON to .eval-results/ and folded into the model
 * picker's score line (Layer 0c).
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ApiMessage, ApiToolCall } from '../src/renderer/src/lib/agentLoop'
import { withGrounding, withToolCallPreamble, TOOL_PREAMBLE_INSTRUCTION } from '../src/renderer/src/lib/grounding'
import {
  parseCompletionMessage,
  runToolChoiceEval,
  type EvalFixture,
  type EvalFixtureRun
} from '../src/renderer/src/lib/evalRunner'
import { TOOL_SCHEMAS } from '../src/shared/tools'
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
function systemPromptFor(model: string): string {
  const base = withGrounding('You are a helpful local assistant.')
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
        : '')
  )

  mkdirSync(RESULTS_DIR, { recursive: true })

  const results = await runToolChoiceEval({
    models,
    fixtures,
    tools: TOOL_SCHEMAS,
    systemPromptFor,
    complete: (model, messages, tools) => complete(baseUrl, model, messages, tools),
    onFixture: (_model, _i, _total, run) => {
      process.stdout.write(`${mark(run)} ${run.file}\n`)
    }
  })

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
          console.log(
            `    ✗ ${f.file} — expected ${(f.expect as { tool: string }).tool}, round 1 called: ${f.round1Calls.join(', ') || '(nothing)'}`
          )
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

    const outFile = join(RESULTS_DIR, `toolchoice-${model.replace(/[^a-z0-9._-]+/gi, '_')}-${stamp}.json`)
    writeFileSync(
      outFile,
      JSON.stringify(
        {
          model,
          baseUrl,
          ranAt: new Date().toISOString(),
          caveats: [
            'tool results canned stubs',
            'temperature 0',
            ...(process.env.EVAL_FORCE_PREAMBLE
              ? ['EVAL_FORCE_PREAMBLE=1: preamble pinned on (not app behavior for reasoning models)']
              : [])
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
