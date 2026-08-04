/**
 * Layer 4 demo harness — one live session, end to end, with no GUI.
 *
 * Runs three real turns against the locally loaded LM Studio model through
 * the shipped agent loop, recording every step into the shipped encrypted
 * audit log, then exports fine-tuning traces through the same code path as
 * the in-app "Export traces (SFT)" button (main/ipc/traces.ts), minus the
 * save dialog.
 *
 * Everything is sandboxed: a throwaway userData dir (/tmp/oasis-live-userdata)
 * with the audit setting pre-enabled, so the real app's settings, logs, and
 * conversations are untouched. Local tools execute for real (datetime,
 * arithmetic, a sandboxed directory listing); network tools refuse offline so
 * the demo also produces an honest rejected trace.
 *
 * Run:  bash scripts/live-trace-session.sh [model-id]
 * (defaults to the 4B agentic model; LM Studio must be running)
 */

import { app } from 'electron'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ApiMessage, StreamRoundResult } from '../src/renderer/src/lib/agentLoop'
import { runAgentLoop } from '../src/renderer/src/lib/agentLoop'
import { parseCompletionMessage } from '../src/renderer/src/lib/evalRunner'
import { withGrounding, withToolCallPreamble } from '../src/renderer/src/lib/grounding'
import { TOOL_SCHEMAS } from '../src/main/ipc/toolSchemas'
import type { ToolCallRecord } from '../src/renderer/src/types'

const USER_DATA = '/tmp/oasis-live-userdata'
const OUT_DIR = join(__dirname, '..', '..', '.traces', 'live-session')
const SANDBOX_DIR = join(USER_DATA, 'sandbox')
const CONVERSATION_ID = 'live-demo'
const MODEL =
  process.argv[2] ?? 'gemma-4-e4b-agentic-sol-fable-reasoning-geminicli'
const BASE_URL = 'http://127.0.0.1:1234/v1'

/** The wire list for the demo: local tools that can really run, plus web_search to demonstrate a refused/rejected trace. */
const WIRE_NAMES = ['get_current_datetime', 'finance_calculator', 'list_directory', 'web_search']

// userData must be redirected before store.ts (imported lazily below) reads it.
app.setPath('userData', USER_DATA)
mkdirSync(SANDBOX_DIR, { recursive: true })
writeFileSync(join(SANDBOX_DIR, 'prices.txt'), 'apples 1.20\nbread 2.50\ncoffee 8.90\n')
writeFileSync(join(SANDBOX_DIR, 'todo.txt'), '- water the plants\n- renew library books\n')
// Seed settings: audit log on. The store merges these over its defaults.
writeFileSync(
  join(USER_DATA, 'config.json'),
  JSON.stringify({ settings: { audit: { enabled: true, autoPurgeOnQuit: false } } })
)

interface ToolResult {
  ok: boolean
  output?: string
  error?: string
}

/** Real, local, offline tool implementations for the demo's wire list. */
async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'get_current_datetime':
      return { ok: true, output: new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'long' }) }
    case 'finance_calculator': {
      const expr = String(args.expression ?? '')
      if (!/^[\d\s+\-*/%.()]+$/.test(expr) || expr.length > 120) {
        return { ok: false, error: `Refused expression: ${expr.slice(0, 60)}` }
      }
      try {
        // eslint-disable-next-line no-new-func
        const value = Function(`"use strict"; return (${expr})`)() as number
        return { ok: true, output: `${expr} = ${value}` }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
    case 'list_directory': {
      const p = String(args.path ?? '')
      if (!p.startsWith(SANDBOX_DIR)) {
        return { ok: false, error: `This demo sandbox only serves ${SANDBOX_DIR}` }
      }
      return { ok: true, output: readdirSync(p).join('\n') }
    }
    case 'web_search':
      return { ok: false, error: 'offline demo harness — no network egress' }
    default:
      return { ok: false, error: `Tool "${name}" is not available in this harness.` }
  }
}

/** The caller owns the final answer text — the loop returns 'completed' without appending it to the wire history. */
let lastRoundContent = ''

async function complete(messages: ApiMessage[]): Promise<StreamRoundResult> {
  const tools = TOOL_SCHEMAS.filter((t) => WIRE_NAMES.includes(t.function.name))
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({ model: MODEL, messages, stream: false, temperature: 0, tools, tool_choice: 'auto' })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = (await res.json()) as { choices?: { message?: unknown }[] }
  const parsed = parseCompletionMessage(json.choices?.[0]?.message ?? {})
  console.log(`  [round] content=${JSON.stringify(parsed.content.slice(0, 80))} calls=${JSON.stringify(parsed.toolCalls.map((c) => c.function.name))}`)
  if (parsed.content) lastRoundContent = parsed.content
  return parsed
}

