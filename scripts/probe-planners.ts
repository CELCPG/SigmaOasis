/**
 * v4.5 (H2): the think-first planners' probe.
 *
 * 4.4 (G5) found that a `json_schema` grammar plus `thinking: false` does not
 * stop a `<think>` family (qwen3.8-9b-distill) thinking in LM Studio: the
 * re-rank's 80 tokens all went to reasoning. The same pairing is sent by four
 * planners — plan mode, the outline, deep research's planner and its query
 * reformulation — whose budgets are larger. This asks each of them, on the
 * live model, two ways:
 *
 *   today    the caller's own request (grammar + thinking:false, no prefill),
 *            sent and read as the app sends and reads it (chatCompleteJson)
 *   prefill  the same request without the grammar, so thinking:false becomes
 *            the closed-think prefill, the shape said in the prompt, the reply
 *            read tolerantly (chatCompleteJsonPlain)
 *
 * The callers are the compiled production modules; only electron, the store
 * (the base URL), the network seam (a bare fetch to the loopback server, so the
 * wire can be read back) and the model pin (never load or unload from here) are
 * stubbed. Each call is read by the caller's own parser. Arms are interleaved
 * ABBA across prompts, and every call is appended to the results file as it
 * finishes, so a killed chunk resumes where it stopped.
 *
 *   npm run probe:planners -- --planner plan|outline|research|reformulate|all
 *   npm run probe:planners -- --summary
 *   npm run probe:planners -- --dry            (the wire bodies, nothing sent)
 *
 *   --model <id>       default qwen3.8-9b-distill
 *   --out <file>       default .probe-planners/results.jsonl
 *   --budget-s <n>     stop starting calls after n seconds (default 420); a call
 *                      in flight at the limit is dropped and re-asked next chunk
 *   --limit <n>        only the first n prompts of each planner
 *   --prompts 2,3,5    only these prompts (indexes); --arms prefill only that arm
 *   --tag detail       a separate pass: its rows are kept apart (and keep the whole reply),
 *                      and --summary --tag detail reads them
 *   LMSTUDIO_BASE_URL  default http://127.0.0.1:1234/v1 (loopback only)
 *
 * Needs the model loaded and the machine to itself. Not part of the test suite.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import Module from 'module'
import { dirname, join } from 'path'
import type { SubQuestion } from '../src/main/ipc/deepResearch/types'

// Compiled by scripts/probe-planners.sh to .probe-planners/build/scripts/probe-planners.js.
const REPO_ROOT = join(__dirname, '..', '..', '..')
const COMPILED_IPC = join(__dirname, '..', 'src', 'main', 'ipc')
const BASE_URL = process.env.LMSTUDIO_BASE_URL ?? 'http://127.0.0.1:1234/v1'

type Arm = 'today' | 'prefill'
type PlannerName = 'plan' | 'outline' | 'research' | 'reformulate'
const PLANNERS: PlannerName[] = ['plan', 'outline', 'research', 'reformulate']

// ---- the prompts: realistic, ≥10 per planner --------------------------------

interface PlanCase {
  task: string
  context?: string
  tools?: string[]
}

const PLAN_CASES: PlanCase[] = [
  { task: 'Plan a three-day trip to Lisbon for two on about 900 euros, flights excluded.' },
  { task: 'Set up a weekly meal-prep routine for a family of four that keeps groceries under $120 a week.' },
  { task: 'Compare three project-management tools for a five-person design studio and recommend one.', tools: ['web_search', 'fetch_webpage'] },
  { task: 'Migrate a small Express app from JavaScript to TypeScript without breaking its tests.', tools: ['read_file', 'write_file', 'run_command'] },
  { task: 'Prepare a one-page brief for the board on why we should move our email from self-hosted to a hosted provider.' },
  { task: 'Work out how much emergency water and food a household of three needs for a week, and list what to buy.', tools: ['library_search', 'finance_calculator'] },
  {
    task: 'Build the training schedule for me.',
    context:
      "User: I'm training for a half marathon in ten weeks. I can run three times a week and I'm at 5 km now.\n" +
      'Assistant: Good base. Ten weeks is enough if the long run grows by about 10% a week and every fourth week is easier.'
  },
  {
    task: 'Cut the budget so I can save 800 a month, and say what to give up first.',
    context:
      'User: Rent is 1400, food 450, transport 120, phone and internet 90, subscriptions 60, going out 200, and I put 500 aside. Income is 3300 after tax.\n' +
      'Assistant: That is 2,320 of spending plus 500 saved, so about 480 a month is not accounted for.'
  },
  { task: 'Learn the basics of watercolor painting in a month, practicing 30 minutes a day.' },
  { task: 'Audit our website for accessibility problems and produce a prioritized fix list.', tools: ['fetch_webpage', 'web_search'] },
  {
    task: 'Plan the rollout of a new point-of-sale system next month.',
    context:
      'User: We run a twelve-person bakery with two registers and a small online shop.\n' +
      'Assistant: Then the risks are the morning rush, the card reader contract and keeping the online stock in sync.'
  },
  { task: 'Write and publish a short guide to composting in an apartment.' }
]

const OUTLINE_REQUESTS: string[] = [
  'Write a 1,500-word report on how heat pumps work and when they make sense for a cold climate.',
  'Draft a 1,200-word explainer for new hires on how our code review process works.',
  'Write a 2,000-word guide to starting a vegetable garden on a balcony.',
  'Produce a 1,000-word briefing on the main causes of the 2008 financial crisis for a general audience.',
  'Write a 1,500-word proposal for a community library makerspace.',
  'Draft a 1,800-word white paper on edge computing for retail chains.',
  'Write a 1,200-word essay on why sleep matters for teenagers and what schools can do about it.',
  'Compose a 1,500-word onboarding guide for volunteers at a food bank.',
  'Write a 1,000-word overview of how vaccines are tested and approved.',
  'Prepare a 2,500-word study guide on the basics of personal finance for college students.',
  'Write a 1,300-word review of the state of open-source local LLM tooling for hobbyists.',
  'Draft a 1,500-word incident postmortem for a three-hour database outage caused by a bad migration.'
]

const RESEARCH_QUESTIONS: string[] = [
  'What coffee-to-water ratio and water temperature should I use for pour-over, and how long should it take?',
  'How do heat pumps perform below -15°C and which models are best for cold climates?',
  'What is the current evidence on intermittent fasting for type 2 diabetes?',
  'Which open-source vector databases are the best fit for a small self-hosted search project?',
  'How many charge cycles should I expect from a home battery, and how does depth of discharge change that?',
  'What are the tax implications of selling a rental property in Pennsylvania after owning it for six years?',
  'Compare Rust and Go for writing a command-line tool that processes large log files.',
  'How has the price of solar panels changed since 2015 and what drives it?',
  'What are the safest ways to remove lead paint from a 1950s house?',
  'How does the EU AI Act classify general-purpose models, and what does that mean for open-weight releases?',
  'What is the best way to store sourdough starter when I travel for two weeks?',
  'Why do some local LLMs loop in long contexts and what mitigations work?'
]

const sub = (question: string, ...queries: string[]): SubQuestion => ({ question, queries })
const REFORMULATE_CASES: SubQuestion[][] = [
  [sub('What water temperature is best for pour-over coffee?', 'pour-over water temperature', 'best temperature pour over')],
  [sub('How does depth of discharge change battery cycle life?', 'depth of discharge cycle life'), sub('Which home batteries have the longest warranties?', 'home battery warranty comparison')],
  [sub('What does Pennsylvania tax on the sale of a rental property?', 'pennsylvania rental property sale tax', 'pa capital gains rental')],
  [sub('How do Rust and Go compare for log processing?', 'rust vs go log processing'), sub('Which has better memory use on large files?', 'rust go memory large files'), sub('Which is faster to write for a small team?', 'rust go developer productivity')],
  [sub('How is lead paint safely removed?', 'lead paint removal safe method')],
  [sub('How does the EU AI Act classify general-purpose models?', 'eu ai act general purpose models', 'gpai systemic risk threshold'), sub('Do open-weight releases get an exemption?', 'eu ai act open source exemption')],
  [sub('Why do local LLMs loop in long contexts?', 'llm repetition loop long context')],
  [sub('How long can sourdough starter be left unfed?', 'sourdough starter unfed how long', 'store starter two weeks')],
  [sub('How has solar panel pricing changed since 2015?', 'solar panel price per watt history'), sub('What drives the price of solar modules?', 'solar module price drivers polysilicon')],
  [sub('What is the evidence for intermittent fasting in type 2 diabetes?', 'intermittent fasting type 2 diabetes trial')],
  [sub('Which vector databases can be self-hosted on a small server?', 'self-hosted vector database small', 'open source vector database comparison'), sub('How much memory does each need for a million vectors?', 'vector database memory million vectors')],
  [sub('How do heat pumps perform at -15°C?', 'cold climate heat pump -15c performance'), sub('Which models are rated for cold climates?', 'cold climate heat pump models rated'), sub('What does installation cost?', 'heat pump installation cost')]
]

// ---- the stubs ---------------------------------------------------------------

interface Capture {
  /** What was asked, read off the body. */
  responseFormat: string | null
  lastRole: string | null
  prefill: boolean
  maxTokens: number | null
  messages: number
  /** What came back. */
  status: number
  finishReason: string | null
  completionTokens: number | null
  promptTokens: number | null
  reasoningChars: number
  inlineThinkChars: number
  content: string
  reasoningHead: string
  fetchMs: number
}

