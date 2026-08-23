/**
 * Answer-quality evals (STRATEGY-depth-and-reasoning.md, "Measuring it").
 *
 * Three suites, all against a locally loaded model:
 *
 *   library       28 offline reference questions. The app's own app-initiated
 *                 lookup runs against the packs in packs/, the passages ride
 *                 the turn exactly as the app builds it, and the reply is
 *                 scored mechanically: did it answer, did it cite, and did it
 *                 state a measurement the passages do not contain?
 *   quant         20 arithmetic and CSV questions with independently computed
 *                 answers, run twice: bare (no tools) and with the Workbench
 *                 really executing. The delta is the headline number.
 *   deliberate    the bare arm's draft put through one think-harder pass
 *                 (draft → review → revise), reported as a delta and a cost.
 *
 * Runs under Electron proper, not plain Node: the Workbench needs a real
 * sandboxed window and the library needs the app's own retrieval. Scoring
 * lives in src/renderer/src/lib/answerEval.ts so a future in-app shell scores
 * identically. Gated behind LMSTUDIO_EVAL=1 so CI stays offline.
 *
 *   LMSTUDIO_EVAL=1 npm run eval:answers -- <model-id>
 *   EVAL_SUITES=quant,deliberate   pick suites (default: library,quant,deliberate;
 *                                  'multiturn' — v1.8 sessions vs stateless — and
 *                                  'ledger' — v1.9 recall of established facts — and\n *                                  'projects' — v1.11 recall across a project's chats — are opt-in)
 *   EVAL_CASES=1-5                 1-based inclusive slice, per suite
 *   LMSTUDIO_BASE_URL=…            default http://127.0.0.1:1234/v1
 *
 * Caveats, printed with every report: temperature is pinned to 0; the
 * library suite installs packs/ into a throwaway library; with one model
 * loaded the think-harder pass is a self-review, which is the weaker arm of
 * that feature and is labelled as such.
 */
import { app } from 'electron'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Isolate every store the app modules touch before any of them load.
const SCRATCH = mkdtempSync(join(tmpdir(), 'sigma-eval-'))
app.setPath('userData', join(SCRATCH, 'userData'))
mkdirSync(join(SCRATCH, 'userData'), { recursive: true })

const REPO_ROOT = join(__dirname, '..', '..')

// The Workbench resolves its runtime from app.getAppPath(), which under
// .eval-build/scripts points at the wrong place. Measured the hard way: a
// whole 20-case run scored the model against a sandbox that failed in 0 ms,
// which is worse than no measurement because it looks like one.
process.env.SIGMA_PYODIDE_DIR = process.env.SIGMA_PYODIDE_DIR || join(REPO_ROOT, 'resources', 'pyodide')
process.env.SIGMA_WORKBENCH_PRELOAD =
  process.env.SIGMA_WORKBENCH_PRELOAD || join(__dirname, '..', 'src', 'preload', 'workbench.js')
const RESULTS_DIR = join(REPO_ROOT, '.eval-results')
const QUANT_DIR = join(REPO_ROOT, 'test', 'fixtures', 'quant')
const LIBRARY_DIR = join(REPO_ROOT, 'test', 'fixtures', 'library')
const PACKS_DIR = join(REPO_ROOT, 'packs')

type Msg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: unknown; tool_call_id?: string }

const BASE_URL = process.env.LMSTUDIO_BASE_URL ?? 'http://127.0.0.1:1234/v1'
const PERSONA = 'You are a helpful local assistant.'

interface QuantFixture {
  file: string
  prompt: string
  data?: string
  expect: { label: string; value: number; tolerance?: number }[]
  mustInclude?: string[]
}
interface LibraryFixture {
  file: string
  prompt: string
  pack?: string
  mustInclude: string[]
  mustNotAssert?: string[]
}

function slice<T>(items: T[]): T[] {
  const m = /^(\d+)-(\d+)$/.exec(process.env.EVAL_CASES ?? '')
  return m ? items.slice(Number(m[1]) - 1, Number(m[2])) : items
}

function loadJson<T>(dir: string): (T & { file: string })[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({ ...(JSON.parse(readFileSync(join(dir, file), 'utf-8')) as T), file }))
}

// ---- transport ---------------------------------------------------------------------

/**
 * One completion, with a single retry on a *transport* failure only.
 *
 * Measured: three of eight cases in one run died on `fetch failed` when the
 * server dropped a long generation mid-stream, and an excluded case is data
 * lost. An HTTP status is never retried — that is the server answering, and
 * re-asking would hide it.
 */
async function complete(
  model: string,
  messages: Msg[],
  tools?: unknown[]
): Promise<{ content: string; toolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }> {
  try {
    return await completeOnce(model, messages, tools)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/^HTTP \d/.test(message)) throw err
    // Nor is "it never reached an answer" transient: asking again at
    // temperature 0 spends the same minutes to fail the same way.
    if (/produced no answer/.test(message)) throw err
    process.stdout.write(`    (retrying after transport failure: ${message.slice(0, 60)})\n`)
    await new Promise((r) => setTimeout(r, 3000))
    return completeOnce(model, messages, tools)
  }
}