async function main(): Promise<void> {
  await app.whenReady()

  // Lazily require electron-dependent modules only after userData is redirected.
  const audit = require('../src/main/ipc/audit') as typeof import('../src/main/ipc/audit')
  const { readSessionPlaintext, currentAuditSessionId, recordAuditEntry } = audit
  const { exportTraces, outcomeKey, outcomesFromConversation, schemaVersionFor } =
    require('../src/main/ipc/traceExport') as typeof import('../src/main/ipc/traceExport')
  const { safeStorage } = require('electron') as typeof import('electron')

  if (!safeStorage.isEncryptionAvailable()) {
    console.error('safeStorage unavailable — the audit log refuses plaintext; aborting.')
    app.quit()
    return
  }

  const turns: { user: string; reply: string; stopReason: string }[] = []
  const conversationMessages: { role: string; content: string; unverified?: boolean }[] = []
  const prompts = [
    'What time is it right now?',
    'I have a bill of 86.40 dollars. What is an 18 percent tip on that, and the total?',
    'Search the web for the current weather in Tokyo.'
  ]
  const wireTools = TOOL_SCHEMAS.filter((t) => WIRE_NAMES.includes(t.function.name))

  for (const prompt of prompts) {
    console.log(`\n> ${prompt}`)
    await recordAuditEntry({ kind: 'user_input', conversationId: CONVERSATION_ID, text: prompt })
    conversationMessages.push({ role: 'user', content: prompt })

    const messages: ApiMessage[] = [
      { role: 'system', content: withToolCallPreamble(withGrounding('You are a helpful local assistant.'), MODEL) },
      { role: 'user', content: prompt }
    ]
    const records: ToolCallRecord[] = []
    lastRoundContent = ''
    const outcome = await runAgentLoop({
      messages,
      tools: wireTools,
      records,
      signal: new AbortController().signal,
      deps: {
        streamRound: (msgs) => complete(msgs),
        executeTool,
        onToolExecuted: (record, result) => {
          void recordAuditEntry({
            kind: 'tool_call',
            conversationId: CONVERSATION_ID,
            roleName: 'Demo',
            modelId: MODEL,
            toolName: record.name,
            ok: result.ok,
            text: `${record.name}(${JSON.stringify(record.args)})\n→ ${result.ok ? (result.output ?? '') : `Error: ${result.error ?? 'unknown error'}`}`
          })
        }
      }
    })

    const reply = lastRoundContent
    console.log(`  stop=${outcome.stopReason} tools=[${records.map((r) => `${r.name}${r.status === 'error' ? '✗' : ''}`).join(', ')}]`)
    console.log(`  reply: ${reply.slice(0, 160)}`)
    if (outcome.stopReason === 'completed') {
      await recordAuditEntry({
        kind: 'assistant_output',
        conversationId: CONVERSATION_ID,
        roleName: 'Demo',
        modelId: MODEL,
        text: reply
      })
    }
    conversationMessages.push({ role: 'assistant', content: reply, unverified: false })
    turns.push({ user: prompt, reply, stopReason: outcome.stopReason })
  }

  // The conversation file the app's outcome-join would read (4b labels).
  mkdirSync(join(USER_DATA, 'conversations'), { recursive: true })
  writeFileSync(
    join(USER_DATA, 'conversations', `${CONVERSATION_ID}.json`),
    JSON.stringify({ id: CONVERSATION_ID, title: 'Live demo', messages: conversationMessages })
  )

  // Export exactly like main/ipc/traces.ts, minus the save dialog.
  const session = await readSessionPlaintext(currentAuditSessionId())
  if ('error' in session) {
    console.error(`audit read failed: ${session.error}`)
    app.quit()
    return
  }
  const convo = JSON.parse(
    readFileSync(join(USER_DATA, 'conversations', `${CONVERSATION_ID}.json`), 'utf-8')
  ) as { id: string; messages: Parameters<typeof outcomesFromConversation>[0]['messages'] }
  const outcomes = new Map<string, import('../src/main/ipc/traceExport').TurnOutcome>()
  for (const [turnIndex, o] of outcomesFromConversation(convo)) {
    outcomes.set(outcomeKey(convo.id, turnIndex), o)
  }
  const exported = exportTraces(session.entries, { outcomes, tools: TOOL_SCHEMAS as unknown[] })

  mkdirSync(OUT_DIR, { recursive: true })
  const base = join(OUT_DIR, `${currentAuditSessionId()}-traces`)
  writeFileSync(`${base}-positive.jsonl`, exported.positive.length ? `${exported.positive.join('\n')}\n` : '')
  writeFileSync(`${base}-rejected.jsonl`, exported.rejected.length ? `${exported.rejected.join('\n')}\n` : '')
  writeFileSync(`${base}-manifest.json`, `${JSON.stringify(exported.manifest, null, 2)}\n`)
  writeFileSync(
    `${base}-tools.json`,
    `${JSON.stringify({ schemaVersion: schemaVersionFor(TOOL_SCHEMAS as unknown[]), exportedAt: exported.manifest.exportedAt, tools: TOOL_SCHEMAS }, null, 2)}\n`
  )

  console.log('\n=== live trace export ===')
  console.log(`audit session     ${currentAuditSessionId()} (hash chain ${session.chainValid ? 'valid' : 'BROKEN'})`)
  console.log(`turns             ${exported.manifest.counts.turns} (${exported.manifest.counts.skippedEntries} entries skipped)`)
  console.log(`positive          ${exported.manifest.counts.positive}`)
  console.log(`rejected          ${exported.manifest.counts.rejected}`)
  console.log(`unlabeled         ${exported.manifest.counts.unlabeled}`)
  console.log(`schema version    ${exported.manifest.schemaVersion}`)
  console.log(`written to        ${OUT_DIR}`)
  app.quit()
}

main().catch((err) => {
  console.error(err)
  app.quit()
  process.exitCode = 1
})