const chunkAbort = new AbortController()
let captures: Capture[] = []
let dry = false

function describeBody(body: string): Pick<Capture, 'responseFormat' | 'lastRole' | 'prefill' | 'maxTokens' | 'messages'> {
  const b = JSON.parse(body) as { response_format?: { type?: string }; messages?: { role: string; content: string }[]; max_tokens?: number }
  const last = b.messages?.at(-1)
  return {
    responseFormat: b.response_format?.type ?? null,
    lastRole: last?.role ?? null,
    prefill: last?.role === 'assistant' && /^<think>\s*<\/think>/.test(last.content),
    maxTokens: b.max_tokens ?? null,
    messages: b.messages?.length ?? 0
  }
}

const netStub = {
  auditedFetch: async (
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; timeoutMs?: number } | undefined
  ) => {
    const asked = init?.body ? describeBody(init.body) : { responseFormat: null, lastRole: null, prefill: false, maxTokens: null, messages: 0 }
    if (dry) {
      captures.push({ ...asked, status: 200, finishReason: 'stop', completionTokens: 0, promptTokens: 0, reasoningChars: 0, inlineThinkChars: 0, content: init?.body ?? '', reasoningHead: '', fetchMs: 0 })
      const canned = JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] })
      return { ok: true, status: 200, text: async () => canned, json: async () => JSON.parse(canned) }
    }
    const signals: AbortSignal[] = [chunkAbort.signal]
    if (init?.signal) signals.push(init.signal)
    if (init?.timeoutMs) signals.push(AbortSignal.timeout(init.timeoutMs))
    const t0 = performance.now()
    let status = 0
    let text = ''
    try {
      const res = await fetch(url, { method: init?.method ?? 'GET', headers: init?.headers, body: init?.body, signal: AbortSignal.any(signals) })
      status = res.status
      text = await res.text()
    } catch (err) {
      if (chunkAbort.signal.aborted) throw err
      if (err instanceof Error && err.name === 'TimeoutError') throw new Error(`Request timed out after ${Math.round((init?.timeoutMs ?? 0) / 1000)}s`)
      throw err
    }
    const fetchMs = performance.now() - t0
    let data: { choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[]; usage?: { completion_tokens?: number; prompt_tokens?: number } } = {}
    try {
      data = JSON.parse(text)
    } catch {
      // A non-JSON body (an error page) is recorded as status + empty content.
    }
    const message = data.choices?.[0]?.message
    const content = message?.content ?? ''
    const reasoning = message?.reasoning_content ?? ''
    const inline = [...content.matchAll(/<(think|thinking|reason|reasoning)>[\s\S]*?(?:<\/\1>|$)/gi)].reduce((n, m) => n + m[0].length, 0)
    captures.push({
      ...asked,
      status,
      finishReason: data.choices?.[0]?.finish_reason ?? null,
      completionTokens: data.usage?.completion_tokens ?? null,
      promptTokens: data.usage?.prompt_tokens ?? null,
      reasoningChars: reasoning.length,
      inlineThinkChars: inline,
      content: content.slice(0, 8000),
      reasoningHead: reasoning.slice(0, 240),
      fetchMs: Math.round(fetchMs)
    })
    return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) }
  }
}