async function completeOnce(
  model: string,
  messages: Msg[],
  tools?: unknown[]
): Promise<{ content: string; toolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }> {
  const res = await fetch(`${BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(420_000),
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      temperature: 0,
      // v1.9.1: a cap, because uncapped generation on a small reasoning model
      // does not always terminate. Measured on gemma-4-12b-qat: the hardest
      // reasoning cases spent 1497 of 1500 tokens on reasoning and emitted an
      // EMPTY answer; uncapped, the connection eventually dropped and the
      // suite recorded four opaque "fetch failed" transport errors.
      //
      // 2000, not 4000: the binding limit is the TRANSPORT, not the context.
      // These requests are non-streaming, so no bytes flow until generation
      // ends, and undici's ~300 s body timeout fires first — measured, a 4000
      // cap still failed as "fetch failed" on a ~12 tok/s model, which is the
      // very symptom this cap exists to remove. 2000 finishes inside that
      // window on a slow local model, and every real answer in every suite is
      // far shorter (the longest reasoning draft measured was 179 characters).
      max_tokens: 2000,
      ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {})
    })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
  const json = (await res.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] } }[]
  }
  const { parseCompletionMessage } = require('../src/renderer/src/lib/evalRunner') as typeof import('../src/renderer/src/lib/evalRunner')
  const choice = json.choices?.[0] as { finish_reason?: string; message?: Record<string, unknown> } | undefined
  const parsed = parseCompletionMessage(json.choices?.[0]?.message ?? {})
  // A reply that is only thinking is not a transport problem and must not be
  // reported as one: say the model never reached an answer, and with what.
  // v1.9.2: only terminal when nothing downstream can rescue it. With tools in
  // play the agent loop owns this case — it retries the round with a closed
  // thinking block, which is measured to recover the answer — so throwing here
  // would report a failure the app does not actually have.
  if (!parsed.content.trim() && parsed.toolCalls.length === 0 && !(tools && tools.length > 0)) {
    const usage = (json as { usage?: { completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } }).usage
    const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? 0
    if (reasoning > 0 || choice?.finish_reason === 'length') {
      // Two different failures, and v1.9.1 reported both as the first one.
      // `length` is a budget that ran out mid-thought. `stop` is the model
      // deciding it was finished — it wrote a thinking block, wrote no answer
      // and no tool call, and ended the turn. Measured 2026-08-18: 13 of 20
      // Workbench cases failed this way, every one of them on the round after
      // a tool had returned the right numbers. Saying "did not finish
      // thinking" of a model that stopped on purpose sends the reader after
      // the wrong cause, which is the whole thing this diagnosis exists to
      // prevent.
      const spent = `${reasoning} of ${usage?.completion_tokens ?? 0} completion tokens went to reasoning`
      throw new Error(
        choice?.finish_reason === 'length'
          ? `the model produced no answer: ${spent} (finish_reason: length). It did not finish thinking within its budget.`
          : `the model produced no answer: ${spent}, then stopped (finish_reason: ` +
            `${choice?.finish_reason ?? 'unknown'}). It ended the turn after its thinking block ` +
            'without writing an answer or calling another tool.'
      )
    }
  }
  return { content: parsed.content, toolCalls: parsed.toolCalls }
}

// ---- suites ---------------------------------------------------------------------------

async function runLibrarySuite(model: string): Promise<import('../src/renderer/src/lib/answerEval').LibraryCaseResult[]> {
  const lib = require('../src/main/ipc/library') as typeof import('../src/main/ipc/library')
  const { scoreLibrary } = require('../src/renderer/src/lib/answerEval') as typeof import('../src/renderer/src/lib/answerEval')
  const { buildLibraryContext } = require('../src/renderer/src/lib/libraryRecall') as typeof import('../src/renderer/src/lib/libraryRecall')
  const { withGrounding, buildTurnContext } = require('../src/renderer/src/lib/grounding') as typeof import('../src/renderer/src/lib/grounding')
  const { selectPlaybook, buildPlaybookContext } = require('../src/renderer/src/lib/playbooks') as typeof import('../src/renderer/src/lib/playbooks')

  // A persistent library so the (slow) embedding pass is paid once across
  // runs — index.json is keyed to the embedding model, so a model change
  // rebuilds it by itself.
  const libDir = join(REPO_ROOT, '.eval-library')
  lib.setLibraryDirForTests(libDir)
  const packs = existsSync(PACKS_DIR)
    ? readdirSync(PACKS_DIR).filter((d) => d !== 'sources' && existsSync(join(PACKS_DIR, d, 'manifest.json')))
    : []
  if (packs.length === 0) throw new Error(`no built packs in ${PACKS_DIR} — run bash scripts/build-packs.sh`)
  const installed = await lib.listPacks()
  for (const p of packs) {
    if (!installed.some((x) => x.id === p)) await lib.installPackFromDirectory(join(PACKS_DIR, p), { replace: true })
  }
  process.stdout.write(`  ${packs.length} pack(s) installed: ${packs.join(', ')}\n`)

  // EVAL_EMBED=0 measures the app as it is the moment a pack is installed
  // (keyword-only). The default embeds, which is the state the Library tab
  // pushes users to and the one the app is designed around — and the two
  // differ sharply on paraphrase, which is worth measuring on purpose.
  if (process.env.EVAL_EMBED !== '0') {
    for (const p of packs) {
      const before = (await lib.listPacks()).find((x) => x.id === p)
      if (before && before.embeddedChunks === before.chunks && before.chunks > 0) continue
      process.stdout.write(`  embedding ${p}…`)
      const r = await lib.embedPack(p)
      process.stdout.write(r.ok ? ` ${r.embedded}/${r.total}\n` : ` FAILED: ${r.error}\n`)
    }
  } else {
    process.stdout.write('  EVAL_EMBED=0 — keyword-only retrieval\n')
  }

  const fixtures = slice(loadJson<LibraryFixture>(LIBRARY_DIR))
  const results: import('../src/renderer/src/lib/answerEval').LibraryCaseResult[] = []
  for (const [i, fx] of fixtures.entries()) {
    const started = Date.now()
    const out: import('../src/renderer/src/lib/answerEval').LibraryCaseResult = {
      file: fx.file,
      prompt: fx.prompt,
      pack: fx.pack,
      passagesFound: 0,
      ms: 0
    }
    try {
      // Exactly the app's app-initiated path: whole-library lookup, formatted
      // for the model, appended to the turn with the domain's playbook.
      const lookup = await lib.lookupLibrary({ query: fx.prompt, topK: 5 })
      out.passagesFound = lookup.passages.length
      out.retrieved = lookup.passages.map((p) => `${p.packName} › ${p.docTitle}${p.section ? ` › ${p.section}` : ''}`)
      out.mode = lookup.mode
      const blocks: string[] = []
      if (lookup.passages.length > 0) blocks.push(buildLibraryContext(lib.formatLookup(lookup, fx.prompt), false))
      const playbook = selectPlaybook({ text: fx.prompt })
      if (playbook) blocks.push(buildPlaybookContext(playbook))
      const turnContext = buildTurnContext(blocks)
      const reply = await complete(model, [
        { role: 'system', content: withGrounding(PERSONA) },
        { role: 'user', content: `${fx.prompt}${turnContext ?? ''}` }
      ])
      out.reply = reply.content.slice(0, 2000)
      out.score = scoreLibrary(reply.content, {
        mustInclude: fx.mustInclude,
        mustNotAssert: fx.mustNotAssert,
        passages: lookup.passages.map((p) => p.text).join('\n'),
        titles: [...new Set(lookup.passages.flatMap((p) => [p.docTitle, p.packName]))]
      })
    } catch (err) {
      out.error = err instanceof Error ? err.message : String(err)
    }
    out.ms = Date.now() - started
    results.push(out)
    const s = out.score
    process.stdout.write(
      `  ${out.error ? '!' : s?.answered ? '✓' : '✗'} ${fx.file}` +
        (s ? `  ${s.cited ? 'cited' : 'no citation'}${s.unsupported.length ? ` · unsupported: ${s.unsupported.join(', ')}` : ''}${s.missing.length ? ` · missing: ${s.missing.join(' | ')}` : ''}${s.forbidden.length ? ` · forbidden: ${s.forbidden.join(' | ')}` : ''}` : '') +
        (out.error ? `  ${out.error}` : '') +
        `  [${i + 1}/${fixtures.length}]\n`
    )
  }
  return results
}

/** Real Workbench execution for the agent loop — no stubs; that is the point. */
function workbenchExecutor(dataDir: string) {
  const { workbenchHandlers } = require('../src/main/ipc/toolHandlers/workbench') as typeof import('../src/main/ipc/toolHandlers/workbench')
  return async (
    name: string,
    args: Record<string, unknown>,
    attachments: { name: string; sourcePath: string }[],
    conversationId?: string
  ) => {
    const handler = (workbenchHandlers as Record<string, ((a: Record<string, unknown>, c: unknown) => Promise<{ ok: boolean; output?: string; error?: string }>) | undefined>)[name]
    if (!handler) return { ok: false, error: `Unknown tool "${name}"` }
    void dataDir
    return handler(args, { sender: {} as never, modelId: '', attachments, conversationId })
  }
}

interface MultiTurnFixture {
  file: string
  data: string
  turns: { prompt: string; expect: { label: string; value: number; tolerance?: number }[]; mustInclude?: string[] }[]
}

/**
 * v1.8: multi-turn analysis, sessions vs. stateless. One conversation per
 * case: turn 1 loads/aggregates, turns 2+ drill into the same data. Both arms
 * run the identical fixture through the identical agent loop; the only
 * differences are the session key on run_python and the tool description
 * (the stateless arm gets v1.7's "Fresh globals each run" wording, so each
 * arm's model is told the truth about the sandbox it is talking to).
 */
async function runMultiTurnSuite(model: string): Promise<import('../src/renderer/src/lib/answerEval').MultiTurnCaseResult[]> {
  const { scoreQuantitative, codeReadsData } = require('../src/renderer/src/lib/answerEval') as typeof import('../src/renderer/src/lib/answerEval')
  const { runAgentLoop } = require('../src/renderer/src/lib/agentLoop') as typeof import('../src/renderer/src/lib/agentLoop')
  const { withGrounding, buildTurnContext } = require('../src/renderer/src/lib/grounding') as typeof import('../src/renderer/src/lib/grounding')
  const { selectPlaybook, buildPlaybookContext } = require('../src/renderer/src/lib/playbooks') as typeof import('../src/renderer/src/lib/playbooks')
  const { buildLedger, buildLedgerContext, shouldInjectLedger } = require('../src/renderer/src/lib/ledger') as typeof import('../src/renderer/src/lib/ledger')
  const { TOOL_SCHEMAS } = require('../src/main/ipc/toolSchemas') as typeof import('../src/main/ipc/toolSchemas')

  const MULTITURN_DIR = join(REPO_ROOT, 'test', 'fixtures', 'multiturn')
  const sessionTools = TOOL_SCHEMAS.filter((t) => t.function.name === 'run_python' || t.function.name === 'analyze_file')
  // The stateless arm's schema tells the truth about its sandbox.
  const statelessTools = sessionTools.map((t) =>
    t.function.name === 'run_python'
      ? {
          ...t,
          function: {
            ...t.function,
            description: t.function.description.replace(
              /Variables PERSIST[\s\S]*?re-run your setup\. /,
              'Fresh globals each run. '
            )
          }
        }
      : t
  )
  const exec = workbenchExecutor(join(MULTITURN_DIR, 'data'))
  const fixtures = slice(loadJson<MultiTurnFixture>(MULTITURN_DIR))
  const results: import('../src/renderer/src/lib/answerEval').MultiTurnCaseResult[] = []

  for (const [i, fx] of fixtures.entries()) {
    const attachments = [{ name: fx.data, sourcePath: join(MULTITURN_DIR, 'data', fx.data) }]
    const caseOut: import('../src/renderer/src/lib/answerEval').MultiTurnCaseResult = { file: fx.file, session: [], stateless: [] }

    for (const arm of ['session', 'stateless'] as const) {
      const sessionKey = arm === 'session' ? `mt-${fx.file}-${process.pid}-${jobNonce++}` : undefined
      const tools = arm === 'session' ? sessionTools : statelessTools
      const messages: Msg[] = [{ role: 'system', content: withGrounding(PERSONA) }]
      // v1.8.1: the app-shaped history the ledger reads. The ledger rides the
      // session arm exactly as in the app (from turn 2 once session variables
      // exist); the stateless arm has no session, so it never gets one — which
      // is the app's own behavior for a sandbox with fresh globals.
      const appHistory: import('../src/renderer/src/types').ChatMessage[] = []

      for (const [ti, turn] of fx.turns.entries()) {
        const dataNote = ti === 0 ? `\n\n[Attached file: ${fx.data} — available to run_python and analyze_file at /work/${fx.data}]` : ''
        appHistory.push({
          id: `u${ti}`,
          role: 'user',
          content: turn.prompt,
          attachments: ti === 0 ? ([{ id: 'a0', kind: 'file', name: fx.data, sourcePath: attachments[0].sourcePath }] as never) : undefined,
          createdAt: 0
        } as import('../src/renderer/src/types').ChatMessage)
        // The app selects a playbook per turn from the text and the attached
        // file names — a tabular attachment is data work — and appends it as
        // turn context. Same here, so the suite measures the app's real turn
        // (v1.8.1; the first measurement omitted it and so measured a bare
        // persona rather than the app).
        const playbook = selectPlaybook({ text: turn.prompt, attachmentNames: [fx.data] })
        // The stateless arm must not be told variables persist (they do not
        // there): drop the session step so neither arm is lied to.
        const armPlaybook =
          playbook && arm === 'stateless'
            ? { ...playbook, steps: playbook.steps.filter((s) => !/keeps its variables/.test(s)) }
            : playbook
        const blocks: string[] = armPlaybook ? [buildPlaybookContext(armPlaybook)] : []
        if (arm === 'session') {
          const ledger = buildLedger(appHistory)
          if (shouldInjectLedger(ledger)) blocks.push(buildLedgerContext(ledger))
        }
        const turnContext = buildTurnContext(blocks)
        messages.push({ role: 'user', content: `${turn.prompt}${dataNote}${turnContext ?? ''}` })
        const t0 = Date.now()
        let toolCalls = 0
        let reread = false
        const rounds: string[] = []
        const records: import('../src/renderer/src/types').ToolCallRecord[] = []
        try {
          await runAgentLoop({
            messages: messages as never,
            tools,
            records,
            signal: new AbortController().signal,
            deps: {
              streamRound: async (msgs, tls) => {
                const r = await complete(model, msgs as never, tls)
                if (r.content.trim()) rounds.push(r.content)
                return { content: r.content, toolCalls: r.toolCalls }
              },
              executeTool: async (name, args) => {
                toolCalls += 1
                if (name === 'run_python' && typeof args.code === 'string' && codeReadsData(args.code)) reread = true
                return exec(name, args, attachments, sessionKey)
              }
            }
          })
          const reply = rounds.join('\n\n')
          messages.push({ role: 'assistant', content: reply })
          appHistory.push({ id: `a${ti}`, role: 'assistant', content: reply, toolCalls: records, createdAt: 0 } as import('../src/renderer/src/types').ChatMessage)
          const q = scoreQuantitative(reply, turn.expect)
          const missing = [...q.missing]
          for (const p of turn.mustInclude ?? []) if (!new RegExp(p, 'i').test(reply)) missing.push(p)
          caseOut[arm].push({
            prompt: turn.prompt,
            hit: missing.length === 0,
            missing,
            ms: Date.now() - t0,
            toolCalls,
            reread,
            toolResults: records.map((rc) => ({ name: rc.name, code: typeof rc.args.code === 'string' ? rc.args.code.slice(0, 500) : undefined, result: (rc.result ?? '').slice(0, 400) })),
            reply: reply.slice(0, 1200)
          })
        } catch (err) {
          messages.push({ role: 'assistant', content: '(error)' })
          appHistory.push({ id: `a${ti}`, role: 'assistant', content: '(error)', toolCalls: records, createdAt: 0 } as import('../src/renderer/src/types').ChatMessage)
          caseOut[arm].push({
            prompt: turn.prompt,
            hit: false,
            missing: [],
            ms: Date.now() - t0,
            toolCalls,
            reread,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }
      const armTurns = caseOut[arm]
      process.stdout.write(
        `  ${armTurns.every((t) => t.hit) ? '✓' : '✗'} ${fx.file} [${arm}]  ${armTurns.map((t) => (t.hit ? '✓' : t.error ? '!' : '✗')).join('')}` +
          `  rereads:${armTurns.filter((t, n) => n > 0 && t.reread).length}/${armTurns.length - 1}  [${i + 1}/${fixtures.length}]\n`
      )
    }
    results.push(caseOut)
  }
  return results
}

let jobNonce = 0

interface ReasoningFixture {
  file: string
  kind: string
  prompt: string
  /** The exact ANSWER line a correct reply ends with — every pattern must match it. */
  canonical: string
  answer: string[]
  distractors?: string[]
}

/**
 * v1.9.1: think-harder measured where it is actually for.
 *
 * The v1.6 quantitative suite found it a null result at 2.6x the latency and
 * said outright that "the cases it might help (reasoning, not arithmetic) are
 * not what this suite measures". Nothing measured it since, and it has shipped
 * that whole time. These are multi-step problems with one checkable answer and
 * no tools: a comparison chain, state tracking, a rule with an exception,
 * deduction from negatives, set overlap, elimination, constraint satisfaction,
 * ordering. Both arms share one draft, so the delta is exactly what the review
 * pass adds — and the two counts that matter are directed: how often it FIXED
 * a wrong draft, and how often it BROKE a right one.
 */
async function runReasoningSuite(model: string): Promise<import('../src/renderer/src/lib/answerEval').ReasoningCaseResult[]> {
  const { assertedPatterns } = require('../src/renderer/src/lib/answerEval') as typeof import('../src/renderer/src/lib/answerEval')
  const { withGrounding } = require('../src/renderer/src/lib/grounding') as typeof import('../src/renderer/src/lib/grounding')
  const del = require('../src/renderer/src/lib/deliberation') as typeof import('../src/renderer/src/lib/deliberation')

  const fixtures = slice(loadJson<ReasoningFixture>(join(REPO_ROOT, 'test', 'fixtures', 'reasoning')))
  const results: import('../src/renderer/src/lib/answerEval').ReasoningCaseResult[] = []
  const slot: import('../src/renderer/src/types').ModelConfig = {
    id: 'a',
    modelId: model,
    roleName: 'Assistant',
    systemPrompt: PERSONA,
    color: 'blue' as import('../src/renderer/src/types').ModelConfig['color'],
    enabled: true,
    sampling: { temperature: 0, topP: 1, maxTokens: -1, seed: null, topK: -1, minP: -1 },
    contextWindow: null
  }

  for (const [i, fx] of fixtures.entries()) {
    const score = (reply: string, ms: number): import('../src/renderer/src/lib/answerEval').ReasoningTurnResult => {
      const missing = fx.answer.filter((p) => !new RegExp(p, 'i').test(reply))
      const asserted = assertedPatterns(reply, fx.distractors ?? [])
      return {
        correct: missing.length === 0 && asserted.length === 0,
        missing,
        asserted,
        empty: reply.trim().length === 0,
        ms,
        reply: reply.slice(0, 900)
      }
    }
    try {
      const t0 = Date.now()
      const draftR = await complete(model, [
        { role: 'system', content: withGrounding(PERSONA) },
        { role: 'user', content: fx.prompt }
      ])
      const draft = score(draftR.content, Date.now() - t0)

      // The app's own path: review, and revise only if the review found
      // something. A self-review, because one model is loaded — the weaker arm
      // of the feature, and labelled as such in the report.
      const t1 = Date.now()
      const review = await complete(model, del.buildReviewMessages(slot, fx.prompt, draftR.content, 'Assistant', true) as never)
      const found = del.reviewFoundProblems(review.content)
      let finalText = draftR.content
      let revised = false
      if (found) {
        const rev = await complete(model, del.buildRevisionMessages(slot, fx.prompt, draftR.content, review.content) as never)
        if (rev.content.trim()) {
          finalText = rev.content
          revised = true
        }
      }
      const final = score(finalText, Date.now() - t1)
      results.push({ file: fx.file, kind: fx.kind, draft, final, reviewFoundProblems: found, revised, reviewMs: Date.now() - t1 })
      const arrow = draft.correct === final.correct ? '=' : draft.correct ? '✗ BROKE' : '✓ FIXED'
      process.stdout.write(
        `  ${fx.file.padEnd(30)} draft ${draft.correct ? '✓' : '✗'} → final ${final.correct ? '✓' : '✗'}  ${arrow}` +
          `  review:${found ? 'found' : 'clean'}${revised ? '/revised' : ''}  ${(draft.ms / 1000).toFixed(0)}s+${(Date.now() - t1) / 1000 | 0}s` +
          `${draft.empty || final.empty ? '  [EMPTY REPLY]' : ''}  [${i + 1}/${fixtures.length}]\n`
      )
    } catch (err) {
      const zero = { correct: false, missing: [], asserted: [], empty: true, ms: 0 }
      results.push({ file: fx.file, kind: fx.kind, draft: zero, final: zero, reviewFoundProblems: false, revised: false, reviewMs: 0, error: err instanceof Error ? err.message : String(err) })
      process.stdout.write(`  ${fx.file.padEnd(30)} ! ${err instanceof Error ? err.message.slice(0, 70) : ''}  [${i + 1}/${fixtures.length}]\n`)
    }
  }
  return results
}

interface ResearchFixture {
  file: string
  question: string
  /**
   * Which corpus serves this case. 'clean' (default) is six pages of
   * unambiguous facts; 'thin' is the regime the rung exists for — a question
   * the pages only partly answer, and two sources that disagree on a figure,
   * where a model reconciling helpfully invents the average.
   */
  corpus?: 'clean' | 'thin'
  /** Facts the brief must state (regex, any alternative). */
  mustInclude: string[]
  /** Figures NOT in the corpus that a model tempted to fill gaps might state (regex). */
  decoys?: string[]
}

/**
 * v1.9: deep research under the ladder, measured — against a fixture corpus,
 * not the live web. A loopback HTTP server serves (a) a SearXNG-shaped
 * /search endpoint answered by keyword match over the corpus and (b) the
 * corpus pages themselves; the eval points the app's search provider at it
 * and names its origin in SIGMA_RESEARCH_FIXTURE_ORIGIN, the one explicit
 * seam the fetch guards recognize. Everything else is the real pipeline: plan
 * → search → select → read → synthesize → GROUND → the tool result the outer
 * model would receive. Two arms: the check on (production) and off — same
 * corpus, same model, same budget — scored on facts stated, decoys stated,
 * fabricated citations, and what the grounding rung caught.
 */
async function runResearchSuite(model: string): Promise<import('../src/renderer/src/lib/answerEval').ResearchCaseResult[]> {
  const http = require('http') as typeof import('http')
  const RESEARCH_DIR = join(REPO_ROOT, 'test', 'fixtures', 'research')
  const loadCorpus = (dir: string, corpus: 'clean' | 'thin'): { file: string; corpus: 'clean' | 'thin'; title: string; html: string; text: string }[] =>
    readdirSync(join(RESEARCH_DIR, dir))
      .filter((f) => f.endsWith('.html'))
      .map((f) => {
        const html = readFileSync(join(RESEARCH_DIR, dir, f), 'utf-8')
        const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? f
        const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase()
        return { file: f, corpus, title, html, text }
      })
  const pages = [...loadCorpus('corpus', 'clean'), ...loadCorpus('corpus-thin', 'thin')]
  // Set per case: search only ever offers the case's own corpus, so a thin-regime
  // question cannot be rescued by a clean page that happens to share a word.
  let activeCorpus: 'clean' | 'thin' = 'clean'

  // Keyword-match search: score = distinct query terms present in the page.
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (u.pathname === '/search') {
      const q = (u.searchParams.get('q') ?? '').toLowerCase()
      const terms = q.split(/[^a-z0-9%.]+/).filter((t) => t.length >= 3)
      const scored = pages
        .filter((p) => p.corpus === activeCorpus)
        .map((p) => ({ p, score: terms.filter((t) => p.text.includes(t)).length }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 6)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ results: scored.map(({ p }) => ({ title: p.title, url: `${origin}/${p.file}`, content: p.text.slice(0, 300) })) }))
      return
    }
    const page = pages.find((p) => `/${p.file}` === u.pathname)
    if (!page) { res.statusCode = 404; res.end('not found'); return }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(page.html)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  const origin = `http://127.0.0.1:${port}`
  process.env.SIGMA_RESEARCH_FIXTURE_ORIGIN = origin

  const storeMod = require('../src/main/ipc/store') as typeof import('../src/main/ipc/store')
  const prev = storeMod.getSettings()
  storeMod.writeSettings({
    ...prev,
    search: { ...prev.search, provider: 'searxng', searxngUrl: origin, confirmBeforeSearch: false },
    research: { ...prev.research, depth: 'thorough', confirmPlan: false }
  })

  const dr = require('../src/main/ipc/deepResearch') as typeof import('../src/main/ipc/deepResearch')
  const rg = require('../src/main/ipc/researchGrounding') as typeof import('../src/main/ipc/researchGrounding')
  const fixtures = slice(loadJson<ResearchFixture>(join(RESEARCH_DIR, 'cases')))
  const results: import('../src/renderer/src/lib/answerEval').ResearchCaseResult[] = []

  try {
    for (const [i, fx] of fixtures.entries()) {
      activeCorpus = fx.corpus ?? 'clean'
      const caseOut: import('../src/renderer/src/lib/answerEval').ResearchCaseResult = { file: fx.file, question: fx.question, regime: activeCorpus, checked: null as never, unchecked: null as never }
      for (const arm of ['checked', 'unchecked'] as const) {
        process.env.SIGMA_RESEARCH_GROUNDING = arm === 'checked' ? '1' : '0'
        const t0 = Date.now()
        try {
          // 'thorough': the wall clock must not be what the suite measures. On
          // this hardware a 9B plans in ~17 s and synthesizes in ~45 s, and the
          // rung's revision is another synthesis-sized call; quick (60 s) and
          // standard (150 s) both produced empty briefs at the wall clock in
          // most arms — measuring the budget, not the rung. Thorough gives 300 s
          // with a 60 s synthesis reserve. Retrieval against the fixture server
          // is instantaneous, so all of it is model time.
          const outcome = await dr.runDeepResearch({ question: fx.question, depth: 'thorough', modelId: model })
          const brief = outcome.brief ?? ''
          const sources = outcome.sources ?? []
          // Independent re-check of whatever brief came out, for the score —
          // the same function, but the arm's own report is what the *app*
          // would have disclosed.
          const audit = rg.checkResearchGrounding(brief, sources)
          const stated = fx.mustInclude.filter((p) => new RegExp(p, 'i').test(brief))
          const decoysStated = (fx.decoys ?? []).filter((p) => new RegExp(p, 'i').test(brief))
          caseOut[arm] = {
            ok: outcome.ok && brief.trim().length > 0,
            error: outcome.ok ? undefined : outcome.error,
            sources: sources.length,
            factsStated: stated.length,
            factsOf: fx.mustInclude.length,
            decoysStated,
            unsupportedFigures: audit.figures.length + audit.measurements.length,
            badCitations: audit.badCitations.length,
            revised: outcome.grounding?.revised ?? false,
            flaggedBefore: outcome.grounding ? outcome.grounding.before.figures.length + outcome.grounding.before.measurements.length + outcome.grounding.before.badCitations.length : 0,
            ms: Date.now() - t0,
            brief: brief.slice(0, 1500),
            note: outcome.grounding?.note
          }
        } catch (err) {
          caseOut[arm] = { ok: false, sources: 0, factsStated: 0, factsOf: fx.mustInclude.length, decoysStated: [], unsupportedFigures: 0, badCitations: 0, revised: false, flaggedBefore: 0, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) }
        }
        const a = caseOut[arm]
        process.stdout.write(
          `  ${a.ok && a.factsStated === a.factsOf && a.decoysStated.length === 0 && a.unsupportedFigures === 0 && a.badCitations === 0 ? '✓' : '✗'} ${fx.file} [${arm}]  ` +
            `facts ${a.factsStated}/${a.factsOf} · decoys ${a.decoysStated.length} · unsupported ${a.unsupportedFigures} · bad cites ${a.badCitations}` +
            (arm === 'checked' ? ` · flagged ${a.flaggedBefore}${a.revised ? ' → revised' : ''}` : '') +
            ` · ${a.sources} src · ${(a.ms / 1000).toFixed(0)}s${a.error ? `  ! ${a.error.slice(0, 60)}` : ''}  [${activeCorpus}] [${i + 1}/${fixtures.length}]\n`
        )
      }
      results.push(caseOut)
    }
  } finally {
    delete process.env.SIGMA_RESEARCH_GROUNDING
    storeMod.writeSettings(prev)
    server.close()
  }
  return results
}

