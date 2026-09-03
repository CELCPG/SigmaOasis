/**
 * v2.6: the `claims` suite — does verification compound?
 *
 * Twenty factual questions about six fictional entities, each answerable only
 * from a fixture page served by a loopback server (the research suite's seam:
 * SIGMA_RESEARCH_FIXTURE_ORIGIN). Every question is asked twice, in two fresh
 * conversations. The first ask is the app as it was: an app-run web search,
 * then the model with web tools. The second ask is what the fact ledger is
 * for: the claim the first ask verified should be recalled with its date,
 * the search skipped, and — on the six price cases, whose page changed and
 * whose entry expired in between — the contradiction surfaced rather than
 * the cached answer repeated.
 *
 * Two arms: `bare` (no ledger — the v2.5 app) and `ledger` (the v2.6 app).
 * The numbers that must move: searches and seconds on the second ask. The
 * number that must not: answered-correctly on either ask.
 *
 * Mechanical throughout. Nothing here asks a model to grade a model.
 */
import http from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClaimsArm, ClaimsAskResult, ClaimsCaseResult } from '../../src/renderer/src/lib/answerEval'
import type { ToolCallRecord } from '../../src/renderer/src/types'

export interface ClaimsFixture {
  file: string
  question: string
  page: string
  claimClass: string
  freshness: 'hours' | 'months' | 'years' | 'never'
  mustInclude: string[]
  v2?: { mustInclude: string[]; changed: true }
}

type Msg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: unknown; tool_call_id?: string }

export interface ClaimsDeps {
  repoRoot: string
  persona: string
  arms: ClaimsArm[]
  slice<T>(items: T[]): T[]
  loadJson<T>(dir: string): (T & { file: string })[]
  complete(
    model: string,
    messages: Msg[],
    tools?: unknown[]
  ): Promise<{ content: string; toolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[]; finishReason?: string }>
}

const HOUR = 3_600_000

