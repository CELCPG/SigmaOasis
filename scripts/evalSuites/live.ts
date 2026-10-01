/**
 * v4.1 (M5): the `live` suite — questions about the live world, answered
 * from dated loopback pages (`EVAL_SUITES=live npm run eval:answers`).
 *
 * Six questions about fictional places and markets: the weather today or
 * tomorrow, last night's score, the next game, a futures quote this morning.
 * A loopback server serves each case's page — a small table with one row per
 * day, dated from the clock when the suite runs — and a SearXNG-shaped search
 * over them (the research suite's seam, SIGMA_RESEARCH_FIXTURE_ORIGIN).
 *
 * v4.3: the model is shown the pages under an ordinary HTTPS address, LIVE_ALIAS,
 * which the seam maps to the loopback server (SIGMA_RESEARCH_FIXTURE_ALIAS,
 * src/main/ipc/fixtureSeam.ts). Through 4.2 it was shown http://127.0.0.1:<port>,
 * and after reading fetch_webpage's own "HTTPS only, private addresses refused"
 * it declined to fetch: in three passes on 2026-10-01, 7 of the 8 misses said
 * the results were local pages. The suite measured its fixture, not the model.
 *
 * The turn is built as the chat builds it, minus the window: the slot's tools
 * ranked (here with no ranking at all — the worst case, where only the forced
 * tools can put the web on the wire), `webToolsForTurn` forcing the web tools,
 * budget notes on, the ledger provider ahead of the app-run search. The ledger
 * is handed a planted entry carrying the wrong day's figure, so a ledger that
 * rode a live turn would be seen answering with it.
 *
 * Scored in src/renderer/src/lib/liveEval.ts: web tools on the wire, the
 * search ran, a page was read, the day asked's figure in the reply and no
 * other day's in its place, any date named the right one, no ledger answer.
 * Mechanical throughout.
 */
import http from 'node:http'
import { join } from 'node:path'
import type { LiveCaseResult, LiveFixture } from '../../src/renderer/src/lib/liveEval'
import type { ToolCallRecord } from '../../src/renderer/src/types'
import type { LedgerHit } from '../../src/shared/factLedger'

type Msg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: unknown; tool_call_id?: string }

/**
 * The address the model sees. A fictional local paper for the suite's fictional
 * towns; never resolved and never contacted — the seam sends every request for
 * it to the loopback server, and the headless renderer refuses it.
 */
export const LIVE_ALIAS = 'https://www.harrowgate-dunmore-courier.com'

export interface LiveDeps {
  repoRoot: string
  persona: string
  slice<T>(items: T[]): T[]
  loadJson<T>(dir: string): (T & { file: string })[]
  complete(
    model: string,
    messages: Msg[],
    tools?: unknown[]
  ): Promise<{ content: string; toolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[]; finishReason?: string }>
}