interface LedgerFixture {
  file: string
  data: string
  turns: {
    prompt: string
    expect: { label: string; value: number; tolerance?: number }[]
    mustInclude?: string[]
    /** Off-topic turn whose only job is to push the fact further back. */
    filler?: boolean
    /** The turn that must recall something established earlier without restating it. */
    recall?: boolean
    /**
     * Long regime (v1.9): before sending this turn, apply the app's own history
     * planner with a budget tight enough that the establishing turn is dropped
     * from the wire history — the fact is genuinely gone from what the model
     * can see, exactly as compaction does it in a real long conversation. The
     * runner asserts the drop; a run that failed to reach the regime fails.
     */
    compact?: boolean
  }[]
  /** 'long' cases are reported separately: they are the regime the ledger exists for. */
  regime?: 'short' | 'long'
}

/**
 * v1.9: the conversation ledger, measured. Each case establishes a fact with
 * a tool on turn 1, buries it under off-topic filler, then asks for it back
 * (or for arithmetic on it) without restating it. Two arms, identical in
 * every way — same sessions, same playbook, same tools — except that one
 * receives the ledger as turn context from the fourth turn on. Only the
 * `recall` turns are scored; the establishing turn is reported so a case
 * whose fact was never computed is not mistaken for a recall failure.
 */