const storeStub = { getSettings: () => ({ baseUrl: BASE_URL, plan: { maxSteps: 6, confirmPlan: true } }) }
const pinStub = { pinChatModel: async () => undefined, registerModelPinHandlers: () => undefined }
const electronStub = { ipcMain: { handle: () => undefined, on: () => undefined } }

type Loader = (request: string, parent: { filename?: string } | null, isMain: boolean) => unknown
const moduleInternals = Module as unknown as { _load: Loader }
const original = moduleInternals._load
moduleInternals._load = function (this: unknown, request, parent, isMain) {
  if (request === 'electron') return electronStub
  if (parent?.filename?.startsWith(COMPILED_IPC)) {
    if (request === './store' || request === '../store') return storeStub
    if (request === './net' || request === '../net') return netStub
    if (request === './modelPin' || request === '../modelPin') return pinStub
  }
  return original.call(this, request, parent, isMain)
}

// The compiled production modules, required only now that the seams are in place.
const llm = require(join(COMPILED_IPC, 'llm')) as typeof import('../src/main/ipc/llm')
const planMod = require(join(COMPILED_IPC, 'plan')) as typeof import('../src/main/ipc/plan')
const outlineMod = require(join(COMPILED_IPC, 'outline')) as typeof import('../src/main/ipc/outline')
const researchMod = require(join(COMPILED_IPC, 'deepResearch', 'plan')) as typeof import('../src/main/ipc/deepResearch/plan')

