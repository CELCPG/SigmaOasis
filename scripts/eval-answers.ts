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
 *   EVAL_SUITES=quant,deliberate   pick suites (default: all)
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
  mustNotInclude?: string[]
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

async function complete(
  model: string,
  messages: Msg[],
  tools?: unknown[]
): Promise<{ content: string; toolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }> {
  const res = await fetch(`${BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(300_000),
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
        mustNotInclude: fx.mustNotInclude,
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
  return async (name: string, args: Record<string, unknown>, attachments: { name: string; sourcePath: string }[]) => {
    const handler = (workbenchHandlers as Record<string, ((a: Record<string, unknown>, c: unknown) => Promise<{ ok: boolean; output?: string; error?: string }>) | undefined>)[name]
    if (!handler) return { ok: false, error: `Unknown tool "${name}"` }
    void dataDir
    return handler(args, { sender: {} as never, modelId: '', attachments })
  }
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
      replies: {}
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
        let final = ''
        await runAgentLoop({
          messages: messages as never,
          tools: wbTools,
          records: [],
          signal: new AbortController().signal,
          deps: {
            streamRound: async (msgs, tools) => {
              const r = await complete(model, msgs as never, tools)
              final = r.content || final
              return { content: r.content, toolCalls: r.toolCalls }
            },
            executeTool: async (name, args) => {
              toolCalls += 1
              return exec(name, args, attachments)
            }
          }
        })
        out.replies!.workbench = final.slice(0, 1500)
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
        '  EVAL_SUITES=library,quant,deliberate   EVAL_CASES=1-5'
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

  if (want.includes('library')) {
    console.log('library grounding')
    const runs = await runLibrarySuite(model)
    const s = summarizeLibrary(runs)
    console.log(
      `\n  retrieved passages   ${s.retrieved.hit}/${s.retrieved.of}  ${pct(s.retrieved)}\n` +
        `  answered             ${s.answered.hit}/${s.answered.of}  ${pct(s.answered)}\n` +
        `  cited the source     ${s.cited.hit}/${s.cited.of}  ${pct(s.cited)}\n` +
        `  unsupported figures  ${s.unsupported.hit}/${s.unsupported.of}  ${pct(s.unsupported)}  (lower is better)\n` +
        `  ${s.seconds.toFixed(1)} s/case\n`
    )
    report.library = { summary: s, runs }
  }

  if (want.includes('quant') || want.includes('deliberate')) {
    console.log('quantitative' + (want.includes('deliberate') ? ' + deliberation' : ''))
    const runs = await runQuantSuite(model, { workbench: want.includes('quant'), deliberate: want.includes('deliberate') })
    const s = summarizeQuant(runs)
    console.log(
      `\n  bare (no tools)      ${s.bare.hit}/${s.bare.of}  ${pct(s.bare)}   ${s.seconds.bare.toFixed(1)} s/case\n` +
        (want.includes('quant')
          ? `  with the Workbench   ${s.workbench.hit}/${s.workbench.of}  ${pct(s.workbench)}   ${s.seconds.workbench.toFixed(1)} s/case\n`
          : '') +
        (want.includes('deliberate')
          ? `  bare + think harder  ${s.deliberated.hit}/${s.deliberated.of}  ${pct(s.deliberated)}   ${s.seconds.deliberated.toFixed(1)} s/case\n`
          : '')
    )
    report.quant = { summary: s, runs }
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