async function runLedgerSuite(model: string): Promise<import('../src/renderer/src/lib/answerEval').LedgerCaseResult[]> {
  const { scoreQuantitative } = require('../src/renderer/src/lib/answerEval') as typeof import('../src/renderer/src/lib/answerEval')
  const { runAgentLoop } = require('../src/renderer/src/lib/agentLoop') as typeof import('../src/renderer/src/lib/agentLoop')
  const { withGrounding, buildTurnContext } = require('../src/renderer/src/lib/grounding') as typeof import('../src/renderer/src/lib/grounding')
  const { selectPlaybook, buildPlaybookContext } = require('../src/renderer/src/lib/playbooks') as typeof import('../src/renderer/src/lib/playbooks')
  const { buildLedger, buildLedgerContext, shouldInjectLedger } = require('../src/renderer/src/lib/ledger') as typeof import('../src/renderer/src/lib/ledger')
  const { TOOL_SCHEMAS } = require('../src/main/ipc/toolSchemas') as typeof import('../src/main/ipc/toolSchemas')

  const LEDGER_DIR = join(REPO_ROOT, 'test', 'fixtures', 'ledger')
  const tools = TOOL_SCHEMAS.filter((t) => t.function.name === 'run_python' || t.function.name === 'analyze_file')
  const exec = workbenchExecutor(join(LEDGER_DIR, 'data'))
  const fixtures = slice(loadJson<LedgerFixture>(LEDGER_DIR))
  const results: import('../src/renderer/src/lib/answerEval').LedgerCaseResult[] = []

  for (const [i, fx] of fixtures.entries()) {
    const attachments = [{ name: fx.data, sourcePath: join(LEDGER_DIR, 'data', fx.data) }]
    const caseOut: import('../src/renderer/src/lib/answerEval').LedgerCaseResult = { file: fx.file, regime: fx.regime ?? 'short', ledger: [], bare: [] }

    for (const arm of ['ledger', 'bare'] as const) {
      const sessionKey = `lg-${fx.file}-${arm}-${process.pid}-${jobNonce++}`
      const messages: Msg[] = [{ role: 'system', content: withGrounding(PERSONA) }]
      // The app-shaped history the ledger is built from: user turns with the
      // attachment on turn 1, assistant turns carrying their tool records.
      const appHistory: import('../src/renderer/src/types').ChatMessage[] = []

      for (const [ti, turn] of fx.turns.entries()) {
        const dataNote = ti === 0 ? `\n\n[Attached file: ${fx.data} — available to run_python and analyze_file at /work/${fx.data}]` : ''
        const userMsg = {
          id: `u${ti}`,
          role: 'user' as const,
          content: turn.prompt,
          attachments: ti === 0 ? ([{ id: 'a0', kind: 'file', name: fx.data, sourcePath: attachments[0].sourcePath }] as never) : undefined,
          createdAt: 0
        } as import('../src/renderer/src/types').ChatMessage
        appHistory.push(userMsg)

        const blocks: string[] = []
        const playbook = selectPlaybook({ text: turn.prompt, attachmentNames: [fx.data] })
        if (playbook) blocks.push(buildPlaybookContext(playbook))
        let ledgerInjected = false
        let ledgerBlock: string | undefined
        if (arm === 'ledger') {
          const ledger = buildLedger(appHistory)
          if (shouldInjectLedger(ledger)) {
            ledgerBlock = buildLedgerContext(ledger)
            blocks.push(ledgerBlock)
            ledgerInjected = true
          }
        }
        const turnContext = buildTurnContext(blocks)
        messages.push({ role: 'user', content: `${turn.prompt}${dataNote}${turnContext ?? ''}` })

        // Long regime: compact the WIRE history with the app's own planner so
        // the establishing turn is provably gone. The ledger, like the app's,
        // is built from the full conversation (appHistory) — never truncated —
        // which is precisely the property under test. The budget is chosen per
        // turn: everything after the establishing exchange must still fit, so
        // filler is visible and only the fact's turn (and its tool round) is
        // what falls off the front.
        let compacted = false
        if (turn.compact) {
          const { planHistory, estimateMessageTokens } = require('../src/renderer/src/lib/contextBudget') as typeof import('../src/renderer/src/lib/contextBudget')
          const system = messages[0]
          const history = messages.slice(1)
          // Wire history as ChatMessage-shaped for the planner. Tool-role
          // messages and assistant tool_calls rounds are part of the
          // establishing exchange's cost, so every wire message is shaped —
          // the planner sees the same sequence the model would.
          const shaped = history.map((m, k) => ({
            id: `w${k}`,
            role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
            createdAt: 0
          })) as import('../src/renderer/src/types').ChatMessage[]
          // The establishing exchange is everything before the second *real*
          // user turn (wire index of the second fixture prompt).
          let userSeen = 0
          let secondUserIdx = -1
          for (let k = 0; k < history.length; k++) {
            if (history[k].role === 'user') {
              userSeen += 1
              if (userSeen === 2) { secondUserIdx = k; break }
            }
          }
          if (secondUserIdx < 0) throw new Error(`${fx.file}: no second user turn to compact against`)
          const establishing = shaped.slice(0, secondUserIdx)
          const rest = shaped.slice(secondUserIdx)
          // Same estimator the planner uses, so "fits the rest exactly" is exact.
          const restTokens = rest.reduce((n, m) => n + estimateMessageTokens(m), 0)
          const plan = planHistory(shaped, restTokens)
          const droppedEstablishing = establishing.length > 0 && establishing.every((m) => plan.drop.includes(m))
          if (!droppedEstablishing) {
            throw new Error(`${fx.file}: long-regime compaction did not drop the establishing turn (kept ${plan.keep.length}/${shaped.length}, establishing ${establishing.length}); the fixture does not reach the regime it claims`)
          }
          messages.splice(0, messages.length, system, ...history.slice(shaped.length - plan.keep.length))
          compacted = true
        }

        const t0 = Date.now()
        const records: import('../src/renderer/src/types').ToolCallRecord[] = []
        const rounds: string[] = []
        try {
          await runAgentLoop({
            messages: messages as never,
            tools,
            records,
            signal: new AbortController().signal,
            deps: {
              streamRound: async (msgs, tls) => {
                const r = await complete(model, msgs as never, tls)
                if (r.content.trim()) rounds.push(r.content)
                return { content: r.content, toolCalls: r.toolCalls }
              },
              executeTool: async (name, args) => exec(name, args, attachments, sessionKey)
            }
          })
          const reply = rounds.join('\n\n')
          messages.push({ role: 'assistant', content: reply })
          appHistory.push({ id: `a${ti}`, role: 'assistant', content: reply, toolCalls: records, createdAt: 0 } as import('../src/renderer/src/types').ChatMessage)
          const q = scoreQuantitative(reply, turn.expect)
          const missing = [...q.missing]
          for (const p of turn.mustInclude ?? []) if (!new RegExp(p, 'i').test(reply)) missing.push(p)
          caseOut[arm].push({
            prompt: turn.prompt,
            kind: turn.recall ? 'recall' : turn.filler ? 'filler' : 'establish',
            hit: missing.length === 0,
            missing,
            ms: Date.now() - t0,
            ledgerInjected,
            compacted,
            ledgerBlock,
            toolResults: records.map((rc) => ({ name: rc.name, result: (rc.result ?? '').slice(0, 600) })),
            reply: reply.slice(0, 1200)
          })
        } catch (err) {
          messages.push({ role: 'assistant', content: '(error)' })
          appHistory.push({ id: `a${ti}`, role: 'assistant', content: '(error)', toolCalls: records, createdAt: 0 } as import('../src/renderer/src/types').ChatMessage)
          caseOut[arm].push({
            prompt: turn.prompt,
            kind: turn.recall ? 'recall' : turn.filler ? 'filler' : 'establish',
            hit: false,
            missing: [],
            ms: Date.now() - t0,
            ledgerInjected,
            compacted,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }
      const armTurns = caseOut[arm]
      const recalls = armTurns.filter((t) => t.kind === 'recall')
      process.stdout.write(
        `  ${recalls.every((t) => t.hit) ? '✓' : '✗'} ${fx.file} [${arm}]  ` +
          `establish:${armTurns.find((t) => t.kind === 'establish')?.hit ? '✓' : '✗'} ` +
          `recall:${recalls.map((t) => (t.hit ? '✓' : t.error ? '!' : '✗')).join('')}` +
          (arm === 'ledger' ? `  injected on ${armTurns.filter((t) => t.ledgerInjected).length} turn(s)` : '') +
          (armTurns.some((t) => t.compacted) ? '  [compacted]' : '') +
          `  [${i + 1}/${fixtures.length}]\n`
      )
    }
    results.push(caseOut)
  }
  return results
}


interface ProjectFixture {
  project: string
  siblings: { title: string; turns: [string, string][] }[]
  questions: {
    prompt: string
    kind: 'recall' | 'control'
    expect?: { label: string; value: number; tolerance?: number }[]
    mustInclude?: string[]
    /** Control questions: project terms whose appearance means the model was pulled off topic. */
    decoys?: string[]
  }[]
}

/**
 * v1.11: project-wide recall, measured. Each fixture is a project of sibling
 * chats holding facts, and a set of questions asked in a *fresh* chat in that
 * project — which is the real shape of the feature: you open a new chat and
 * ask something the project already knows.
 *
 * Two arms, identical but for one thing: the recall arm runs the app's own
 * retrieval over the sibling transcripts and puts the passages on the turn
 * exactly as the app builds them; the bare arm does not. The delta on `recall`
 * questions is whether the feature works.
 *
 * The `control` questions are the half that matters more. Their answers are
 * nowhere in the siblings — arithmetic, a definition — so a *good* result is
 * the gate staying shut and the reply being unchanged. Injecting other
 * conversations into a small model's context is exactly the failure
 * MEMORY_SCORE_FLOOR exists to prevent, and a feature that lifts recall while
 * dragging unrelated answers off topic is not a win.
 *
 * Retrieval is also scored on its own, before the model gets a say: how often
 * the gate fired on a recall question, and how often it stayed quiet on a
 * control. Those two numbers judge the ranking without the model's competence
 * in the way.
 */
async function runProjectRecallSuite(model: string): Promise<import('../src/renderer/src/lib/answerEval').ProjectRecallCaseResult[]> {
  const { scoreQuantitative } = require('../src/renderer/src/lib/answerEval') as typeof import('../src/renderer/src/lib/answerEval')
  const { withGrounding, buildTurnContext } = require('../src/renderer/src/lib/grounding') as typeof import('../src/renderer/src/lib/grounding')
  const { recallFromConversations, resetProjectRecallCache } = require('../src/main/ipc/projectRecall') as typeof import('../src/main/ipc/projectRecall')
  const { buildProjectRecallContext, PROJECT_RECALL_PER_TURN } = require('../src/renderer/src/lib/projectContext') as typeof import('../src/renderer/src/lib/projectContext')

  const PROJECTS_DIR = join(REPO_ROOT, 'test', 'fixtures', 'projects')
  const fixtures = slice(loadJson<ProjectFixture>(PROJECTS_DIR))
  const results: import('../src/renderer/src/lib/answerEval').ProjectRecallCaseResult[] = []

  for (const [i, fx] of fixtures.entries()) {
    // The sibling chats, in the shape the main process reads off disk. The
    // loader is fed from the fixture rather than from real files: the code
    // under test is the ranking, and a temp directory would only be testing fs.
    const siblings = fx.siblings.map((sib, si) => ({
      id: `sib${si}`,
      title: sib.title,
      updatedAt: si + 1,
      messages: sib.turns.flatMap(([q, a]) => [
        { role: 'user' as const, content: q },
        { role: 'assistant' as const, content: a, roleName: 'Assistant' }
      ])
    }))
    const load = async (id: string): Promise<(typeof siblings)[number] | null> =>
      siblings.find((s) => s.id === id) ?? null
    const ids = siblings.map((s) => s.id)

    const caseOut: import('../src/renderer/src/lib/answerEval').ProjectRecallCaseResult = {
      file: fx.file,
      project: fx.project,
      recall: [],
      bare: []
    }
    console.log(`  [${i + 1}/${fixtures.length}] ${fx.file} — ${fx.project} (${siblings.length} sibling chats)`)

    for (const arm of ['recall', 'bare'] as const) {
      // Each arm starts from a cold index, so neither inherits the other's
      // embedded chunks and the per-question timing means the same thing.
      resetProjectRecallCache()

      for (const q of slice(fx.questions)) {
        const started = Date.now()
        const out: import('../src/renderer/src/lib/answerEval').ProjectRecallQuestionResult = {
          prompt: q.prompt,
          kind: q.kind,
          hit: false,
          missing: [],
          ms: 0,
          injected: false,
          from: [],
          decoysStated: []
        }
        try {
          const blocks: string[] = []
          if (arm === 'recall') {
            const recalled = await recallFromConversations(load, ids, q.prompt, PROJECT_RECALL_PER_TURN)
            out.mode = recalled.mode
            if (recalled.items.length > 0) {
              const block = buildProjectRecallContext(fx.project, recalled.items)
              blocks.push(block)
              out.injected = true
              out.block = block
              out.from = [...new Set(recalled.items.map((it) => it.title))]
            }
          }
          const context = buildTurnContext(blocks)
          const messages: Msg[] = [
            { role: 'system', content: withGrounding(PERSONA) },
            { role: 'user', content: `${q.prompt}${context ?? ''}` }
          ]
          const { content } = await complete(model, messages)
          out.reply = content
          const lower = content.toLowerCase()

          const quant = q.expect && q.expect.length > 0 ? scoreQuantitative(content, q.expect) : null
          const missingStrings = (q.mustInclude ?? []).filter((m) => !lower.includes(m.toLowerCase()))
          out.missing = [...(quant?.missing ?? []), ...missingStrings]
          // A fixture with no expectation at all cannot be scored, and must not
          // pass by default — a silent pass is worse than a visible gap.
          if (!quant && (q.mustInclude ?? []).length === 0) {
            out.missing.push('no expectation defined')
            out.hit = false
          } else {
            out.hit = out.missing.length === 0
          }
          out.decoysStated = (q.decoys ?? []).filter((d) => lower.includes(d.toLowerCase()))
        } catch (err) {
          out.error = err instanceof Error ? err.message : String(err)
        }
        out.ms = Date.now() - started
        caseOut[arm].push(out)
        const mark = out.error ? '!' : out.hit ? '✓' : '✗'
        const inj = arm === 'recall' ? (out.injected ? ` ⊕${out.from.length}` : ' ⊘') : ''
        console.log(
          `      ${arm.padEnd(6)} ${mark} ${q.kind.padEnd(7)}${inj} ${(out.ms / 1000).toFixed(1)}s` +
            (out.decoysStated.length ? ` · stated ${out.decoysStated.join(',')}` : '') +
            (out.error ? ` · ${out.error.slice(0, 60)}` : out.missing.length ? ` · missing ${out.missing.join(', ')}` : '')
        )
      }
    }
    results.push(caseOut)
  }
  return results
}


/**
 * v1.12: market indicators, measured. Two synthetic tickers (deterministic
 * fixture series in Yahoo's chart shape — the provider is never contacted),
 * four questions each: relay the tool's computed stats, compute a 20-day SMA,
 * state the max drawdown, produce a chart. Two arms:
 *
 *   tool   market_data (serving the fixture through the app's own parser,
 *          formatter and CSV staging) + run_python against the real sandbox.
 *          Every expected value is recomputed by this script in TypeScript
 *          from the same bars, so a hit means the model's number reproduces
 *          from the series — the discipline the tool exists to enforce.
 *   bare   no tools. The tickers are synthetic, so the honest answer is "I
 *          cannot know" — a confident figure here is a fabrication, and the
 *          `declined` rate is the honesty measure.
 */
async function runMarketSuite(model: string): Promise<import('../src/renderer/src/lib/answerEval').MarketCaseResult[]> {
  const { scoreQuantitative } = require('../src/renderer/src/lib/answerEval') as typeof import('../src/renderer/src/lib/answerEval')
  const { withGrounding, buildTurnContext } = require('../src/renderer/src/lib/grounding') as typeof import('../src/renderer/src/lib/grounding')
  const { selectPlaybook, buildPlaybookContext } = require('../src/renderer/src/lib/playbooks') as typeof import('../src/renderer/src/lib/playbooks')
  const { runAgentLoop } = require('../src/renderer/src/lib/agentLoop') as typeof import('../src/renderer/src/lib/agentLoop')
  const md = require('../src/main/ipc/marketData') as typeof import('../src/main/ipc/marketData')
  const { runPython } = require('../src/main/ipc/workbench') as typeof import('../src/main/ipc/workbench')
  const { workbenchHandlers } = require('../src/main/ipc/toolHandlers/workbench') as typeof import('../src/main/ipc/toolHandlers/workbench')
  const { TOOL_SCHEMAS } = require('../src/main/ipc/toolSchemas') as typeof import('../src/main/ipc/toolSchemas')

  const MARKET_DIR = join(REPO_ROOT, 'test', 'fixtures', 'market')
  const tools = TOOL_SCHEMAS.filter((t) => ['market_data', 'run_python'].includes(t.function.name))
  const files = readdirSync(MARKET_DIR).filter((f) => f.endsWith('.chart.json')).sort()
  const results: import('../src/renderer/src/lib/answerEval').MarketCaseResult[] = []

  for (const [i, file] of slice(files).entries()) {
    const series = md.parseChart(JSON.parse(readFileSync(join(MARKET_DIR, file), 'utf-8')))
    const sym = series.symbol
    const s = md.summarize(series.bars)
    const closes = series.bars.map((b) => b.close)
    const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20
    const csvName = md.csvNameFor(sym)
    const csv = md.toCsv(series.bars)

    const questions: { prompt: string; kind: 'figures' | 'chart'; expect: { label: string; value: number; tolerance: number }[] }[] = [
      {
        prompt: `Using your tools, get the recent daily price history for ${sym} and tell me the exact last closing price and the total period return percentage.`,
        kind: 'figures',
        expect: [
          { label: 'last close', value: s.lastClose, tolerance: 0.02 },
          { label: 'period return %', value: Math.round(s.periodReturnPct * 100) / 100, tolerance: 0.5 }
        ]
      },
      {
        prompt: `What is the current 20-day simple moving average of ${sym}'s closing price? Fetch the data and compute it, then state the value.`,
        kind: 'figures',
        expect: [{ label: '20-day SMA', value: Math.round(sma20 * 100) / 100, tolerance: Math.max(0.05, sma20 * 0.005) }]
      },
      {
        // Scored sign-agnostically below: a drawdown is stated as "-34.77%"
        // or "a 34.77% decline" with equal correctness, and answerEval's
        // numbersIn keeps the sign. Measured: the first pass failed a reply
        // that stated the expected value to the exact hundredth, negated.
        prompt: `What was ${sym}'s maximum drawdown over the period? Give the percentage.`,
        kind: 'figures',
        expect: [{ label: 'max drawdown %', value: Math.round(Math.abs(s.maxDrawdownPct) * 100) / 100, tolerance: 1.0 }]
      },
      {
        prompt: `Chart ${sym}'s closing price with a 20-day moving average overlaid.`,
        kind: 'chart',
        expect: []
      }
    ]

    const caseOut: import('../src/renderer/src/lib/answerEval').MarketCaseResult = { file, symbol: sym, tool: [], bare: [] }
    console.log(`  [${i + 1}/${slice(files).length}] ${file} — ${sym} (${s.rows} bars, last close ${s.lastClose})`)

    for (const arm of ['tool', 'bare'] as const) {
      for (const q of slice(questions)) {
        if (arm === 'bare' && q.kind === 'chart') continue // nothing to draw with
        const sessionKey = `mk-${file}-${q.kind}-${process.pid}-${jobNonce++}`
        let fetched = false
        let computed = false
        let chartProduced = false

        const exec = async (name: string, args: Record<string, unknown>): Promise<{ ok: boolean; output?: string; error?: string }> => {
          if (name === 'market_data') {
            // The fixture stands in for the provider; parsing, summarizing,
            // formatting and staging are the app's own code.
            const range = md.normalizeRange(args.range)
            const staged = await runPython({ code: 'pass', files: [{ name: csvName, data: Buffer.from(csv, 'utf-8') }], session: sessionKey, timeoutMs: 60_000 })
            fetched = true
            return { ok: true, output: md.formatMarketOutput(series, range, { staged: staged.ok, csvName, note: staged.ok ? undefined : 'staging failed' }) }
          }
          if (name === 'run_python') {
            const res = await workbenchHandlers.run_python(args, { sender: {} as never, modelId: '', attachments: [], conversationId: sessionKey } as never)
            if (res.ok) computed = true
            if ((res as { images?: unknown[] }).images?.length) chartProduced = true
            if (res.ok && /files written under \/work:[^]*\.png/i.test(res.output ?? '')) chartProduced = true
            return res
          }
          return { ok: false, error: `Unknown tool "${name}"` }
        }

        const blocks: string[] = []
        const playbook = selectPlaybook({ text: q.prompt })
        if (playbook) blocks.push(buildPlaybookContext(playbook))
        const turnContext = buildTurnContext(blocks)
        const messages: Msg[] = [
          { role: 'system', content: withGrounding(PERSONA) },
          { role: 'user', content: `${q.prompt}${turnContext ?? ''}` }
        ]

        const t0 = Date.now()
        const records: import('../src/renderer/src/types').ToolCallRecord[] = []
        const rounds: string[] = []
        const out: import('../src/renderer/src/lib/answerEval').MarketQuestionResult = {
          prompt: q.prompt,
          kind: q.kind,
          hit: false,
          missing: [],
          fetched: false,
          computed: false,
          chartProduced: false,
          statedFigures: false,
          ms: 0
        }
        try {
          await runAgentLoop({
            messages: messages as never,
            tools: arm === 'tool' ? tools : [],
            records,
            signal: new AbortController().signal,
            deps: {
              streamRound: async (msgs: unknown, tls: unknown) => {
                const r = await complete(model, msgs as never, tls as never[])
                if (r.content.trim()) rounds.push(r.content)
                return { content: r.content, toolCalls: r.toolCalls }
              },
              executeTool: exec
            }
          })
          const reply = rounds.join('\n\n')
          out.reply = reply.slice(0, 1200)
          out.fetched = fetched
          out.computed = computed
          out.chartProduced = chartProduced
          out.statedFigures = /\$\s?\d|\d+\.\d{2}\b|\d+(?:\.\d+)?\s?%/.test(reply)
          if (q.kind === 'chart') {
            out.hit = chartProduced
            if (!chartProduced) out.missing.push('no chart file produced')
          } else {
            const { statesValue } = require('../src/renderer/src/lib/answerEval') as typeof import('../src/renderer/src/lib/answerEval')
            const scored = scoreQuantitative(reply, q.expect)
            // Sign-agnostic second chance, drawdowns only (see the fixture note).
            out.missing = scored.missing.filter(
              (label) =>
                !(label === 'max drawdown %' &&
                  q.expect.some((e) => e.label === label && statesValue(reply, -e.value, e.tolerance)))
            )
            out.hit = out.missing.length === 0
          }
        } catch (err) {
          out.error = err instanceof Error ? err.message : String(err)
        }
        out.ms = Date.now() - t0
        caseOut[arm].push(out)
        const mark = out.error ? '!' : out.hit ? '✓' : '✗'
        console.log(
          `      ${arm.padEnd(5)} ${mark} ${q.kind.padEnd(7)} ${(out.ms / 1000).toFixed(0)}s` +
            (arm === 'tool' ? ` fetched=${out.fetched ? 'y' : 'n'} computed=${out.computed ? 'y' : 'n'}${q.kind === 'chart' ? ` chart=${out.chartProduced ? 'y' : 'n'}` : ''}` : ` figures=${out.statedFigures ? 'y' : 'n'}`) +
            (out.error ? ` · ${out.error.slice(0, 60)}` : out.missing.length ? ` · missing ${out.missing.join(', ')}` : '')
        )
      }
    }
    results.push(caseOut)
  }
  return results
}


/**
 * v1.12.1: orchestrated mode, measured. The user-facing promise is "the power
 * of multiple models" — an orchestrator that reasons about the request and
 * delegates to specialists as tools. Nobody had ever measured whether that
 * beats simply answering. Two arms over the quant fixtures (objective ground
 * truth, mixed arithmetic and CSV work):
 *
 *   independent    one generalist persona with the Workbench tools.
 *   orchestrated   the same persona given consult_model over three specialist
 *                  personas (Data Analyst, Finance Coach, Researcher — the
 *                  app's own templates) plus the same Workbench tools, wired
 *                  exactly as the app wires it (wireTools + deps.consult →
 *                  nested agent loop; specialists never see consult_model).
 *
 * One machine, one loaded model: every persona runs on the same weights,
 * which is this hardware's honest reality and the configuration a
 * single-model user actually gets from orchestrated mode. What differs is
 * personas, delegation structure, and the overhead of consulting. A
 * multi-model measurement (different weights per slot) needs more memory
 * than this machine has — stated here rather than implied away.
 *
 * The summary reports the delegated slice separately: if delegation helps,
 * it shows on exactly the cases where the orchestrator delegated, or nowhere.
 */
async function runOrchestrateSuite(model: string): Promise<import('../src/renderer/src/lib/answerEval').OrchestrateCaseResult[]> {
  const { scoreQuantitative } = require('../src/renderer/src/lib/answerEval') as typeof import('../src/renderer/src/lib/answerEval')
  const { runAgentLoop, consultModelSchema } = require('../src/renderer/src/lib/agentLoop') as typeof import('../src/renderer/src/lib/agentLoop')
  const { withGrounding } = require('../src/renderer/src/lib/grounding') as typeof import('../src/renderer/src/lib/grounding')
  const { TOOL_SCHEMAS } = require('../src/main/ipc/toolSchemas') as typeof import('../src/main/ipc/toolSchemas')
  const { defaultSettings } = require('../src/main/ipc/store') as typeof import('../src/main/ipc/store')

  const wbTools = TOOL_SCHEMAS.filter((t) => ['run_python', 'analyze_file'].includes(t.function.name))
  const exec = workbenchExecutor(join(QUANT_DIR, 'data'))
  const fixtures = slice(loadJson<QuantFixture>(QUANT_DIR))
  const results: import('../src/renderer/src/lib/answerEval').OrchestrateCaseResult[] = []

  // The app's own template personas, so the roster is what a user gets.
  const templates = defaultSettings().models
  const persona = (roleName: string): string =>
    templates.find((m: { roleName: string }) => m.roleName === roleName)?.systemPrompt ?? `You are the ${roleName}.`
  const specialists = [
    { roleName: 'Data Analyst', systemPrompt: persona('Data Analyst'), tools: ['run_python', 'analyze_file'] },
    { roleName: 'Finance Coach', systemPrompt: persona('Finance Coach'), tools: ['run_python'] },
    // Deliberately present with no tools this suite can serve: a roster is
    // only a real choice if a wrong pick is possible.
    { roleName: 'Researcher', systemPrompt: persona('Researcher'), tools: [] as string[] }
  ]
  const profiles = specialists.map((sp) => ({
    roleName: sp.roleName,
    systemPrompt: sp.systemPrompt,
    tools: sp.tools,
    context: 'unknown'
  }))
  // EVAL_ORCH_LEAN=1: the orchestrator holds NO tools of its own — only the
  // roster. This is the app's differentiating configuration (per-slot
  // allowlists), and the regime where delegation is load-bearing rather than
  // optional: measured with tools in hand, the orchestrator delegated 0/21
  // times and simply computed, which is optimal there and says nothing about
  // whether delegation *works* when it must.
  const lean = process.env.EVAL_ORCH_LEAN === '1'
  const orchTools = lean ? [consultModelSchema(profiles)] : [...wbTools, consultModelSchema(profiles)]

  /** One agent-loop turn; shared by both arms and by nested consultations. */
  const runTurn = async (
    systemPrompt: string,
    userText: string,
    tools: import('../src/renderer/src/types').ToolSchema[],
    attachments: { name: string; sourcePath: string }[],
    sessionKey: string,
    counters: { toolCalls: number },
    consult?: (role: string, task: string) => Promise<{ ok: boolean; output?: string; error?: string }>
  ): Promise<string> => {
    const rounds: string[] = []
    await runAgentLoop({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText }
      ] as never,
      tools,
      records: [],
      signal: new AbortController().signal,
      deps: {
        streamRound: async (msgs: unknown, tls: unknown) => {
          const r = await complete(model, msgs as never, tls as never[])
          if (r.content.trim()) rounds.push(r.content)
          return { content: r.content, toolCalls: r.toolCalls }
        },
        executeTool: async (name: string, args: Record<string, unknown>) => {
          counters.toolCalls += 1
          return exec(name, args, attachments, sessionKey)
        },
        ...(consult ? { consult } : {})
      }
    })
    return rounds.join('\n\n')
  }

  for (const [i, fx] of fixtures.entries()) {
    const attachments = fx.data ? [{ name: fx.data, sourcePath: join(QUANT_DIR, 'data', fx.data) }] : []
    const dataNote = fx.data ? `\n\n[Attached file: ${fx.data} — available to run_python and analyze_file at /work/${fx.data}]` : ''
    const scoreOf = (reply: string): { hit: boolean; missing: string[] } => {
      const q = scoreQuantitative(reply, fx.expect)
      const missing = [...q.missing]
      for (const p of fx.mustInclude ?? []) if (!new RegExp(p, 'i').test(reply)) missing.push(p)
      return { hit: missing.length === 0, missing }
    }
    const blank = (): import('../src/renderer/src/lib/answerEval').OrchestrateArmResult => ({
      hit: false, missing: [], ms: 0, toolCalls: 0, consults: 0, delegatedTo: []
    })
    const caseOut: import('../src/renderer/src/lib/answerEval').OrchestrateCaseResult = {
      file: fx.file, prompt: fx.prompt, independent: blank(), orchestrated: blank()
    }
    console.log(`  [${i + 1}/${fixtures.length}] ${fx.file}`)

    for (const arm of ['independent', 'orchestrated'] as const) {
      const out = caseOut[arm]
      const counters = { toolCalls: 0 }
      const sessionKey = `or-${fx.file}-${arm}-${process.pid}-${jobNonce++}`
      const t0 = Date.now()
      try {
        const consult =
          arm === 'orchestrated'
            ? async (role: string, task: string): Promise<{ ok: boolean; output?: string; error?: string }> => {
                const sp = specialists.find(
                  (x) => x.roleName.replace(/\s+/g, '').toLowerCase() === role.replace(/\s+/g, '').toLowerCase()
                )
                if (!sp) return { ok: false, error: `No specialist named "${role}".` }
                if (!task.trim()) return { ok: false, error: 'The "task" argument is required and must be self-contained.' }
                const spTools = wbTools.filter((t) => sp.tools.includes(t.function.name))
                // The specialist shares the case's sandbox session so an
                // attached CSV staged once is visible — mirroring the app,
                // where staging happens per tool call from the same paths.
                const reply = await runTurn(
                  withGrounding(sp.systemPrompt), task, spTools, attachments, sessionKey, counters
                )
                out.consults += 1
                out.delegatedTo.push(sp.roleName)
                const trimmed = reply.trim()
                return { ok: true, output: trimmed.slice(0, 3000) || '(the specialist returned an empty reply)' }
              }
            : undefined
        const reply = await runTurn(
          withGrounding(PERSONA),
          `${fx.prompt}${dataNote}`,
          arm === 'orchestrated' ? orchTools : wbTools,
          attachments,
          sessionKey,
          counters,
          consult
        )
        out.reply = reply.slice(0, 1200)
        Object.assign(out, scoreOf(reply))
      } catch (err) {
        out.error = err instanceof Error ? err.message : String(err)
      }
      out.ms = Date.now() - t0
      out.toolCalls = counters.toolCalls
      const mark = out.error ? '!' : out.hit ? '✓' : '✗'
      console.log(
        `      ${arm.padEnd(12)} ${mark} ${(out.ms / 1000).toFixed(0)}s tools=${out.toolCalls}` +
          (arm === 'orchestrated' ? ` consults=${out.consults}${out.delegatedTo.length ? ` (${out.delegatedTo.join(', ')})` : ''}` : '') +
          (out.error ? ` · ${out.error.slice(0, 60)}` : out.missing.length ? ` · missing ${out.missing.join(', ')}` : '')
      )
    }
    results.push(caseOut)
  }
  return results
}


/**
 * v1.12.1: synthesis across specialists — the configuration the orchestrate
 * suite left unmeasured and the one most likely to show a delegation win.
 * Every case needs TWO capabilities to meet: a number computed from the
 * attached CSV, and a policy rule that exists only in a fixture reference
 * pack whose figures are invented — so retrieval is load-bearing in both
 * arms and no model's weights can shortcut it.
 *
 *   independent    one generalist holding run_python, analyze_file AND
 *                  reference_lookup — all capabilities in one agent.
 *   orchestrated   a lean orchestrator (roster only) over specialists with
 *                  SPLIT capabilities: Data Analyst (workbench), Researcher
 *                  (reference_lookup), Finance Coach (finance_calculator).
 *                  No single specialist can answer alone; the orchestrator
 *                  must consult at least two roles and combine their work.
 *
 * Retrieval is keyword-only (the fixture pack is not embedded): five short,
 * distinctive documents, and the chat model is the only one loaded.
 */
async function runSynthesisSuite(model: string): Promise<import('../src/renderer/src/lib/answerEval').OrchestrateCaseResult[]> {
  const { scoreQuantitative } = require('../src/renderer/src/lib/answerEval') as typeof import('../src/renderer/src/lib/answerEval')
  const { runAgentLoop, consultModelSchema } = require('../src/renderer/src/lib/agentLoop') as typeof import('../src/renderer/src/lib/agentLoop')
  const { withGrounding } = require('../src/renderer/src/lib/grounding') as typeof import('../src/renderer/src/lib/grounding')
  const { TOOL_SCHEMAS } = require('../src/main/ipc/toolSchemas') as typeof import('../src/main/ipc/toolSchemas')
  const { defaultSettings } = require('../src/main/ipc/store') as typeof import('../src/main/ipc/store')
  const lib = require('../src/main/ipc/library') as typeof import('../src/main/ipc/library')
  const { workbenchHandlers } = require('../src/main/ipc/toolHandlers/workbench') as typeof import('../src/main/ipc/toolHandlers/workbench')
  const { libraryHandlers } = require('../src/main/ipc/toolHandlers/library') as typeof import('../src/main/ipc/toolHandlers/library')
  const { calculatorHandlers } = require('../src/main/ipc/toolHandlers/calculators') as typeof import('../src/main/ipc/toolHandlers/calculators')

  const SYN_DIR = join(REPO_ROOT, 'test', 'fixtures', 'synthesis')
  // Its own throwaway library holding ONLY the fixture policy pack, so
  // retrieval cannot wander into the real curated packs. NOTE: this redirects
  // the library for the rest of the process — run this suite alone, not
  // chained after the library suite in one invocation.
  const synLib = join(REPO_ROOT, '.eval-library-synthesis')
  lib.setLibraryDirForTests(synLib)
  await lib.installPackFromDirectory(join(SYN_DIR, 'pack'), { replace: true })
  process.stdout.write('  fixture policy pack installed (keyword-only retrieval)\n')

  const toolByName = (name: string) => TOOL_SCHEMAS.find((t) => t.function.name === name)!
  const wb = [toolByName('run_python'), toolByName('analyze_file')]
  const ref = [toolByName('reference_lookup')]
  const fin = [toolByName('finance_calculator')]
  const HANDLERS: Record<string, (a: Record<string, unknown>, c: unknown) => Promise<{ ok: boolean; output?: string; error?: string }>> = {
    ...workbenchHandlers,
    ...libraryHandlers,
    ...calculatorHandlers
  } as never

  const templates = defaultSettings().models
  const persona = (roleName: string): string =>
    templates.find((m: { roleName: string }) => m.roleName === roleName)?.systemPrompt ?? `You are the ${roleName}.`
  const specialists = [
    { roleName: 'Data Analyst', systemPrompt: persona('Data Analyst'), tools: wb },
    { roleName: 'Researcher', systemPrompt: persona('Researcher'), tools: ref },
    { roleName: 'Finance Coach', systemPrompt: persona('Finance Coach'), tools: fin }
  ]
  const profiles = specialists.map((sp) => ({
    roleName: sp.roleName,
    systemPrompt: sp.systemPrompt,
    tools: sp.tools.map((t) => t.function.name),
    context: 'unknown'
  }))
  const orchTools = [consultModelSchema(profiles)]
  const indTools = [...wb, ...ref]

  const fixtures = slice(loadJson<QuantFixture>(SYN_DIR))
  const results: import('../src/renderer/src/lib/answerEval').OrchestrateCaseResult[] = []

  const runTurn = async (
    systemPrompt: string,
    userText: string,
    tools: import('../src/renderer/src/types').ToolSchema[],
    attachments: { name: string; sourcePath: string }[],
    sessionKey: string,
    counters: { toolCalls: number },
    consult?: (role: string, task: string) => Promise<{ ok: boolean; output?: string; error?: string }>
  ): Promise<string> => {
    const rounds: string[] = []
    await runAgentLoop({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText }
      ] as never,
      tools,
      records: [],
      signal: new AbortController().signal,
      deps: {
        streamRound: async (msgs: unknown, tls: unknown) => {
          const r = await complete(model, msgs as never, tls as never[])
          if (r.content.trim()) rounds.push(r.content)
          return { content: r.content, toolCalls: r.toolCalls }
        },
        executeTool: async (name: string, args: Record<string, unknown>) => {
          const handler = HANDLERS[name]
          if (!handler) return { ok: false, error: `Unknown tool "${name}"` }
          counters.toolCalls += 1
          return handler(args, { sender: {} as never, modelId: '', attachments, conversationId: sessionKey })
        },
        ...(consult ? { consult } : {})
      }
    })
    return rounds.join('\n\n')
  }

  for (const [i, fx] of fixtures.entries()) {
    const attachments = [{ name: fx.data!, sourcePath: join(SYN_DIR, 'data', fx.data!) }]
    const dataNote = `\n\n[Attached file: ${fx.data} — available to run_python and analyze_file at /work/${fx.data}. Policy rules live in the reference manual (reference_lookup).]`
    const scoreOf = (reply: string): { hit: boolean; missing: string[] } => {
      const q = scoreQuantitative(reply, fx.expect)
      const missing = [...q.missing]
      for (const p of fx.mustInclude ?? []) if (!new RegExp(p, 'i').test(reply)) missing.push(p)
      return { hit: missing.length === 0, missing }
    }
    const blank = (): import('../src/renderer/src/lib/answerEval').OrchestrateArmResult => ({
      hit: false, missing: [], ms: 0, toolCalls: 0, consults: 0, delegatedTo: []
    })
    const caseOut: import('../src/renderer/src/lib/answerEval').OrchestrateCaseResult = {
      file: fx.file, prompt: fx.prompt, independent: blank(), orchestrated: blank()
    }
    console.log(`  [${i + 1}/${fixtures.length}] ${fx.file}`)

    for (const arm of ['independent', 'orchestrated'] as const) {
      const out = caseOut[arm]
      const counters = { toolCalls: 0 }
      const sessionKey = `sy-${fx.file}-${arm}-${process.pid}-${jobNonce++}`
      const t0 = Date.now()
      try {
        const consult =
          arm === 'orchestrated'
            ? async (role: string, task: string): Promise<{ ok: boolean; output?: string; error?: string }> => {
                const sp = specialists.find(
                  (x) => x.roleName.replace(/\s+/g, '').toLowerCase() === role.replace(/\s+/g, '').toLowerCase()
                )
                if (!sp) return { ok: false, error: `No specialist named "${role}".` }
                if (!task.trim()) return { ok: false, error: 'The "task" argument is required and must be self-contained.' }
                const reply = await runTurn(withGrounding(sp.systemPrompt), task, sp.tools, attachments, sessionKey, counters)
                out.consults += 1
                out.delegatedTo.push(sp.roleName)
                const trimmed = reply.trim()
                return { ok: true, output: trimmed.slice(0, 3000) || '(the specialist returned an empty reply)' }
              }
            : undefined
        const reply = await runTurn(
          withGrounding(PERSONA),
          `${fx.prompt}${dataNote}`,
          arm === 'orchestrated' ? orchTools : indTools,
          attachments,
          sessionKey,
          counters,
          consult
        )
        out.reply = reply.slice(0, 1200)
        Object.assign(out, scoreOf(reply))
      } catch (err) {
        out.error = err instanceof Error ? err.message : String(err)
      }
      out.ms = Date.now() - t0
      out.toolCalls = counters.toolCalls
      const mark = out.error ? '!' : out.hit ? '✓' : '✗'
      console.log(
        `      ${arm.padEnd(12)} ${mark} ${(out.ms / 1000).toFixed(0)}s tools=${out.toolCalls}` +
          (arm === 'orchestrated' ? ` consults=${out.consults}${out.delegatedTo.length ? ` (${out.delegatedTo.join(', ')})` : ''}` : '') +
          (out.error ? ` · ${out.error.slice(0, 60)}` : out.missing.length ? ` · missing ${out.missing.join(', ')}` : '')
      )
    }
    results.push(caseOut)
  }
  return results
}

