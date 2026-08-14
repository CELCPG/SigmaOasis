import {
  runAgentLoop,
  type ApiMessage,
  type ApiToolCall
} from './agentLoop'
import { createReasoningSplitter } from './reasoning'
import { createNativeToolExtractor } from './nativeToolCall'
import { validateToolArgs } from './toolArgs'
import type { ToolCallRecord, ToolResult, ToolSchema } from '../types'

/**
 * The tool-choice eval runner (Layer 0b core), shared by both shells so the
 * CLI (`npm run eval:tools`) and the in-app "Run eval" button can never
 * drift: same loop, same stubs, same scoring. The shells supply only the
 * transport (a chat-completion call) and the system prompt; everything that
 * decides the four judged numbers lives here.
 *
 *   correct-tool rate   right tool named in round 1 on turns that need one
 *   spurious-call rate  a tool called on a no_tool fixture
 *   arg-validity rate   call arguments passing the tool's own JSON schema
 *   loop rate           turns hitting the iteration cap
 *
 * Tool results are canned stubs — the eval scores what the model *chooses*,
 * and real execution would make scores depend on the network and filesystem.
 */

export interface EvalFixture {
  file: string
  prompt: string
  expect: { tool: string } | 'no_tool'
}

export interface EvalFixtureRun {
  file: string
  prompt: string
  expect: EvalFixture['expect']
  round1Calls: string[]
  allCalls: { name: string; valid: boolean; errors: string[] }[]
  stopReason: string
  correct: boolean | null
  spurious: boolean | null
  looped: boolean
  error?: string
}

export interface EvalRate {
  hit: number
  of: number
}

export interface EvalRates {
  correctTool: EvalRate
  spuriousCall: EvalRate
  argValidity: EvalRate
  loop: EvalRate
}

export interface EvalModelRun {
  model: string
  runs: EvalFixtureRun[]
  rates: EvalRates
}

/** Canned tool results: short, plausible, and clearly marked in the report. */
export function evalStubResult(name: string): ToolResult {
  const stubs: Record<string, string> = {
    read_file: 'groceries\n- milk\n- eggs\n- coffee',
    write_file: 'File written.',
    list_directory: 'Documents\nDownloads\nPictures\nproject',
    run_terminal_command: '(command exited 0 with no output)',
    web_search:
      '1. Example result — https://example.com/1\n   A short snippet answering the query.\n' +
      '2. Another result — https://example.com/2\n   More relevant text.',
    image_search:
      '1. Example image — page: https://example.com/product\n   image: https://example.com/img.jpg\n' +
      '(thumbnails displayed to the user in the chat)',
    fetch_webpage: 'Page text relevant to the query, a few sentences long.',
    deep_research: 'Brief: the question, answered with numbered citations [1][2].',
    finance_calculator: 'Future value: $260,463. Total contributed: $120,000. Growth: $140,463.',
    date_calculator:
      'Saturday, 22 August 2026\nISO: 2026-08-22\nThat is in 8 day(s).\nWeekend: yes',
    get_current_datetime: new Date().toString(),
    create_note: 'Note saved.',
    list_notes: 'gift ideas',
    read_note: 'gift ideas\n\nvinyl records, a good chef\'s knife',
    memory_save: 'Saved to long-term memory.',
    memory_search: '(no matching memories)',
    memory_forget: 'No memory with that title.',
    shop_requirements:
      'Derived requirements: 32GB RAM, discrete GPU, 1TB SSD. Confirm before searching.',
    shop_compare:
      '| Seller | Price | Source | As of |\n| --- | --- | --- | --- |\n| Example | $1,899 | example.com | today |',
    price_watch: 'The watchlist is empty.'
  }
  return { ok: true, output: stubs[name] ?? '(ok)' }
}

/**
 * The same two-stage parse the app's stream path applies to a completion:
 * reasoning splitter first (think tags never become answer), then the
 * native-markup extractor (Gemma-style calls arrive in content on servers
 * without a parser). Tool calls arrive in OpenAI shape either way.
 */
export function parseCompletionMessage(
  msg: {
    content?: string | null
    tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[]
  },
  toolNames: readonly string[] = []
): { content: string; toolCalls: ApiToolCall[] } {
  const splitter = createReasoningSplitter()
  const native = createNativeToolExtractor(toolNames)
  let content = ''
  const calls: ApiToolCall[] = []
  const feed = (text: string): void => {
    if (!text) return
    const out = native.push(splitter.push(text).answer)
    if (out.text) content += out.text
    for (const c of out.calls) {
      calls.push({
        id: `call_native_${calls.length}`,
        type: 'function',
        function: { name: c.name, arguments: c.arguments }
      })
    }
  }
  feed(msg.content ?? '')
  const tailAnswer = splitter.flush().answer + native.flush().text
  if (tailAnswer) content += tailAnswer

  for (const [i, tc] of (msg.tool_calls ?? []).entries()) {
    const rawArgs = tc.function?.arguments
    calls.push({
      id: tc.id ?? `call_${i}`,
      type: 'function',
      function: {
        name: tc.function?.name ?? '',
        arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {})
      }
    })
  }
  return { content, toolCalls: calls }
}