// ---- schema check (the subset these four use) ---------------------------------

type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; items?: Schema; enum?: unknown[]; minItems?: number; maxItems?: number }

/** The first way a value departs from the schema, or null when it fits. */
export function schemaProblem(value: unknown, schema: Schema, path = '$'): string | null {
  if (schema.enum && !schema.enum.includes(value)) return `${path}: ${JSON.stringify(value)} is not one of the allowed values`
  switch (schema.type) {
    case 'string':
      return typeof value === 'string' ? null : `${path}: not a string`
    case 'array': {
      if (!Array.isArray(value)) return `${path}: not an array`
      if (schema.minItems !== undefined && value.length < schema.minItems) return `${path}: fewer than ${schema.minItems} items`
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path}: more than ${schema.maxItems} items (${value.length})`
      for (const [i, v] of value.entries()) {
        const p = schema.items ? schemaProblem(v, schema.items, `${path}[${i}]`) : null
        if (p) return p
      }
      return null
    }
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path}: not an object`
      const o = value as Record<string, unknown>
      const missing = (schema.required ?? []).find((k) => !(k in o))
      if (missing) return `${path}: missing "${missing}"`
      const extra = schema.additionalProperties === false ? Object.keys(o).find((k) => !(k in (schema.properties ?? {}))) : undefined
      if (extra) return `${path}: extra key "${extra}"`
      for (const [k, s] of Object.entries(schema.properties ?? {})) {
        const p = k in o ? schemaProblem(o[k], s, `${path}.${k}`) : null
        if (p) return p
      }
      return null
    }
    default:
      return null
  }
}

export const matchesSchema = (value: unknown, schema: Schema): boolean => schemaProblem(value, schema) === null