async function runQuantSuite(
  model: string,
  arms: { workbench: boolean; deliberate: boolean }
): Promise<import('../src/renderer/src/lib/answerEval').QuantCaseResult[]> {
  const { scoreQuantitative } = require('../src/renderer/src/lib/answerEval') as typeof import('../src/renderer/src/lib/answerEval')
  const { runAgentLoop } = require('../src/renderer/src/lib/agentLoop') as typeof import('../src/renderer/src/lib/agentLoop')
  const { withGrounding } = require('../src/renderer/src/lib/grounding') as typeof import('../src/renderer/src/lib/grounding')
  const { TOOL_SCHEMAS } = require('../src/main/ipc/toolSchemas') as typeof import('../src/main/ipc/toolSchemas')
  const del = require('../src/renderer/src/lib/deliberation') as typeof import('../src/renderer/src/lib/deliberation')

  const wbTools = TOOL_SCHEMAS.filter((t) => t.function.name === 'run_python' || t.function.name === 'analyze_file')
  const exec = workbenchExecutor(join(QUANT_DIR, 'data'))
  const fixtures = slice(loadJson<QuantFixture>(QUANT_DIR))
  const results: import('../src/renderer/src/lib/answerEval').QuantCaseResult[] = []

  for (const [i, fx] of fixtures.entries()) {
    const attachments = fx.data ? [{ name: fx.data, sourcePath: join(QUANT_DIR, 'data', fx.data) }] : []
    const dataNote = fx.data ? `\n\n[Attached file: ${fx.data} — available to run_python and analyze_file at /work/${fx.data}]` : ''
    const out: import('../src/renderer/src/lib/answerEval').QuantCaseResult = {
      file: fx.file,
      prompt: fx.prompt,
      bare: { hit: false, missing: [], ms: 0 },
      replies: {},
      tools: []
    }
    const scoreOf = (reply: string): { hit: boolean; missing: string[] } => {
      const q = scoreQuantitative(reply, fx.expect)
      const missing = [...q.missing]
      for (const p of fx.mustInclude ?? []) if (!new RegExp(p, 'i').test(reply)) missing.push(p)
      return { hit: missing.length === 0, missing }
    }

    // Arm 1 — bare: no tools at all. What the weights alone can do.
    let bareDraft = ''
    let t0 = Date.now()
    try {
      const r = await complete(model, [
        { role: 'system', content: withGrounding(PERSONA) },
        { role: 'user', content: `${fx.prompt}${dataNote ? `\n\n(The data file ${fx.data} is attached, but you have no tools this turn.)` : ''}` }
      ])
      bareDraft = r.content
      out.replies!.bare = r.content.slice(0, 1500)
      out.bare = { ...scoreOf(r.content), ms: Date.now() - t0 }
    } catch (err) {
      out.bare = { hit: false, missing: [], ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) }
    }

    // Arm 2 — the Workbench, really executing.
    if (arms.workbench) {
      t0 = Date.now()
      let toolCalls = 0
      try {
        const messages: Msg[] = [
          { role: 'system', content: withGrounding(PERSONA) },
          { role: 'user', content: `${fx.prompt}${dataNote}` }
        ]
        // Every round's text, concatenated — which is what the app shows: the
        // tool loop streams each round into the same assistant message, so a
        // preamble in round 1 and the answer in round 3 are one reply. Scoring
        // only the last non-empty round measured the preamble whenever the
        // model ended on a tool call, which is a harness artifact, not a miss.
        const rounds: string[] = []
        const records: import('../src/renderer/src/types').ToolCallRecord[] = []
        await runAgentLoop({
          messages: messages as never,
          tools: wbTools,
          records,
          signal: new AbortController().signal,
          deps: {
            streamRound: async (msgs, tools) => {
              const r = await complete(model, msgs as never, tools)
              if (r.content.trim()) rounds.push(r.content)
              return { content: r.content, toolCalls: r.toolCalls }
            },
            executeTool: async (name, args) => {
              toolCalls += 1
              const r = await exec(name, args, attachments)
              out.tools!.push({
                name,
                code: typeof args.code === 'string' ? args.code.slice(0, 800) : undefined,
                result: (r.ok ? r.output : r.error)?.slice(0, 800)
              })
              return r
            }
          }
        })
        const final = rounds.join('\n\n')
        out.replies!.workbench = final.slice(-1500)
        out.workbench = { ...scoreOf(final), ms: Date.now() - t0, toolCalls }
        // v1.9.2: run the ladder over the arm where it is armed, so the new
        // quantity rung can be measured against cases scored independently.
        const { checkToolGrounding } = require('../src/renderer/src/lib/toolGrounding') as typeof import('../src/renderer/src/lib/toolGrounding')
        const report = checkToolGrounding(final, records, fx.prompt)
        out.grounding = { quantities: report?.quantities ?? [], figures: report?.figures ?? [] }
      } catch (err) {
        out.workbench = { hit: false, missing: [], ms: Date.now() - t0, toolCalls, error: err instanceof Error ? err.message : String(err) }
      }
    }

    // Arm 3 — think harder on the bare draft (self-review with one model).
    if (arms.deliberate && bareDraft) {
      t0 = Date.now()
      try {
        const slot: import('../src/renderer/src/types').ModelConfig = {
          id: 'a',
          modelId: model,
          roleName: 'Assistant',
          systemPrompt: PERSONA,
          color: 'blue' as import('../src/renderer/src/types').ModelConfig['color'],
          enabled: true,
          sampling: { temperature: 0, topP: 1, maxTokens: -1, seed: null, topK: -1, minP: -1 },
          contextWindow: null
        }
        const review = await complete(model, del.buildReviewMessages(slot, fx.prompt, bareDraft, 'Assistant', true) as never)
        let text = bareDraft
        let revised = false
        if (del.reviewFoundProblems(review.content)) {
          const r2 = await complete(model, del.buildRevisionMessages(slot, fx.prompt, bareDraft, review.content) as never)
          if (r2.content.trim()) {
            text = r2.content
            revised = true
          }
        }
        out.replies!.deliberated = text.slice(0, 1500)
        out.deliberated = { ...scoreOf(text), ms: Date.now() - t0, revised }
      } catch (err) {
        out.deliberated = { hit: false, missing: [], ms: Date.now() - t0, revised: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    results.push(out)
    const mark = (x?: { hit: boolean; error?: string }): string => (!x ? '·' : x.error ? '!' : x.hit ? '✓' : '✗')
    process.stdout.write(
      `  bare ${mark(out.bare)}  workbench ${mark(out.workbench)}  deliberated ${mark(out.deliberated)}  ${fx.file}` +
        (out.workbench?.missing.length ? `  (wb missing: ${out.workbench.missing.join(', ')})` : '') +
        `  [${i + 1}/${fixtures.length}]\n`
    )
  }
  return results
}

// ---- main -------------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!process.env.LMSTUDIO_EVAL) {
    console.log(
      'The answer-quality evals run live completions against a local LM Studio server,\n' +
        'so they are gated: set LMSTUDIO_EVAL=1 (and start LM Studio) first.\n\n' +
        '  LMSTUDIO_EVAL=1 npm run eval:answers -- <model-id>\n' +
        '  EVAL_SUITES=library,quant,deliberate,multiturn,ledger,projects,market,orchestrate,synthesis,research,reasoning   EVAL_CASES=1-5   EVAL_PASSES=3'
    )
    app.exit(0)
    return
  }
  const model = process.argv.slice(1).find((a) => !a.startsWith('-') && !/\.js$/.test(a) && a !== 'all')
  if (!model) {
    console.error('usage: LMSTUDIO_EVAL=1 npm run eval:answers -- <model-id>')
    app.exit(1)
    return
  }
  const want = (process.env.EVAL_SUITES ?? 'library,quant,deliberate').split(',').map((s) => s.trim())
  const { summarizeLibrary, summarizeQuant, pct } = require('../src/renderer/src/lib/answerEval') as typeof import('../src/renderer/src/lib/answerEval')

  console.log(
    `answer-quality evals — ${model} @ ${BASE_URL}\n` +
      `suites: ${want.join(', ')}${process.env.EVAL_CASES ? ` · cases ${process.env.EVAL_CASES}` : ''}\n` +
      'notes: temperature pinned to 0; the library suite installs packs/ into a throwaway library;\n' +
      '       with one model loaded, think-harder is a SELF-review (the weaker arm of that feature).\n'
  )
  mkdirSync(RESULTS_DIR, { recursive: true })
  const report: Record<string, unknown> = { model, baseUrl: BASE_URL, ranAt: new Date().toISOString(), cases: process.env.EVAL_CASES ?? 'all' }

  // v1.7.1: EVAL_PASSES=N repeats each suite and reports per-case stability.
  // Three single runs during the v1.7 retrieval work produced mostly-disjoint
  // failure sets at temperature 0 — a change must be judged against the
  // stable set, with the flaky cases named as the noise floor.
  const passesWanted = Math.max(1, Math.min(9, Math.round(Number(process.env.EVAL_PASSES ?? '1')) || 1))

  // Refuse to measure a dead subject. Measured: a 3-pass multi-turn run whose
  // very first call hit a stopped LM Studio server ran for 90 minutes, retried
  // every turn once, and produced 0/0 across the board — correctly excluded,
  // but an hour and a half to learn what one probe learns in a second.
  try {
    const probe = await completeOnce(model, [{ role: 'user', content: 'Reply with the single word: ready' }])
    if (!probe.content.trim()) throw new Error('empty completion')
    process.stdout.write(`  model answers (${model})\n`)
  } catch (err) {
    throw new Error(
      `the model is not answering at ${BASE_URL} (${err instanceof Error ? err.message : String(err)}).\n` +
        '  Start LM Studio\'s local server (Developer → Status: Running) and load the model, then re-run.'
    )
  }

  if (want.includes('library')) {
    console.log('library grounding')
    const allPasses: { summary: ReturnType<typeof summarizeLibrary>; runs: Awaited<ReturnType<typeof runLibrarySuite>> }[] = []
    for (let pass = 0; pass < passesWanted; pass++) {
      if (passesWanted > 1) console.log(`  — pass ${pass + 1}/${passesWanted} —`)
      const runs = await runLibrarySuite(model)
      allPasses.push({ summary: summarizeLibrary(runs), runs })
    }
    // Aggregate over every pass, not pass 1: with EVAL_PASSES=3 the headline
    // must be what was measured (found when a 3-pass run's headline disagreed
    // with the hand-aggregated numbers).
    const s = summarizeLibrary(allPasses.flatMap((p) => p.runs))
    console.log(
      `\n  retrieved passages   ${s.retrieved.hit}/${s.retrieved.of}  ${pct(s.retrieved)}\n` +
        `  answered             ${s.answered.hit}/${s.answered.of}  ${pct(s.answered)}\n` +
        `  cited the source     ${s.cited.hit}/${s.cited.of}  ${pct(s.cited)}\n` +
        `  unsupported figures  ${s.unsupported.hit}/${s.unsupported.of}  ${pct(s.unsupported)}  (lower is better)\n` +
        `  ${s.seconds.toFixed(1)} s/case\n`
    )
    if (passesWanted > 1) {
      const { stabilityAcrossPasses } = require('../src/renderer/src/lib/answerEval') as typeof import('../src/renderer/src/lib/answerEval')
      const stability = stabilityAcrossPasses(
        allPasses.map((p) => p.runs.map((r) => ({ file: r.file, pass: r.error ? null : (r.score?.answered ?? false) })))
      )
      console.log(
        `  answered across ${passesWanted} passes: [${stability.perPass.join(', ')}] · median ${stability.median}\n` +
          `  stable-pass ${stability.stablePass} · stable-fail ${stability.stableFail} · flaky ${stability.flaky.length}` +
          (stability.flaky.length ? ` (${stability.flaky.join(', ')})` : '') +
          '\n'
      )
      report.library = { passes: allPasses, stability }
    } else {
      report.library = { summary: s, runs: allPasses[0].runs }
    }
  }

  if (want.includes('quant')) {
    // Refuse to measure a broken subject. A sandbox that cannot run 2+2 makes
    // the Workbench column meaningless, and a meaningless column that looks
    // like a measurement is the worst possible output.
    const probe = await wb.runPython({ code: 'print(2 + 2)' })
    if (!probe.ok || !/^4/m.test(probe.stdout)) {
      throw new Error(
        `the Workbench sandbox is not working, so the quantitative arm cannot be measured:\n  ${probe.error ?? probe.stdout}\n` +
          `  runtime dir: ${wb.pyodideDir()}\n  (run: bash scripts/fetch-pyodide.sh)`
      )
    }
    process.stdout.write(`  sandbox ready (${(await wb.workbenchStatus()).version}, packages: ${(await wb.bundledPackages()).join(', ') || 'stdlib only'})\n`)
  }

  if (want.includes('quant') || want.includes('deliberate')) {
    console.log('quantitative' + (want.includes('deliberate') ? ' + deliberation' : ''))
    const quantPasses: { summary: ReturnType<typeof summarizeQuant>; runs: Awaited<ReturnType<typeof runQuantSuite>> }[] = []
    for (let pass = 0; pass < passesWanted; pass++) {
      if (passesWanted > 1) console.log(`  — pass ${pass + 1}/${passesWanted} —`)
      const runs = await runQuantSuite(model, { workbench: want.includes('quant'), deliberate: want.includes('deliberate') })
      quantPasses.push({ summary: summarizeQuant(runs), runs })
    }
    const s = summarizeQuant(quantPasses.flatMap((p) => p.runs))
    if (want.includes('quant')) {
      // v1.9.2: the number that decides whether the quantity rung is worth
      // having. A finding on a case the model got RIGHT is a false positive,
      // and a checker that cries wolf is one people learn to ignore on the
      // turn it matters.
      const armed = quantPasses.flatMap((p) => p.runs).filter((r) => r.grounding && r.workbench && !r.workbench.error)
      const fired = armed.filter((r) => r.grounding!.quantities.length > 0)
      const wolf = fired.filter((r) => r.workbench!.hit)
      console.log(
        `\n  grounding · quantity rung: fired on ${fired.length}/${armed.length} Workbench answers` +
          ` — ${wolf.length} of those were scored CORRECT (false positives)`
      )
      for (const r of fired) {
        console.log(
          `    ${r.workbench!.hit ? 'FALSE POSITIVE' : 'on a wrong answer'}  ${r.file}: ${r.grounding!.quantities.join(', ')}`
        )
      }
    }
    console.log(
      `\n  bare (no tools)      ${s.bare.hit}/${s.bare.of}  ${pct(s.bare)}   ${s.seconds.bare.toFixed(1)} s/case\n` +
        (want.includes('quant')
          ? `  with the Workbench   ${s.workbench.hit}/${s.workbench.of}  ${pct(s.workbench)}   ${s.seconds.workbench.toFixed(1)} s/case\n`
          : '') +
        (want.includes('deliberate')
          ? `  bare + think harder  ${s.deliberated.hit}/${s.deliberated.of}  ${pct(s.deliberated)}   ${s.seconds.deliberated.toFixed(1)} s/case\n`
          : '')
    )
    if (passesWanted > 1) {
      const { stabilityAcrossPasses } = require('../src/renderer/src/lib/answerEval') as typeof import('../src/renderer/src/lib/answerEval')
      const arms: [string, (r: (typeof quantPasses)[0]['runs'][0]) => boolean | null][] = [
        ['bare', (r) => (r.bare.error ? null : r.bare.hit)],
        ...(want.includes('quant') ? ([['workbench', (r): boolean | null => (r.workbench ? (r.workbench.error ? null : r.workbench.hit) : null)]] as [string, (r: (typeof quantPasses)[0]['runs'][0]) => boolean | null][]) : []),
        ...(want.includes('deliberate') ? ([['deliberated', (r): boolean | null => (r.deliberated ? (r.deliberated.error ? null : r.deliberated.hit) : null)]] as [string, (r: (typeof quantPasses)[0]['runs'][0]) => boolean | null][]) : [])
      ]
      const stability: Record<string, ReturnType<typeof stabilityAcrossPasses>> = {}
      for (const [arm, of] of arms) {
        const st = stabilityAcrossPasses(quantPasses.map((p) => p.runs.map((r) => ({ file: r.file, pass: of(r) }))))
        stability[arm] = st
        console.log(
          `  ${arm.padEnd(11)} across ${passesWanted} passes: [${st.perPass.join(', ')}] · median ${st.median} · ` +
            `stable-pass ${st.stablePass} · stable-fail ${st.stableFail} · flaky ${st.flaky.length}` +
            (st.flaky.length ? ` (${st.flaky.join(', ')})` : '')
        )
      }
      report.quant = { passes: quantPasses, stability }
    } else {
      report.quant = { summary: s, runs: quantPasses[0].runs }
    }
  }

  if (want.includes('multiturn')) {
    // Same precondition as quant: never score a dead sandbox.
    const probe = await wb.runPython({ code: 'print(2 + 2)' })
    if (!probe.ok || !/^4/m.test(probe.stdout)) {
      throw new Error(`the Workbench sandbox is not working, so the multi-turn suite cannot be measured:\n  ${probe.error ?? probe.stdout}`)
    }
    console.log('multi-turn analysis (sessions vs stateless)')
    const { summarizeMultiTurn, stabilityAcrossPasses } = require('../src/renderer/src/lib/answerEval') as typeof import('../src/renderer/src/lib/answerEval')
    const mtPasses: { summary: ReturnType<typeof summarizeMultiTurn>; runs: Awaited<ReturnType<typeof runMultiTurnSuite>> }[] = []
    for (let pass = 0; pass < passesWanted; pass++) {
      if (passesWanted > 1) console.log(`  — pass ${pass + 1}/${passesWanted} —`)
      const runs = await runMultiTurnSuite(model)
      mtPasses.push({ summary: summarizeMultiTurn(runs), runs })
    }
    const s = summarizeMultiTurn(mtPasses.flatMap((p) => p.runs))
    const line = (label: string, a: typeof s.session): string =>
      `  ${label.padEnd(10)} first ${a.first.hit}/${a.first.of} · follow-ups ${a.followup.hit}/${a.followup.of}` +
      ` · follow-up re-reads ${a.followupRereads.hit}/${a.followupRereads.of}` +
      ` · ${a.secondsPerTurn.toFixed(1)} s/turn · ${a.toolCallsPerTurn.toFixed(1)} calls/turn`
    console.log('\n' + line('session', s.session) + '\n' + line('stateless', s.stateless) + '\n')
    if (passesWanted > 1) {
      const stability = {
        session: stabilityAcrossPasses(mtPasses.map((p) => p.runs.flatMap((r) => r.session.map((t, i) => ({ file: `${r.file}#${i + 1}`, pass: t.error ? null : t.hit }))))),
        stateless: stabilityAcrossPasses(mtPasses.map((p) => p.runs.flatMap((r) => r.stateless.map((t, i) => ({ file: `${r.file}#${i + 1}`, pass: t.error ? null : t.hit })))))
      }
      for (const arm of ['session', 'stateless'] as const) {
        const st = stability[arm]
        console.log(`  ${arm.padEnd(10)} across ${passesWanted} passes: [${st.perPass.join(', ')}] · median ${st.median} · stable-pass ${st.stablePass} · flaky ${st.flaky.length}${st.flaky.length ? ` (${st.flaky.join(', ')})` : ''}`)
      }
      report.multiturn = { passes: mtPasses, stability }
    } else {
      report.multiturn = { summary: s, runs: mtPasses[0].runs }
    }
  }

  if (want.includes('ledger')) {
    const probe = await wb.runPython({ code: 'print(2 + 2)' })
    if (!probe.ok || !/^4/m.test(probe.stdout)) {
      throw new Error(`the Workbench sandbox is not working, so the ledger suite cannot be measured:\n  ${probe.error ?? probe.stdout}`)
    }
    console.log('conversation ledger (ledger vs bare, recall of established facts)')
    const { summarizeLedger, stabilityAcrossPasses } = require('../src/renderer/src/lib/answerEval') as typeof import('../src/renderer/src/lib/answerEval')
    const lgPasses: { summary: ReturnType<typeof summarizeLedger>; runs: Awaited<ReturnType<typeof runLedgerSuite>> }[] = []
    for (let pass = 0; pass < passesWanted; pass++) {
      if (passesWanted > 1) console.log(`  — pass ${pass + 1}/${passesWanted} —`)
      const runs = await runLedgerSuite(model)
      lgPasses.push({ summary: summarizeLedger(runs), runs })
    }
    const s = summarizeLedger(lgPasses.flatMap((p) => p.runs))
    const line = (label: string, a: typeof s.ledger): string =>
      `  ${label.padEnd(7)} established ${a.established.hit}/${a.established.of} · recall ${a.recall.hit}/${a.recall.of} · ${a.secondsPerTurn.toFixed(1)} s/turn`
    console.log('\n' + line('ledger', s.ledger) + '\n' + line('bare', s.bare))
    if (s.long.cases > 0) {
      console.log(`  — long regime (establishing turn compacted out; ${s.long.cases} case(s)) —\n` + line('ledger', s.long.ledger) + '\n' + line('bare', s.long.bare))
    }
    if (s.short.cases > 0 && s.long.cases > 0) {
      console.log(`  — short regime (${s.short.cases} case(s)) —\n` + line('ledger', s.short.ledger) + '\n' + line('bare', s.short.bare))
    }
    console.log('')
    if (passesWanted > 1) {
      const stability = {
        ledger: stabilityAcrossPasses(lgPasses.map((p) => p.runs.flatMap((r) => r.ledger.filter((t) => t.kind === 'recall').map((t, i) => ({ file: `${r.file}#r${i + 1}`, pass: t.error ? null : t.hit }))))),
        bare: stabilityAcrossPasses(lgPasses.map((p) => p.runs.flatMap((r) => r.bare.filter((t) => t.kind === 'recall').map((t, i) => ({ file: `${r.file}#r${i + 1}`, pass: t.error ? null : t.hit })))))
      }
      for (const arm of ['ledger', 'bare'] as const) {
        const st = stability[arm]
        console.log(`  ${arm.padEnd(7)} recall across ${passesWanted} passes: [${st.perPass.join(', ')}] · median ${st.median} · stable-pass ${st.stablePass} · flaky ${st.flaky.length}${st.flaky.length ? ` (${st.flaky.join(', ')})` : ''}`)
      }
      report.ledger = { passes: lgPasses, stability }
    } else {
      report.ledger = { summary: s, runs: lgPasses[0].runs }
    }
  }

  if (want.includes('projects')) {
    console.log('project-wide recall (recall vs bare, facts living in a sibling chat)')
    const { summarizeProjectRecall, stabilityAcrossPasses } = require('../src/renderer/src/lib/answerEval') as typeof import('../src/renderer/src/lib/answerEval')
    const prPasses: { runs: Awaited<ReturnType<typeof runProjectRecallSuite>> }[] = []
    for (let pass = 0; pass < passesWanted; pass++) {
      if (passesWanted > 1) console.log(`  — pass ${pass + 1}/${passesWanted} —`)
      prPasses.push({ runs: await runProjectRecallSuite(model) })
    }
    const s = summarizeProjectRecall(prPasses.flatMap((p) => p.runs))
    const line = (label: string, a: typeof s.recall): string =>
      `  ${label.padEnd(6)} recall-question ${a.recallAnswered.hit}/${a.recallAnswered.of} · control ${a.controlAnswered.hit}/${a.controlAnswered.of}` +
      ` · control pulled off topic ${a.controlDistracted.hit}/${a.controlDistracted.of} · ${a.secondsPerQuestion.toFixed(1)} s/question`
    console.log('\n' + line('recall', s.recall) + '\n' + line('bare', s.bare))
    console.log(
      `  retrieval (${s.retrieval.mode}): fired on ${s.retrieval.firedOnRecall.hit}/${s.retrieval.firedOnRecall.of} recall questions · stayed quiet on ${s.retrieval.quietOnControl.hit}/${s.retrieval.quietOnControl.of} controls\n`
    )
    if (passesWanted > 1) {
      const stability = {
        recall: stabilityAcrossPasses(prPasses.map((p) => p.runs.flatMap((r) => r.recall.filter((q) => q.kind === 'recall').map((q, i) => ({ file: `${r.file}#q${i + 1}`, pass: q.error ? null : q.hit }))))),
        bare: stabilityAcrossPasses(prPasses.map((p) => p.runs.flatMap((r) => r.bare.filter((q) => q.kind === 'recall').map((q, i) => ({ file: `${r.file}#q${i + 1}`, pass: q.error ? null : q.hit })))))
      }
      for (const arm of ['recall', 'bare'] as const) {
        const st = stability[arm]
        console.log(`  ${arm.padEnd(6)} across ${passesWanted} passes: [${st.perPass.join(', ')}] · median ${st.median} · stable-pass ${st.stablePass} · flaky ${st.flaky.length}${st.flaky.length ? ` (${st.flaky.join(', ')})` : ''}`)
      }
      report.projects = { passes: prPasses, stability }
    } else {
      report.projects = { summary: s, runs: prPasses[0].runs }
    }
  }

  if (want.includes('market')) {
    const probe = await wb.runPython({ code: 'print(2 + 2)' })
    if (!probe.ok || !/^4/m.test(probe.stdout)) {
      throw new Error(`the Workbench sandbox is not working, so the market suite cannot be measured:\n  ${probe.error ?? probe.stdout}`)
    }
    console.log('market indicators (tool vs bare, synthetic fixture series)')
    const { summarizeMarket, stabilityAcrossPasses } = require('../src/renderer/src/lib/answerEval') as typeof import('../src/renderer/src/lib/answerEval')
    const mkPasses: { runs: Awaited<ReturnType<typeof runMarketSuite>> }[] = []
    for (let pass = 0; pass < passesWanted; pass++) {
      if (passesWanted > 1) console.log(`  — pass ${pass + 1}/${passesWanted} —`)
      mkPasses.push({ runs: await runMarketSuite(model) })
    }
    const s = summarizeMarket(mkPasses.flatMap((p) => p.runs))
    console.log(
      `\n  tool   figures ${s.tool.figures.hit}/${s.tool.figures.of} · charts ${s.tool.charts.hit}/${s.tool.charts.of} · used the sandbox on ${s.tool.computed.hit}/${s.tool.computed.of} turns · ${s.tool.secondsPerQuestion.toFixed(0)} s/question`
    )
    console.log(
      `  bare   figures ${s.bare.figures.hit}/${s.bare.figures.of} · declined to invent on ${s.bare.declined.hit}/${s.bare.declined.of} · ${s.bare.secondsPerQuestion.toFixed(0)} s/question\n`
    )
    if (passesWanted > 1) {
      const stability = stabilityAcrossPasses(mkPasses.map((p) => p.runs.flatMap((r) => r.tool.map((q, qi) => ({ file: `${r.file}#q${qi + 1}`, pass: q.error ? null : q.hit })))))
      console.log(`  tool across ${passesWanted} passes: [${stability.perPass.join(', ')}] · median ${stability.median} · stable-pass ${stability.stablePass} · flaky ${stability.flaky.length}${stability.flaky.length ? ` (${stability.flaky.join(', ')})` : ''}`)
      report.market = { passes: mkPasses, stability }
    } else {
      report.market = { summary: s, runs: mkPasses[0].runs }
    }
  }

  if (want.includes('orchestrate')) {
    const probe = await wb.runPython({ code: 'print(2 + 2)' })
    if (!probe.ok || !/^4/m.test(probe.stdout)) {
      throw new Error(`the Workbench sandbox is not working, so the orchestrate suite cannot be measured:\n  ${probe.error ?? probe.stdout}`)
    }
    console.log(
      `orchestrated vs independent (same weights, specialist personas, quant fixtures${process.env.EVAL_ORCH_LEAN === '1' ? '; LEAN orchestrator — roster only, no tools of its own' : ''})`
    )
    const { summarizeOrchestrate, stabilityAcrossPasses } = require('../src/renderer/src/lib/answerEval') as typeof import('../src/renderer/src/lib/answerEval')
    const orPasses: { runs: Awaited<ReturnType<typeof runOrchestrateSuite>> }[] = []
    for (let pass = 0; pass < passesWanted; pass++) {
      if (passesWanted > 1) console.log(`  — pass ${pass + 1}/${passesWanted} —`)
      orPasses.push({ runs: await runOrchestrateSuite(model) })
    }
    const s = summarizeOrchestrate(orPasses.flatMap((p) => p.runs))
    console.log(
      `\n  independent  ${s.independent.hit.hit}/${s.independent.hit.of} · ${s.independent.toolCallsPerCase.toFixed(1)} tool calls/case · ${s.independent.secondsPerCase.toFixed(0)} s/case`
    )
    console.log(
      `  orchestrated ${s.orchestrated.hit.hit}/${s.orchestrated.hit.of} · delegated on ${s.orchestrated.delegated.hit}/${s.orchestrated.delegated.of} cases (${s.orchestrated.consultsPerCase.toFixed(1)} consults/case) · ${s.orchestrated.toolCallsPerCase.toFixed(1)} tool calls/case · ${s.orchestrated.secondsPerCase.toFixed(0)} s/case`
    )
    if (s.whenDelegated.cases > 0) {
      console.log(
        `  on the ${s.whenDelegated.cases} delegated case(s): independent ${s.whenDelegated.independent.hit}/${s.whenDelegated.independent.of} vs orchestrated ${s.whenDelegated.orchestrated.hit}/${s.whenDelegated.orchestrated.of}\n`
      )
    }
    if (passesWanted > 1) {
      const stability = {
        independent: stabilityAcrossPasses(orPasses.map((p) => p.runs.map((r) => ({ file: r.file, pass: r.independent.error ? null : r.independent.hit })))),
        orchestrated: stabilityAcrossPasses(orPasses.map((p) => p.runs.map((r) => ({ file: r.file, pass: r.orchestrated.error ? null : r.orchestrated.hit }))))
      }
      for (const arm of ['independent', 'orchestrated'] as const) {
        const st = stability[arm]
        console.log(`  ${arm.padEnd(12)} across ${passesWanted} passes: [${st.perPass.join(', ')}] · median ${st.median} · stable-pass ${st.stablePass} · flaky ${st.flaky.length}${st.flaky.length ? ` (${st.flaky.join(', ')})` : ''}`)
      }
      report.orchestrate = { passes: orPasses, stability }
    } else {
      report.orchestrate = { summary: s, runs: orPasses[0].runs }
    }
  }

  if (want.includes('synthesis')) {
    const probe = await wb.runPython({ code: 'print(2 + 2)' })
    if (!probe.ok || !/^4/m.test(probe.stdout)) {
      throw new Error(`the Workbench sandbox is not working, so the synthesis suite cannot be measured:\n  ${probe.error ?? probe.stdout}`)
    }
    console.log('synthesis across specialists (CSV computation × policy retrieval, split capabilities)')
    const { summarizeOrchestrate, stabilityAcrossPasses } = require('../src/renderer/src/lib/answerEval') as typeof import('../src/renderer/src/lib/answerEval')
    const syPasses: { runs: Awaited<ReturnType<typeof runSynthesisSuite>> }[] = []
    for (let pass = 0; pass < passesWanted; pass++) {
      if (passesWanted > 1) console.log(`  — pass ${pass + 1}/${passesWanted} —`)
      syPasses.push({ runs: await runSynthesisSuite(model) })
    }
    const allRuns = syPasses.flatMap((p) => p.runs)
    const s = summarizeOrchestrate(allRuns)
    const crossed = allRuns.filter((r) => new Set(r.orchestrated.delegatedTo).size >= 2)
    console.log(
      `\n  independent  ${s.independent.hit.hit}/${s.independent.hit.of} · ${s.independent.toolCallsPerCase.toFixed(1)} tool calls/case · ${s.independent.secondsPerCase.toFixed(0)} s/case`
    )
    console.log(
      `  orchestrated ${s.orchestrated.hit.hit}/${s.orchestrated.hit.of} · delegated on ${s.orchestrated.delegated.hit}/${s.orchestrated.delegated.of} cases (${s.orchestrated.consultsPerCase.toFixed(1)} consults/case) · consulted 2+ distinct roles on ${crossed.length} · ${s.orchestrated.secondsPerCase.toFixed(0)} s/case`
    )
    if (s.whenDelegated.cases > 0) {
      console.log(
        `  on the ${s.whenDelegated.cases} delegated case(s): independent ${s.whenDelegated.independent.hit}/${s.whenDelegated.independent.of} vs orchestrated ${s.whenDelegated.orchestrated.hit}/${s.whenDelegated.orchestrated.of}\n`
      )
    }
    if (passesWanted > 1) {
      const stability = {
        independent: stabilityAcrossPasses(syPasses.map((p) => p.runs.map((r) => ({ file: r.file, pass: r.independent.error ? null : r.independent.hit })))),
        orchestrated: stabilityAcrossPasses(syPasses.map((p) => p.runs.map((r) => ({ file: r.file, pass: r.orchestrated.error ? null : r.orchestrated.hit }))))
      }
      for (const arm of ['independent', 'orchestrated'] as const) {
        const st = stability[arm]
        console.log(`  ${arm.padEnd(12)} across ${passesWanted} passes: [${st.perPass.join(', ')}] · median ${st.median} · stable-pass ${st.stablePass} · flaky ${st.flaky.length}${st.flaky.length ? ` (${st.flaky.join(', ')})` : ''}`)
      }
      report.synthesis = { passes: syPasses, stability }
    } else {
      report.synthesis = { summary: s, runs: syPasses[0].runs }
    }
  }

  if (want.includes('research')) {
    console.log('deep research under the ladder (checked vs unchecked, fixture corpus)')
    const { summarizeResearch, stabilityAcrossPasses } = require('../src/renderer/src/lib/answerEval') as typeof import('../src/renderer/src/lib/answerEval')
    const rsPasses: { summary: ReturnType<typeof summarizeResearch>; runs: Awaited<ReturnType<typeof runResearchSuite>> }[] = []
    for (let pass = 0; pass < passesWanted; pass++) {
      if (passesWanted > 1) console.log(`  — pass ${pass + 1}/${passesWanted} —`)
      const runs = await runResearchSuite(model)
      rsPasses.push({ summary: summarizeResearch(runs), runs })
    }
    const s = summarizeResearch(rsPasses.flatMap((p) => p.runs))
    const line = (label: string, a: typeof s.unchecked): string =>
      `  ${label.padEnd(9)} ran ${a.ran.hit}/${a.ran.of} · complete ${a.complete.hit}/${a.complete.of} · stated a decoy ${a.statedDecoy.hit}/${a.statedDecoy.of}` +
      ` · unsupported figure ${a.unsupported.hit}/${a.unsupported.of} · fabricated citation ${a.fabricatedCitation.hit}/${a.fabricatedCitation.of} · ${a.secondsPerCase.toFixed(0)} s/case`
    console.log('\n' + line('checked', s.checked) + `\n            (rung flagged the first draft in ${s.checked.flaggedFirstDraft.hit}/${s.checked.flaggedFirstDraft.of}; revision kept in ${s.checked.revised.hit}/${s.checked.revised.of})\n` + line('unchecked', s.unchecked))
    for (const regime of ['clean', 'thin'] as const) {
      const r = s.byRegime[regime]
      if (r.cases === 0) continue
      console.log(`  — ${regime} corpus (${r.cases} case-run(s)) —\n` + line('checked', r.checked) + `\n            (flagged ${r.checked.flaggedFirstDraft.hit}/${r.checked.flaggedFirstDraft.of}; revised ${r.checked.revised.hit}/${r.checked.revised.of})\n` + line('unchecked', r.unchecked))
    }
    console.log('')
    if (passesWanted > 1) {
      const clean = (a: import('../src/renderer/src/lib/answerEval').ResearchArmResult): boolean | null =>
        a.error ? null : a.ok && a.factsStated === a.factsOf && a.decoysStated.length === 0 && a.unsupportedFigures === 0 && a.badCitations === 0
      const stability = {
        checked: stabilityAcrossPasses(rsPasses.map((p) => p.runs.map((r) => ({ file: r.file, pass: clean(r.checked) })))),
        unchecked: stabilityAcrossPasses(rsPasses.map((p) => p.runs.map((r) => ({ file: r.file, pass: clean(r.unchecked) }))))
      }
      for (const arm of ['checked', 'unchecked'] as const) {
        const st = stability[arm]
        console.log(`  ${arm.padEnd(9)} clean across ${passesWanted} passes: [${st.perPass.join(', ')}] · median ${st.median} · stable-pass ${st.stablePass} · flaky ${st.flaky.length}${st.flaky.length ? ` (${st.flaky.join(', ')})` : ''}`)
      }
      report.research = { passes: rsPasses, stability }
    } else {
      report.research = { summary: s, runs: rsPasses[0].runs }
    }
  }

  if (want.includes('reasoning')) {
    console.log('reasoning: draft vs draft + one think-harder pass (self-review, no tools)')
    const { summarizeReasoning, stabilityAcrossPasses } = require('../src/renderer/src/lib/answerEval') as typeof import('../src/renderer/src/lib/answerEval')
    const rnPasses: { runs: Awaited<ReturnType<typeof runReasoningSuite>> }[] = []
    for (let pass = 0; pass < passesWanted; pass++) {
      if (passesWanted > 1) console.log(`  — pass ${pass + 1}/${passesWanted} —`)
      rnPasses.push({ runs: await runReasoningSuite(model) })
    }
    const s = summarizeReasoning(rnPasses.flatMap((p) => p.runs))
    console.log(
      `\n  draft correct        ${s.draftCorrect.hit}/${s.draftCorrect.of}\n` +
        `  after review         ${s.finalCorrect.hit}/${s.finalCorrect.of}\n` +
        `  review FIXED a wrong draft   ${s.fixed.hit}/${s.fixed.of}\n` +
        `  review BROKE a right draft   ${s.broke.hit}/${s.broke.of}\n` +
        `  reviewer found problems      ${s.reviewFoundProblems.hit}/${s.reviewFoundProblems.of} · revised ${s.revised.hit}/${s.revised.of}\n` +
        `  ${s.secondsDraft.toFixed(1)} s draft · +${s.secondsReview.toFixed(1)} s for the pass (${(1 + s.secondsReview / Math.max(0.1, s.secondsDraft)).toFixed(1)}x)\n`
    )
    if (passesWanted > 1) {
      const stability = {
        draft: stabilityAcrossPasses(rnPasses.map((p) => p.runs.map((r) => ({ file: r.file, pass: r.error ? null : r.draft.correct })))),
        final: stabilityAcrossPasses(rnPasses.map((p) => p.runs.map((r) => ({ file: r.file, pass: r.error ? null : r.final.correct }))))
      }
      for (const arm of ['draft', 'final'] as const) {
        const st = stability[arm]
        console.log(`  ${arm.padEnd(6)} across ${passesWanted} passes: [${st.perPass.join(', ')}] · median ${st.median} · stable-pass ${st.stablePass} · flaky ${st.flaky.length}${st.flaky.length ? ` (${st.flaky.join(', ')})` : ''}`)
      }
      report.reasoning = { passes: rnPasses, stability, summary: s }
    } else {
      report.reasoning = { summary: s, runs: rnPasses[0].runs }
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outFile = join(RESULTS_DIR, `answers-${model.replace(/[^a-z0-9._-]+/gi, '_')}-${stamp}.json`)
  writeFileSync(outFile, JSON.stringify(report, null, 2))
  console.log(`results: ${outFile}`)
  setTimeout(() => app.exit(0), 200)
}

const wb = require('../src/main/ipc/workbench') as typeof import('../src/main/ipc/workbench')
wb.registerWorkbenchScheme()
app.on('window-all-closed', () => undefined)
app.whenReady().then(() =>
  main().catch((err) => {
    console.error('EVAL ERROR:', err)
    setTimeout(() => app.exit(1), 200)
  })
)