export async function runClaimsSuite(model: string, deps: ClaimsDeps): Promise<ClaimsCaseResult[]> {
  const CLAIMS_DIR = join(deps.repoRoot, 'test', 'fixtures', 'claims')
  const loadCorpus = (dir: string): { file: string; title: string; html: string; text: string }[] =>
    readdirSync(join(CLAIMS_DIR, dir))
      .filter((f) => f.endsWith('.html'))
      .map((f) => {
        const html = readFileSync(join(CLAIMS_DIR, dir, f), 'utf-8')
        const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? f
        const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase()
        return { file: f, title, html, text }
      })
  const corpus = { 1: loadCorpus('corpus-v1'), 2: loadCorpus('corpus-v2') }
  let activeVersion: 1 | 2 = 1

  // Keyword-match search over the active version, SearXNG-shaped, exactly as
  // the research suite serves its corpus.
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    const pages = corpus[activeVersion]
    if (u.pathname === '/search') {
      const q = (u.searchParams.get('q') ?? '').toLowerCase()
      const terms = q.split(/[^a-z0-9%.]+/).filter((t) => t.length >= 3)
      const scored = pages
        .map((p) => ({ p, score: terms.filter((t) => p.text.includes(t)).length }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 6)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ results: scored.map(({ p }) => ({ title: p.title, url: `${origin}/${p.file}`, content: p.text.slice(0, 300) })) }))
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
  const port = (server.address() as { port: number }).port
  const origin = `http://127.0.0.1:${port}`
  process.env.SIGMA_RESEARCH_FIXTURE_ORIGIN = origin

  const storeMod = require('../../src/main/ipc/store') as typeof import('../../src/main/ipc/store')
  const prev = storeMod.getSettings()
  storeMod.writeSettings({
    ...prev,
    search: { ...prev.search, provider: 'searxng', searxngUrl: origin, confirmBeforeSearch: false }
  })

  const lib = require('../../src/main/ipc/library') as typeof import('../../src/main/ipc/library')
  const registry = require('../../src/main/ipc/toolHandlers/registry') as typeof import('../../src/main/ipc/toolHandlers/registry')
  const { withGrounding, buildTurnContext, stripTurnNotesEcho } = require('../../src/renderer/src/lib/grounding') as typeof import('../../src/renderer/src/lib/grounding')
  const { runAgentLoop } = require('../../src/renderer/src/lib/agentLoop') as typeof import('../../src/renderer/src/lib/agentLoop')
  const { gatherTurnContext } = require('../../src/renderer/src/lib/contextProviders') as typeof import('../../src/renderer/src/lib/contextProviders')
  const { autoSearchProvider } = require('../../src/renderer/src/lib/contextProviders/autoSearch') as typeof import('../../src/renderer/src/lib/contextProviders/autoSearch')
  const { TOOL_SCHEMAS } = require('../../src/shared/tools') as typeof import('../../src/shared/tools')
  const webTools = TOOL_SCHEMAS.filter((t) => t.function.name === 'web_search' || t.function.name === 'fetch_webpage')

  // The ledger arm's modules are required lazily so the bare arm runs on a
  // tree that has no ledger yet — that is how the baseline was measured.
  type LedgerMain = typeof import('../../src/main/ipc/factLedger')
  type LedgerLib = typeof import('../../src/renderer/src/lib/factLedger')
  type LedgerProvider = typeof import('../../src/renderer/src/lib/contextProviders/factLedger')
  let ledgerMain: LedgerMain | null = null
  let ledgerLib: LedgerLib | null = null
  let ledgerProvider: LedgerProvider | null = null
  if (deps.arms.includes('ledger')) {
    ledgerMain = require('../../src/main/ipc/factLedger') as LedgerMain
    ledgerLib = require('../../src/renderer/src/lib/factLedger') as LedgerLib
    ledgerProvider = require('../../src/renderer/src/lib/contextProviders/factLedger') as LedgerProvider
  }

  // A library of its own per run: the ledger is a pack, and the user's must
  // never be touched.
  const libDir = mkdtempSync(join(tmpdir(), 'sigma-claims-'))
  lib.setLibraryDirForTests(libDir)

  const fixtures = deps.slice(deps.loadJson<ClaimsFixture>(join(CLAIMS_DIR, 'cases')))
  const results: ClaimsCaseResult[] = []

  const ask = async (arm: ClaimsArm, fx: ClaimsFixture, second: boolean, nowMs: number): Promise<ClaimsAskResult> => {
    activeVersion = second && fx.v2 ? 2 : 1
    process.env.SIGMA_LEDGER_NOW = String(nowMs)
    const t0 = Date.now()
    const out: ClaimsAskResult = { searches: 0, fetches: 0, ms: 0, answered: false, ledger: null, contradiction: false, reply: '' }
    const records: ToolCallRecord[] = []
    const patched: Record<string, unknown> = {}
    const ctx = { sender: null as never, tainted: false }
    let n = 0
    const note = (name: string): void => {
      if (name === 'web_search') out.searches += 1
      if (name === 'fetch_webpage') out.fetches += 1
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
        ...(ledgerMain ? { ledgerLookup: (query: string) => ledgerMain!.lookupLedger(query) } : {})
      },
      patch(p: Record<string, unknown>) {
        Object.assign(patched, p)
      },
      settings: () => storeMod.getSettings()
    }
    const input = {
      convo: { id: `claims-${fx.file}-${second ? 2 : 1}`, messages: [], memorySources: null },
      conversations: [],
      slot: { id: 'eval', roleName: 'Assistant', modelId: model, temperature: 0 },
      slotTools: webTools,
      lastUserContent: fx.question,
      previousUserContent: undefined,
      offline: false,
      factualTurn: true,
      referenceTurn: false,
      shoppingTurn: false,
      project: null,
      assistantMsgId: 'a',
      signal: new AbortController().signal
    }
    const providers = arm === 'ledger' && ledgerProvider ? [ledgerProvider.factLedgerProvider, autoSearchProvider] : [autoSearchProvider]
    const gathered = await gatherTurnContext(providers, input as never, io as never)
    const turnContext = buildTurnContext(gathered.blocks)
    const messages: Msg[] = [
      { role: 'system', content: withGrounding(deps.persona) },
      { role: 'user', content: `${fx.question}${turnContext ?? ''}` }
    ]
    const rounds: string[] = []
    await runAgentLoop({
      messages: messages as never,
      tools: webTools,
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
    out.reply = reply.slice(0, 1500)
    const expected = second && fx.v2 ? fx.v2.mustInclude : fx.mustInclude
    out.answered = expected.every((p) => new RegExp(p, 'i').test(reply))
    out.ledger = (patched.ledgerContext as ClaimsAskResult['ledger']) ?? null
    if (arm === 'ledger' && ledgerMain && ledgerLib) {
      // The app's own capture: what the grounding pass bound to a source is
      // written; what it could not bind is not.
      const drafts = ledgerLib.extractLedgerEntries(reply, records, fx.question)
      const written = await ledgerMain.upsertClaims(drafts)
      out.contradiction = written.superseded.length > 0
      out.captured = written.written.length
    }
    out.ms = Date.now() - t0
    return out
  }

  try {
    for (const [i, fx] of fixtures.entries()) {
      const caseOut: ClaimsCaseResult = {
        file: fx.file,
        question: fx.question,
        claimClass: fx.claimClass,
        freshness: fx.freshness,
        changed: fx.v2?.changed === true,
        arms: {}
      }
      for (const arm of deps.arms) {
        const base = Date.now()
        try {
          const first = await ask(arm, fx, false, base)
          // The second ask is an hour later, or a day and two hours later
          // when the page changed — past a price's freshness, so a ledger
          // that re-checks has something to disagree with.
          const second = await ask(arm, fx, true, base + (fx.v2 ? 26 * HOUR : HOUR))
          caseOut.arms[arm] = { first, second }
        } catch (err) {
          caseOut.arms[arm] = { error: err instanceof Error ? err.message : String(err) }
        }
        const a = caseOut.arms[arm]!
        const line = a.error
          ? `! ${a.error.slice(0, 80)}`
          : `ask1 ${a.first!.answered ? '✓' : '✗'} ${a.first!.searches}s/${a.first!.fetches}f ${(a.first!.ms / 1000).toFixed(0)}s · ` +
            `ask2 ${a.second!.answered ? '✓' : '✗'} ${a.second!.searches}s/${a.second!.fetches}f ${(a.second!.ms / 1000).toFixed(0)}s` +
            (arm === 'ledger' ? ` · ledger ${a.second!.ledger ? (a.second!.ledger.expired ? 'expired' : 'hit') : 'miss'}${caseOut.changed ? ` · contradiction ${a.second!.contradiction ? 'surfaced' : 'MISSED'}` : ''}` : '')
        process.stdout.write(`  ${fx.file.padEnd(28)} [${arm.padEnd(6)}] ${line}  [${i + 1}/${fixtures.length}]\n`)
      }
      results.push(caseOut)
    }
  } finally {
    delete process.env.SIGMA_LEDGER_NOW
    delete process.env.SIGMA_RESEARCH_FIXTURE_ORIGIN
    storeMod.writeSettings(prev)
    server.close()
    rmSync(libDir, { recursive: true, force: true })
  }
  return results
}
