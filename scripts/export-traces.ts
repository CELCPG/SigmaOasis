/**
 * Layer 4 — trace export (CLI shell).
 *
 * Reads a decrypted audit-log export (Settings → Privacy → Export audit log,
 * or the in-app traces export) and emits OpenAI-format fine-tuning JSONL. All
 * logic lives in src/main/ipc/traceExport.ts — this shell supplies only file
 * I/O, so the two shells cannot drift.
 *
 *   npm run export:traces -- <audit-export.jsonl> [--conversations <dir>] [--out <dir>]
 *
 * The audit export carries no system prompts and no ephemeral chats by
 * construction. Conversation files (plain JSON, never encrypted) supply the
 * 4b outcome labels — unverified flags and claim-check verdicts; without them
 * every turn exports unlabeled, which is reported, not hidden. The
 * conversations dir defaults to the standard userData locations (packaged
 * "Sigma Oasis", dev "sigma-oasis").
 *
 * Outputs, written to --out (default: alongside the input file):
 *   <base>-positive.jsonl   strict {"messages":[...]} lines, good endings only
 *   <base>-rejected.jsonl   errored / capped / contradicted turns (preference pairs)
 *   <base>-manifest.json    counts, per-trace labels and reasons, schema stamp
 *   <base>-tools.json       the tool schemas these traces ran against (4c)
 *
 * The export writes to local disk and never uploads (strategy: egress honesty).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import {
  exportTraces,
  outcomeKey,
  outcomesFromConversation,
  schemaVersionFor,
  type AuditEntryLike,
  type TurnOutcome
} from '../src/main/ipc/traceExport'
import { TOOL_SCHEMAS } from '../src/main/ipc/toolSchemas'

function usage(): never {
  console.error(
    'usage: npm run export:traces -- <audit-export.jsonl> [--conversations <dir>] [--out <dir>]'
  )
  process.exit(2)
}

const args = process.argv.slice(2)
const positional: string[] = []
let conversationsDir: string | null = null
let outDir: string | null = null
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--conversations') conversationsDir = args[++i] ?? null
  else if (args[i] === '--out') outDir = args[++i] ?? null
  else positional.push(args[i])
}
const input = positional[0]
if (!input || !existsSync(input)) usage()

function defaultConversationsDir(): string | null {
  const base = join(homedir(), 'Library', 'Application Support')
  for (const name of ['Sigma Oasis', 'sigma-oasis']) {
    const dir = join(base, name, 'conversations')
    if (existsSync(dir)) return dir
  }
  return null
}

// ---- Read the decrypted audit export ------------------------------------------
// The file's first line is a header (exportedAt/sessionId/hashChainValid), the
// rest are audit entries. Anything else fails loudly — a malformed input must
// not silently produce a half-empty trace set.
const lines = readFileSync(input, 'utf-8')
  .split('\n')
  .filter((l) => l.trim())
const entries: AuditEntryLike[] = []
for (const [i, line] of lines.entries()) {
  const parsed = JSON.parse(line) as Record<string, unknown>
  if (i === 0 && typeof parsed.sessionId === 'string' && !parsed.kind) continue // export header
  if (typeof parsed.kind !== 'string' || typeof parsed.text !== 'string') {
    console.error(`error: line ${i + 1} is not an audit entry (no kind/text).`)
    process.exit(1)
  }
  entries.push(parsed as unknown as AuditEntryLike)
}

// ---- Outcome labels from stored conversations ---------------------------------
const convDir = conversationsDir ?? defaultConversationsDir()
const outcomes = new Map<string, TurnOutcome>()
let matched = 0
if (convDir && existsSync(convDir)) {
  const wanted = new Set(entries.map((e) => e.conversationId).filter(Boolean))
  for (const f of readdirSync(convDir).filter((f) => f.endsWith('.json'))) {
    try {
      const convo = JSON.parse(readFileSync(join(convDir, f), 'utf-8')) as {
        id: string
        ephemeral?: boolean
        messages: Parameters<typeof outcomesFromConversation>[0]['messages']
      }
      if (convo.ephemeral || !wanted.has(convo.id)) continue
      for (const [turnIndex, outcome] of outcomesFromConversation(convo)) {
        outcomes.set(outcomeKey(convo.id, turnIndex), outcome)
      }
      matched += 1
    } catch {
      // A corrupt conversation file loses its labels, not the whole export.
    }
  }
} else {
  console.warn('warning: no conversations dir found — all turns will export unlabeled.')
}

// ---- Export ---------------------------------------------------------------------
const result = exportTraces(entries, { outcomes, tools: TOOL_SCHEMAS as unknown[] })

const dir = outDir ?? dirname(input)
mkdirSync(dir, { recursive: true })
const base = basename(input).replace(/\.jsonl$/, '')
const paths = {
  positive: join(dir, `${base}-positive.jsonl`),
  rejected: join(dir, `${base}-rejected.jsonl`),
  manifest: join(dir, `${base}-manifest.json`),
  tools: join(dir, `${base}-tools.json`)
}
writeFileSync(paths.positive, result.positive.length ? `${result.positive.join('\n')}\n` : '')
writeFileSync(paths.rejected, result.rejected.length ? `${result.rejected.join('\n')}\n` : '')
writeFileSync(paths.manifest, `${JSON.stringify(result.manifest, null, 2)}\n`)
writeFileSync(
  paths.tools,
  `${JSON.stringify({ schemaVersion: schemaVersionFor(TOOL_SCHEMAS as unknown[]), exportedAt: result.manifest.exportedAt, tools: TOOL_SCHEMAS }, null, 2)}\n`
)

console.log(`trace export — ${basename(input)}`)
console.log(`  turns rebuilt     ${result.manifest.counts.turns} (${result.manifest.counts.skippedEntries} entries skipped)`)
console.log(`  outcomes matched  ${outcomes.size} turns from ${matched} conversation file(s)`)
console.log(`  positive          ${result.manifest.counts.positive}  → ${paths.positive}`)
console.log(`  rejected          ${result.manifest.counts.rejected}  → ${paths.rejected}`)
console.log(`  unlabeled         ${result.manifest.counts.unlabeled}  (excluded from both files)`)
console.log(`  schema version    ${result.manifest.schemaVersion}`)
console.log(`  manifest          ${paths.manifest}`)
console.log(`  tool schemas      ${paths.tools}`)