/** The four judged numbers for one model's runs. Errored runs are excluded from rates. */
export function summarizeRuns(runs: EvalFixtureRun[]): EvalRates {
  const needTool = runs.filter((r) => r.expect !== 'no_tool' && !r.error)
  const noTool = runs.filter((r) => r.expect === 'no_tool' && !r.error)
  const calls = runs.filter((r) => !r.error).flatMap((r) => r.allCalls)
  return {
    correctTool: { hit: needTool.filter((r) => r.correct === true).length, of: needTool.length },
    spuriousCall: { hit: noTool.filter((r) => r.spurious === true).length, of: noTool.length },
    argValidity: { hit: calls.filter((c) => c.valid).length, of: calls.length },
    loop: { hit: runs.filter((r) => r.looped).length, of: runs.length }
  }
}

export interface EvalRunnerDeps {
  models: string[]
  fixtures: EvalFixture[]
  tools: ToolSchema[]
  /** The system prompt exactly as the app builds it for this model id. */
  systemPromptFor: (model: string) => string
  /** One non-streaming completion, temperature pinned by the shell. */
  complete: (
    model: string,
    messages: ApiMessage[],
    tools: ToolSchema[]
  ) => Promise<{ content: string; toolCalls: ApiToolCall[] }>
  /** Called after each fixture settles — the shells render progress from it. */
  onFixture?: (model: string, index: number, total: number, run: EvalFixtureRun) => void
  /** Checked between fixtures; true stops after the current fixture. */
  shouldStop?: () => boolean
}

async function runFixture(
  model: string,
  fixture: EvalFixture,
  deps: EvalRunnerDeps
): Promise<EvalFixtureRun> {
  const run: EvalFixtureRun = {
    file: fixture.file,
    prompt: fixture.prompt,
    expect: fixture.expect,
    round1Calls: [],
    allCalls: [],
    stopReason: 'error',
    correct: null,
    spurious: null,
    looped: false
  }
  const messages: ApiMessage[] = [
    { role: 'system', content: deps.systemPromptFor(model) },
    { role: 'user', content: fixture.prompt }
  ]
  const records: ToolCallRecord[] = []
  try {
    const outcome = await runAgentLoop({
      messages,
      tools: deps.tools,
      records,
      signal: new AbortController().signal,
      deps: {
        streamRound: (msgs, tools) => deps.complete(model, msgs, tools),
        executeTool: (name) => Promise.resolve(evalStubResult(name))
      }
    })
    run.stopReason = outcome.stopReason
    run.looped = outcome.stopReason === 'iteration_cap'

    const firstCallRound = messages.find((m) => m.role === 'assistant' && m.tool_calls?.length)
    run.round1Calls = firstCallRound?.tool_calls?.map((tc) => tc.function.name) ?? []

    run.allCalls = records.map((r) => {
      const schema = deps.tools.find((t) => t.function.name === r.name)
      if (!schema) return { name: r.name, valid: false, errors: ['unknown tool'] }
      const v = validateToolArgs(schema.function.parameters, r.args)
      return { name: r.name, valid: v.ok, errors: v.errors }
    })

    if (fixture.expect === 'no_tool') {
      run.spurious = run.round1Calls.length > 0
    } else {
      run.correct = run.round1Calls.includes(fixture.expect.tool)
    }
  } catch (err) {
    run.error = err instanceof Error ? err.message : String(err)
  }
  return run
}

/**
 * Run every fixture against every model, in order, and return one scored
 * block per model. Partial results are kept when shouldStop fires — a
 * cancelled run still saves what it measured.
 */
export async function runToolChoiceEval(deps: EvalRunnerDeps): Promise<EvalModelRun[]> {
  const results: EvalModelRun[] = []
  for (const model of deps.models) {
    const runs: EvalFixtureRun[] = []
    for (const [i, fixture] of deps.fixtures.entries()) {
      const run = await runFixture(model, fixture, deps)
      runs.push(run)
      deps.onFixture?.(model, i + 1, deps.fixtures.length, run)
      if (deps.shouldStop?.()) break
    }
    results.push({ model, runs, rates: summarizeRuns(runs) })
    if (deps.shouldStop?.()) break
  }
  return results
}
