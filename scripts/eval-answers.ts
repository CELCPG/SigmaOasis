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
 *                                  'multiturn' — v1.8 sessions vs stateless — is opt-in)
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
      ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {})
    })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
  const json = (await res.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] } }[]
  }
  const { parseCompletionMessage } = require('../src/renderer/src/lib/evalRunner') as typeof import('../src/renderer/src/lib/evalRunner')
  const parsed = parseCompletionMessage(json.choices?.[0]?.message ?? {})
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

      for (const [ti, turn] of fx.turns.entries()) {
        const dataNote = ti === 0 ? `\n\n[Attached file: ${fx.data} — available to run_python and analyze_file at /work/${fx.data}]` : ''
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
        const turnContext = buildTurnContext(armPlaybook ? [buildPlaybookContext(armPlaybook)] : [])
        messages.push({ role: 'user', content: `${turn.prompt}${dataNote}${turnContext ?? ''}` })
        const t0 = Date.now()
        let toolCalls = 0
        let reread = false
        const rounds: string[] = []
        try {
          await runAgentLoop({
            messages: messages as never,
            tools,
            records: [],
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
            reply: reply.slice(0, 1200)
          })
        } catch (err) {
          messages.push({ role: 'assistant', content: '(error)' })
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
        await runAgentLoop({
          messages: messages as never,
          tools: wbTools,
          records: [],
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
        '  EVAL_SUITES=library,quant,deliberate,multiturn   EVAL_CASES=1-5   EVAL_PASSES=3'
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
    const s = allPasses[0].summary
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
    const s = quantPasses[0].summary
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
    const s = mtPasses[0].summary
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
