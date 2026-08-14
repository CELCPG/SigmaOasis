import { app, dialog, ipcMain } from 'electron'
import { hostWindow } from './hostWindow'
import { promises as fs } from 'fs'
import { join } from 'path'
import { readSessionPlaintext, currentAuditSessionId } from './audit'
import { TOOL_SCHEMAS } from './toolSchemas'
import {
  exportTraces,
  outcomeKey,
  outcomesFromConversation,
  schemaVersionFor,
  type TurnOutcome
} from './traceExport'

/**
 * Layer 4 — trace export (in-app shell).
 *
 * One IPC handler, `traces:export`: decrypts the chosen audit session in
 * memory, joins it with the stored conversations for the 4b outcome labels
 * (unverified flags, claim-check verdicts), runs the shared exporter
 * (main/ipc/traceExport.ts — the same code the CLI shell runs), and writes
 * four files next to a user-chosen path:
 *
 *   <base>-positive.jsonl / <base>-rejected.jsonl / <base>-manifest.json / <base>-tools.json
 *
 * Opt-in per export: the save dialog is the consent, exactly like audit:export.
 * Ephemeral conversations are unreachable twice over — they produce no audit
 * entries and are never written to the conversations dir. Everything stays on
 * local disk; nothing here touches the network.
 */

interface StoredConversation {
  id: string
  ephemeral?: boolean
  messages: Parameters<typeof outcomesFromConversation>[0]['messages']
}

function conversationsDir(): string {
  return join(app.getPath('userData'), 'conversations')
}

function conversationFile(id: string): string | null {
  return /^[A-Za-z0-9_-]+$/.test(id) ? join(conversationsDir(), `${id}.json`) : null
}

async function loadOutcomes(conversationIds: Set<string>): Promise<Map<string, TurnOutcome>> {
  const outcomes = new Map<string, TurnOutcome>()
  for (const id of conversationIds) {
    const file = conversationFile(id)
    if (!file) continue
    try {
      const convo = JSON.parse(await fs.readFile(file, 'utf-8')) as StoredConversation
      if (convo.ephemeral) continue
      for (const [turnIndex, outcome] of outcomesFromConversation(convo)) {
        outcomes.set(outcomeKey(id, turnIndex), outcome)
      }
    } catch {
      // A missing or corrupt conversation loses its labels, not the export.
    }
  }
  return outcomes
}

export function registerTraceHandlers(): void {
  ipcMain.handle('traces:export', async (event, sessionId?: string) => {
    const id = typeof sessionId === 'string' && sessionId ? sessionId : currentAuditSessionId()
    const result = await readSessionPlaintext(id)
    if ('error' in result) return { ok: false, error: result.error }

    const win = hostWindow(event.sender)
    if (!win) return { ok: false, canceled: true }
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export fine-tuning traces',
      defaultPath: join(app.getPath('documents'), `${id}-traces.jsonl`),
      filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }

    const base = filePath.replace(/\.jsonl$/, '')
    const conversationIds = new Set(result.entries.map((e) => e.conversationId).filter(Boolean))
    const outcomes = await loadOutcomes(conversationIds)
    const exported = exportTraces(result.entries, {
      outcomes,
      tools: TOOL_SCHEMAS as unknown[]
    })

    const paths = {
      positive: `${base}-positive.jsonl`,
      rejected: `${base}-rejected.jsonl`,
      manifest: `${base}-manifest.json`,
      tools: `${base}-tools.json`
    }
    try {
      await fs.writeFile(
        paths.positive,
        exported.positive.length ? `${exported.positive.join('\n')}\n` : '',
        'utf-8'
      )
      await fs.writeFile(
        paths.rejected,
        exported.rejected.length ? `${exported.rejected.join('\n')}\n` : '',
        'utf-8'
      )
      await fs.writeFile(paths.manifest, `${JSON.stringify(exported.manifest, null, 2)}\n`, 'utf-8')
      await fs.writeFile(
        paths.tools,
        `${JSON.stringify(
          {
            schemaVersion: schemaVersionFor(TOOL_SCHEMAS as unknown[]),
            exportedAt: exported.manifest.exportedAt,
            tools: TOOL_SCHEMAS
          },
          null,
          2
        )}\n`,
        'utf-8'
      )
      return {
        ok: true,
        paths,
        counts: exported.manifest.counts,
        outcomesMatched: outcomes.size,
        schemaVersion: exported.manifest.schemaVersion,
        chainValid: result.chainValid
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