// ---- one call per planner, read by that caller's own parser -------------------

interface Outcome {
  valid: boolean
  schemaOk: boolean
  /** Why not, when it does not fit the grammar's schema (the first departure). */
  schemaProblem: string | null
  /** Steps, sections, sub-questions, or re-asked sub-questions. */
  n: number
  /** Plan mode with tools: how each step disclosed what it may use. */
  disclosure?: { steps: number; withToolsField: number; withTools: number; namesNotEnabled: number }
}

type Ask = <T>(request: import('../src/main/ipc/llm').CompleteOptions, arm: Arm) => Promise<T | null>
const ask: Ask = (request, arm) => (arm === 'today' ? llm.chatCompleteJson(request) : llm.chatCompleteJsonPlain(request)) as never

const MODEL = (): string => modelArg

interface Planner {
  count: number
  run: (i: number, arm: Arm) => Promise<Outcome>
}

const PLAN_CAP = 6

const planners: Record<PlannerName, Planner> = {
  plan: {
    count: PLAN_CASES.length,
    run: async (i, arm) => {
      const c = PLAN_CASES[i]!
      const tools = c.tools ?? []
      const request = planMod.planRequest(MODEL(), c.task, PLAN_CAP, c.context, tools, arm === 'prefill')
      const parsed = await ask<import('../src/main/ipc/plan').PlanPayload>(request, arm)
      const steps = planMod.stepsFromPayload(parsed, PLAN_CAP, new Set(tools))
      const schema = planMod.planRequest(MODEL(), c.task, PLAN_CAP, c.context, tools, false).jsonSchema!.schema as Schema
      const problem = schemaProblem(parsed, schema)
      const raw = parsed?.steps ?? []
      const disclosure = tools.length > 0 ? { steps: raw.length, withToolsField: raw.filter((s) => Array.isArray(s?.tools)).length, withTools: raw.filter((s) => Array.isArray(s?.tools) && s.tools.length > 0).length, namesNotEnabled: raw.reduce((n, s) => n + (Array.isArray(s?.tools) ? s.tools.filter((t) => !tools.includes(String(t))).length : 0), 0) } : undefined
      return { valid: steps !== null, schemaOk: problem === null, schemaProblem: problem, n: steps?.length ?? 0, disclosure }
    }
  },
  outline: {
    count: OUTLINE_REQUESTS.length,
    run: async (i, arm) => {
      const r = OUTLINE_REQUESTS[i]!
      const parsed = await ask<unknown>(outlineMod.outlineRequest(MODEL(), r, undefined, arm === 'prefill'), arm)
      const outline = outlineMod.cleanOutline(parsed)
      const schema = outlineMod.outlineRequest(MODEL(), r).jsonSchema!.schema as Schema
      const problem = schemaProblem(parsed, schema)
      return { valid: outline !== null, schemaOk: problem === null, schemaProblem: problem, n: outline?.sections.length ?? 0 }
    }
  },
  research: {
    count: RESEARCH_QUESTIONS.length,
    run: async (i, arm) => {
      const q = RESEARCH_QUESTIONS[i]!
      const raw = await ask<unknown>(researchMod.plannerRequest(q, MODEL(), undefined, arm === 'prefill'), arm)
      const plan = researchMod.parsePlan(raw, q)
      // makePlan's own test for a real plan versus the one-question fallback.
      const planned = !!plan && !(plan.subQuestions.length === 1 && plan.subQuestions[0]!.question === q.trim())
      const schema = researchMod.plannerRequest(q, MODEL()).jsonSchema!.schema as Schema
      const problem = schemaProblem(raw, schema)
      return { valid: planned, schemaOk: problem === null, schemaProblem: problem, n: plan?.subQuestions.length ?? 0 }
    }
  },
  reformulate: {
    count: REFORMULATE_CASES.length,
    run: async (i, arm) => {
      const open = REFORMULATE_CASES[i]!
      const raw = await ask<{ queries?: { queries?: unknown }[] }>(researchMod.reformulateRequest(open, MODEL(), undefined, arm === 'prefill'), arm)
      const queries = researchMod.queriesFromReformulation(raw, open)
      // A sub-question the model did not re-ask comes back as its own array.
      const reasked = open.filter((s, k) => queries[k] !== s.queries).length
      const schema = researchMod.reformulateRequest(open, MODEL()).jsonSchema!.schema as Schema
      const problem = schemaProblem(raw, schema)
      return { valid: reasked === open.length, schemaOk: problem === null, schemaProblem: problem, n: reasked }
    }
  }
}