export async function runLiveSuite(model: string, deps: LiveDeps): Promise<LiveCaseResult[]> {
  const { renderLivePage, scoreLiveAnswer, dayOf, longDate } = require('../../src/renderer/src/lib/liveEval') as typeof import('../../src/renderer/src/lib/liveEval')
  const fixtures = deps.slice(deps.loadJson<LiveFixture>(join(deps.repoRoot, 'test', 'fixtures', 'live', 'cases')))
  const now = new Date()
  const pages = fixtures.map((fx) => {
    const html = renderLivePage(fx, now)
    return { file: fx.page, title: fx.title, html, text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase() }
  })

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (u.pathname === '/search') {
      const q = (u.searchParams.get('q') ?? '').toLowerCase()
      const terms = q.split(/[^a-z0-9%.]+/).filter((t) => t.length >= 3)
      const scored = pages
        .map((p) => ({ p, score: terms.filter((t) => p.text.includes(t)).length }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 6)
      // A snippet is the page's header, not its table: the figure is on the page, so the page must be read.
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ results: scored.map(({ p }) => ({ title: p.title, url: `${LIVE_ALIAS}/${p.file}`, content: `${p.title}. Updated daily.` })) }))
      return
    }
    const page = pages.find((p) => `/${p.file}` === u.pathname)
    if (!page) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(page.html)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.SIGMA_RESEARCH_FIXTURE_ORIGIN = origin
  process.env.SIGMA_RESEARCH_FIXTURE_ALIAS = LIVE_ALIAS

  const storeMod = require('../../src/main/ipc/store') as typeof import('../../src/main/ipc/store')
  const prev = storeMod.getSettings()
  storeMod.writeSettings({
    ...prev,
    search: { ...prev.search, provider: 'searxng', searxngUrl: origin, confirmBeforeSearch: false },
    grounding: { ...prev.grounding, factLedger: true }
  })

  const search = require('../../src/main/ipc/search') as typeof import('../../src/main/ipc/search')
  const researchIndex = require('../../src/main/ipc/researchIndex') as typeof import('../../src/main/ipc/researchIndex')
  const registry = require('../../src/main/ipc/toolHandlers/registry') as typeof import('../../src/main/ipc/toolHandlers/registry')
  const { withGrounding, buildTurnContext, stripTurnNotesEcho, looksFactual, webToolsForTurn } = require('../../src/renderer/src/lib/grounding') as typeof import('../../src/renderer/src/lib/grounding')
  const { selectTurnTools, withForcedTools, withBudgetNotes } = require('../../src/renderer/src/lib/toolSelection') as typeof import('../../src/renderer/src/lib/toolSelection')
  const { runAgentLoop } = require('../../src/renderer/src/lib/agentLoop') as typeof import('../../src/renderer/src/lib/agentLoop')
  const { gatherTurnContext } = require('../../src/renderer/src/lib/contextProviders') as typeof import('../../src/renderer/src/lib/contextProviders')
  const { autoSearchProvider } = require('../../src/renderer/src/lib/contextProviders/autoSearch') as typeof import('../../src/renderer/src/lib/contextProviders/autoSearch')
  const { factLedgerProvider } = require('../../src/renderer/src/lib/contextProviders/factLedger') as typeof import('../../src/renderer/src/lib/contextProviders/factLedger')
  const { TOOL_SCHEMAS, TOOL_TURN_BUDGETS } = require('../../src/shared/tools') as typeof import('../../src/shared/tools')
  const slotTools = TOOL_SCHEMAS.filter((t) => t.function.name !== 'run_code')

  const results: LiveCaseResult[] = []
  try {
    for (const [i, fx] of fixtures.entries()) {
      search.clearSearchCache()
      researchIndex.clearResearchIndex()
      const t0 = Date.now()
      let searches = 0
      let fetches = 0
      const records: ToolCallRecord[] = []
      const patched: Record<string, unknown> = {}
      let n = 0
      const note = (name: string): void => {
        if (name === 'web_search') searches++
        if (name === 'fetch_webpage') fetches++
      }
      const ctx = { sender: null as never, tainted: false }
      // The planted entry: yesterday's check, the wrong row's figure. Served only if the gate fails.
      const wrong = fx.rows.find((r) => r.day !== fx.answerDay)!
      const planted: LedgerHit = {
        key: `measurement|${fx.question}`,
        claimClass: 'measurement',
        value: wrong.text,
        sentence: `${wrong.text} (${longDate(dayOf(now, wrong.day))})`,
        url: `${LIVE_ALIAS}/${fx.page}`,
        checkedAt: dayOf(now, -1).getTime(),
        expiresAt: dayOf(now, 700).getTime(),
        expired: false,
        score: 1
      }
      const io = {
        async runTool(name: string, args: Record<string, unknown>) {
          const r = await registry.executeTool(name, args, ctx)
          note(name)
          records.push({ id: `p${++n}`, name, args, status: r.ok ? 'done' : 'error', result: r.ok ? (r.output ?? '') : (r.error ?? '') })
          return r
        },
        recordSyntheticCall(name: string, args: Record<string, unknown>, output: string) {
          records.push({ id: `s${++n}`, name, args, status: 'done', result: output })
        },
        api: {
          memorySearch: async () => ({ ok: false, results: [] }),
          libraryLookup: async () => ({ ok: false, passages: [], mode: 'none' }),
          attachmentPassages: async () => ({ ok: false, passages: [] }),
          projectRecall: async () => ({ ok: false, passages: [] }),
          ledgerLookup: async () => ({ ok: true, hits: [planted] })
        },
        patch(p: Record<string, unknown>) {
          Object.assign(patched, p)
        },
        settings: () => storeMod.getSettings()
      }
      const input = {
        convo: { id: `live-${fx.file}`, messages: [], memorySources: null },
        conversations: [],
        slot: { id: 'eval', roleName: 'Assistant', modelId: model, temperature: 0 },
        slotTools,
        lastUserContent: fx.question,
        previousUserContent: undefined,
        offline: false,
        factualTurn: looksFactual(fx.question),
        referenceTurn: false,
        shoppingTurn: false,
        project: null,
        assistantMsgId: 'a',
        signal: new AbortController().signal
      }
      const out: LiveCaseResult = { file: fx.file, kind: fx.kind, question: fx.question }
      try {
        const wire = withBudgetNotes(withForcedTools(slotTools, selectTurnTools(slotTools, {}), webToolsForTurn(fx.question)), TOOL_TURN_BUDGETS)
        const gathered = await gatherTurnContext([factLedgerProvider, autoSearchProvider], input as never, io as never)
        const turnContext = buildTurnContext(gathered.blocks)
        const messages: Msg[] = [
          { role: 'system', content: withGrounding(deps.persona, now) },
          { role: 'user', content: `${fx.question}${turnContext ?? ''}` }
        ]
        const rounds: string[] = []
        await runAgentLoop({
          messages: messages as never,
          tools: wire,
          records,
          signal: input.signal,
          deps: {
            streamRound: async (msgs, tls) => {
              const r = await deps.complete(model, msgs as never, tls)
              if (r.content.trim()) rounds.push(r.content)
              return { content: r.content, toolCalls: r.toolCalls }
            },
            executeTool: async (name, args) => {
              const r = await registry.executeTool(name, args, ctx)
              note(name)
              return r
            }
          }
        })
        const reply = stripTurnNotesEcho(rounds.join('\n\n')).text
        const ask = { reply, wireTools: wire.map((t) => t.function.name), searches, fetches, ledgerServed: patched.ledgerContext !== undefined }
        out.score = scoreLiveAnswer(fx, ask, now)
        out.ask = { ...ask, reply: reply.slice(0, 1500), ms: Date.now() - t0 }
      } catch (err) {
        out.error = err instanceof Error ? err.message : String(err)
      }
      results.push(out)
      const s = out.score
      process.stdout.write(
        `  ${s?.pass ? '✓' : '✗'} ${fx.file.padEnd(34)} ` +
          (s
            ? `wire ${s.webToolsOnWire ? 'web' : 'NO WEB'} · ${searches}s/${fetches}f · ${s.answered ? 'answered' : s.wrongDay ? 'WRONG DAY' : 'no answer'}${s.answered && !s.dateCorrect ? ' · wrong date named' : ''}${s.noLedger ? '' : ' · LEDGER'} · ${((out.ask?.ms ?? 0) / 1000).toFixed(0)}s`
            : `! ${out.error?.slice(0, 80)}`) +
          `  [${i + 1}/${fixtures.length}]\n`
      )
    }
  } finally {
    delete process.env.SIGMA_RESEARCH_FIXTURE_ORIGIN
    delete process.env.SIGMA_RESEARCH_FIXTURE_ALIAS
    storeMod.writeSettings(prev)
    server.close()
  }
  return results
}