// ---- running ------------------------------------------------------------------

interface Row {
  planner: PlannerName
  prompt: number
  arm: Arm
  /** The pass: '' is the main protocol, 'detail' a re-ask that keeps the whole reply. */
  tag?: string
  at: string
  model: string
  valid: boolean
  schemaOk: boolean
  schemaProblem?: string | null
  disclosure?: Outcome['disclosure']
  n: number
  wallMs: number
  /** Requests the call made (a grammar the server rejects steps down). */
  requests: number
  completionTokens: number | null
  promptTokens: number | null
  reasoningChars: number
  thought: boolean
  finishReason: string | null
  error: string | null
  errorKind: 'none' | 'reasoning-only' | 'timeout' | 'http' | 'other'
  wire: { responseFormat: string | null; prefill: boolean; maxTokens: number | null }
  reply: string
  /** The whole reply (up to 8,000 characters); rows from the first pass keep only `reply`. */
  replyFull?: string
  reasoningHead: string
}

function classify(err: unknown): { kind: Row['errorKind']; message: string } {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof Error && err.name === 'ReasoningOnlyError') return { kind: 'reasoning-only', message }
  if (/timed out/i.test(message)) return { kind: 'timeout', message }
  if (/HTTP \d{3}/.test(message)) return { kind: 'http', message }
  return { kind: 'other', message }
}

async function oneCall(name: PlannerName, prompt: number, arm: Arm): Promise<Row | null> {
  captures = []
  const t0 = performance.now()
  let outcome: Outcome = { valid: false, schemaOk: false, schemaProblem: null, n: 0 }
  let failure: { kind: Row['errorKind']; message: string } | null = null
  try {
    outcome = await planners[name].run(prompt, arm)
  } catch (err) {
    if (chunkAbort.signal.aborted) return null
    failure = classify(err)
  }
  const wallMs = Math.round(performance.now() - t0)
  const sum = (f: (c: Capture) => number | null): number | null => (captures.some((c) => f(c) !== null) ? captures.reduce((n, c) => n + (f(c) ?? 0), 0) : null)
  const last = captures.at(-1)
  const first = captures[0]
  const reasoningChars = captures.reduce((n, c) => n + c.reasoningChars + c.inlineThinkChars, 0)
  return {
    planner: name,
    prompt,
    arm,
    tag: tagArg,
    at: new Date().toISOString(),
    model: modelArg,
    ...outcome,
    wallMs,
    requests: captures.length,
    completionTokens: sum((c) => c.completionTokens),
    promptTokens: sum((c) => c.promptTokens),
    reasoningChars,
    thought: reasoningChars > 0,
    finishReason: last?.finishReason ?? null,
    error: failure?.message.slice(0, 300) ?? null,
    errorKind: failure?.kind ?? 'none',
    wire: { responseFormat: first?.responseFormat ?? null, prefill: first?.prefill ?? false, maxTokens: first?.maxTokens ?? null },
    reply: (last?.content ?? '').slice(0, 500),
    replyFull: last?.content ?? '',
    reasoningHead: (captures.find((c) => c.reasoningHead)?.reasoningHead ?? '')
  }
}

function readRows(file: string): Row[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row)
}

// ---- the summary ----------------------------------------------------------------

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}
const pct = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!
}
const sec = (ms: number | null): string => (ms === null ? '—' : (ms / 1000).toFixed(1))
const num = (n: number | null): string => (n === null ? '—' : String(Math.round(n)))

export function summarize(rows: Row[]): string {
  const out: string[] = ['| planner | arm | n | valid | schema-valid | median s | p90 s | median s (valid only) | median tokens | thought | fallback | timeouts | reasoning-only | other errors |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
  const verdicts: string[] = []
  for (const name of PLANNERS) {
    const by: Record<Arm, Row[]> = { today: [], prefill: [] }
    for (const r of rows) if (r.planner === name) by[r.arm].push(r)
    if (by.today.length + by.prefill.length === 0) continue
    // Only prompts both arms have answered are compared head to head.
    const both = new Set([...new Set(by.today.map((r) => r.prompt))].filter((p) => by.prefill.some((r) => r.prompt === p)))
    for (const arm of ['today', 'prefill'] as Arm[]) {
      const rs = by[arm]
      const valid = rs.filter((r) => r.valid)
      out.push(
        `| ${name} | ${arm} | ${rs.length} | ${valid.length}/${rs.length} (${Math.round((100 * valid.length) / Math.max(1, rs.length))}%) | ${rs.filter((r) => r.schemaOk).length}/${rs.length} | ` +
          `${sec(median(rs.map((r) => r.wallMs)))} | ${sec(pct(rs.map((r) => r.wallMs), 0.9))} | ${sec(median(valid.map((r) => r.wallMs)))} | ` +
          `${num(median(rs.map((r) => r.completionTokens).filter((t): t is number => t !== null)))} | ${rs.filter((r) => r.thought).length}/${rs.length} | ` +
          `${rs.filter((r) => !r.valid).length}/${rs.length} | ${rs.filter((r) => r.errorKind === 'timeout').length} | ${rs.filter((r) => r.errorKind === 'reasoning-only').length} | ${rs.filter((r) => r.errorKind === 'http' || r.errorKind === 'other').length} |`
      )
    }
    const pairs = [...both].map((p) => ({ t: by.today.find((r) => r.prompt === p)!, f: by.prefill.find((r) => r.prompt === p)! }))
    const diffs = pairs.map((x) => x.f.wallMs - x.t.wallMs)
    const tv = by.today.filter((r) => r.valid).length
    const fv = by.prefill.filter((r) => r.valid).length
    const tm = median(by.today.map((r) => r.wallMs))
    const fm = median(by.prefill.map((r) => r.wallMs))
    const noWorse = by.today.length > 0 && by.prefill.length > 0 && fv / by.prefill.length >= tv / by.today.length
    const faster = tm !== null && fm !== null && fm < tm
    verdicts.push(
      `- **${name}**: ${pairs.length} prompts in both arms; prefill faster on ${diffs.filter((d) => d < 0).length}/${pairs.length}, median paired difference ${sec(median(diffs))} s (negative = prefill faster); ` +
        `valid ${fv}/${by.prefill.length} vs ${tv}/${by.today.length}; median ${sec(fm)} s vs ${sec(tm)} s → ${noWorse && faster ? '**APPLY** (no worse on validity, faster)' : `**LEAVE** (${noWorse ? '' : 'worse on validity'}${!noWorse && !faster ? ', ' : ''}${faster ? '' : 'not faster'})`}`
    )
  }
  return `${out.join('\n')}\n\n${verdicts.join('\n')}\n`
}

// ---- main -----------------------------------------------------------------------

const args = process.argv.slice(2)
const flag = (name: string, d?: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : d
}
const modelArg = flag('--model', 'qwen3.8-9b-distill')!
const outFile = flag('--out', join(REPO_ROOT, '.probe-planners', 'results.jsonl'))!
const tagArg = flag('--tag', '')!
/** `--prompts 2,3,5` and `--arms prefill`: a detail pass asks only what it is looking at. */
const promptsArg = flag('--prompts')?.split(',').map(Number)
const armsArg = (flag('--arms') ?? 'today,prefill').split(',') as Arm[]

async function main(): Promise<void> {
  if (args.includes('--summary')) {
    console.log(summarize(readRows(outFile).filter((r) => (r.tag ?? '') === tagArg)))
    return
  }
  const host = new URL(BASE_URL).hostname
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) throw new Error(`refusing ${BASE_URL}: the probe talks only to a model server on this machine`)
  for (const r of OUTLINE_REQUESTS) if (outlineMod.outlineFromRequest(r)) throw new Error(`outline prompt names its sections, so the model is never asked: ${r}`)
  const which = (flag('--planner', 'all') ?? 'all') as PlannerName | 'all'
  if (which !== 'all' && !PLANNERS.includes(which)) throw new Error(`unknown planner ${which}`)
  const todo = which === 'all' ? PLANNERS : [which]
  const limit = Number(flag('--limit', '0')) || Infinity

  if (args.includes('--dry')) {
    dry = true
    for (const name of todo) {
      for (const arm of ['today', 'prefill'] as Arm[]) {
        captures = []
        await planners[name].run(0, arm)
        const body = JSON.parse(captures[0]!.content) as Record<string, unknown>
        console.log(`\n## ${name} · ${arm} · what goes on the wire (${captures.length} request${captures.length === 1 ? '' : 's'})\n${JSON.stringify(body, null, 1)}`)
      }
    }
    return
  }

  const budgetS = Number(flag('--budget-s', '420'))
  const timer = setTimeout(() => chunkAbort.abort(), budgetS * 1000)
  timer.unref()
  mkdirSync(dirname(outFile), { recursive: true })
  const done = new Set(readRows(outFile).filter((r) => (r.tag ?? '') === tagArg).map((r) => `${r.planner}/${r.prompt}/${r.arm}`))
  console.log(`planner probe · ${modelArg} · ${BASE_URL} · ${todo.join(', ')} · budget ${budgetS}s · ${done.size} calls already recorded in ${outFile}`)

  // Warm-up, not recorded: the model answers one small request before anything is timed.
  const warm = await fetch(`${BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelArg, messages: [{ role: 'user', content: 'Reply with the word ready.' }, { role: 'assistant', content: '<think>\n\n</think>\n\n' }], max_tokens: 8, temperature: 0 }),
    signal: chunkAbort.signal
  })
  if (!warm.ok) throw new Error(`warm-up failed: HTTP ${warm.status} ${(await warm.text()).slice(0, 200)}`)
  await warm.text()

  let finished = true
  outer: for (const name of todo) {
    const count = Math.min(planners[name].count, limit)
    for (let p = 0; p < count; p++) {
      if (promptsArg && !promptsArg.includes(p)) continue
      // ABBA across prompts: even prompts ask today first, odd prompts the prefill first.
      const order: Arm[] = p % 2 === 0 ? ['today', 'prefill'] : ['prefill', 'today']
      for (const arm of order.filter((a) => armsArg.includes(a))) {
        if (done.has(`${name}/${p}/${arm}`)) continue
        if (chunkAbort.signal.aborted) {
          finished = false
          break outer
        }
        const row = await oneCall(name, p, arm)
        if (!row) {
          console.log(`  ${name} #${p} ${arm}: dropped at the chunk limit (re-asked next chunk)`)
          finished = false
          break outer
        }
        appendFileSync(outFile, `${JSON.stringify(row)}\n`)
        done.add(`${name}/${p}/${arm}`)
        console.log(
          `  ${name.padEnd(11)} #${String(p).padStart(2)} ${arm.padEnd(7)} ${row.valid ? 'valid  ' : 'INVALID'} ${String(row.n).padStart(2)} · ${(row.wallMs / 1000).toFixed(1).padStart(5)} s · ` +
            `${String(row.completionTokens ?? '—').padStart(5)} tok · ${row.thought ? 'thought ' : 'no-think'}${row.errorKind !== 'none' ? ` · ${row.errorKind}` : ''}`
        )
      }
    }
  }
  clearTimeout(timer)
  console.log(finished ? 'chunk complete: every requested call is recorded' : 'chunk stopped at its limit: run again to resume')
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exitCode = 1
})
