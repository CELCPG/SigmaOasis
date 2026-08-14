import { app, dialog, ipcMain, safeStorage } from 'electron'
import { hostWindow } from './hostWindow'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import { getSettings } from './store'

/**
 * Session audit log (v0.9): an opt-in, append-only transcript of what was
 * actually said — user inputs, assistant outputs, tool calls — with none of
 * the layers in between (no system prompts, no recalled memory, no compaction
 * notes). It exists so the user can verify a session the same way the network
 * activity log lets them verify egress.
 *
 * Properties, all enforced here rather than promised in prose:
 *
 * - **Encrypted at rest.** Every line is safeStorage-encrypted (the same
 *   machine-bound key that protects the Brave API key). If the OS keychain is
 *   unavailable the log refuses to run: an audit trail in plaintext would be
 *   a worse privacy story than none. Caveat, as with secrets today: the key
 *   is machine-bound, so logs do not survive an OS reinstall.
 * - **Tamper-evident.** Each entry carries the SHA-256 of the previous
 *   plaintext line; deleting or editing a line breaks the chain, and export
 *   reports whether the chain still verifies.
 * - **Ephemeral-blind.** Ephemeral conversations produce no entries, at both
 *   layers: the renderer does not send them, and this module refuses any
 *   entry flagged ephemeral. No-trace means no-trace, including here.
 * - **Opt-in.** Default off (store.ts); nothing below runs unless enabled.
 */

export type AuditEntryKind = 'session_start' | 'user_input' | 'assistant_output' | 'tool_call'

export interface AuditEntryInput {
  conversationId: string
  kind: AuditEntryKind
  roleName?: string
  modelId?: string
  toolName?: string
  ok?: boolean
  text: string
  /** Renderer-side flag; entries for ephemeral conversations are refused. */
  ephemeral?: boolean
}

interface AuditEntry {
  at: string
  kind: AuditEntryKind
  conversationId: string
  roleName?: string
  modelId?: string
  toolName?: string
  ok?: boolean
  text: string
  prevHash: string
}

/** Entries are capped so one giant tool output cannot bloat the log. */
const MAX_ENTRY_CHARS = 20_000

const GENESIS_HASH = createHash('sha256').update('sigma-oasis-audit-genesis').digest('hex')

/** One log file per app launch. */
const SESSION_ID = `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`

let lastHash: string | null = null
let sessionStarted = false

function auditDir(): string {
  return join(app.getPath('userData'), 'audit')
}

function sessionFile(sessionId: string): string | null {
  return /^[A-Za-z0-9_-]+$/.test(sessionId) ? join(auditDir(), `${sessionId}.jsonl`) : null
}

/** Serializes appends, the same pattern as the memory store's write queue. */
let auditQueue: Promise<unknown> = Promise.resolve()

function withAuditLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = auditQueue.then(fn, fn)
  auditQueue = run.catch(() => undefined)
  return run
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function encryptLine(plain: string): string {
  return safeStorage.encryptString(plain).toString('base64')
}

function decryptLine(line: string): string {
  return safeStorage.decryptString(Buffer.from(line, 'base64'))
}

async function appendEntry(entry: AuditEntry): Promise<void> {
  const file = sessionFile(SESSION_ID)
  if (!file) return
  await fs.mkdir(auditDir(), { recursive: true })
  await fs.appendFile(file, `${encryptLine(JSON.stringify(entry))}\n`, 'utf-8')
}

/**
 * Record one entry. No-ops unless the log is enabled, encryption is
 * available, and the conversation is not ephemeral — all three checked here
 * so the renderer cannot accidentally create a trace it meant to avoid.
 */
export async function recordAuditEntry(input: AuditEntryInput): Promise<void> {
  if (!getSettings().audit.enabled) return
  if (!safeStorage.isEncryptionAvailable()) return
  if (input.ephemeral) return
  const kind = input.kind
  if (!['session_start', 'user_input', 'assistant_output', 'tool_call'].includes(kind)) return

  return withAuditLock(async () => {
    if (!sessionStarted) {
      const genesis: AuditEntry = {
        at: new Date().toISOString(),
        kind: 'session_start',
        conversationId: '',
        text: `Audit session ${SESSION_ID} started (Sigma Oasis ${app.getVersion()}).`,
        prevHash: GENESIS_HASH
      }
      await appendEntry(genesis)
      lastHash = sha256(JSON.stringify(genesis))
      sessionStarted = true
    }

    const raw = String(input.text ?? '')
    const entry: AuditEntry = {
      at: new Date().toISOString(),
      kind,
      conversationId: String(input.conversationId ?? ''),
      ...(input.roleName ? { roleName: String(input.roleName) } : {}),
      ...(input.modelId ? { modelId: String(input.modelId) } : {}),
      ...(input.toolName ? { toolName: String(input.toolName) } : {}),
      ...(typeof input.ok === 'boolean' ? { ok: input.ok } : {}),
      text:
        raw.length > MAX_ENTRY_CHARS
          ? `${raw.slice(0, MAX_ENTRY_CHARS)}\n… [truncated — ${raw.length} chars total]`
          : raw,
      prevHash: lastHash ?? GENESIS_HASH
    }
    await appendEntry(entry)
    lastHash = sha256(JSON.stringify(entry))
  })
}

interface AuditSessionInfo {
  sessionId: string
  entries: number
  sizeBytes: number
}

async function listSessions(): Promise<AuditSessionInfo[]> {
  try {
    const files = await fs.readdir(auditDir())
    const sessions: AuditSessionInfo[] = []
    for (const f of files.filter((f) => f.endsWith('.jsonl')).sort().reverse()) {
      const full = join(auditDir(), f)
      try {
        const raw = await fs.readFile(full, 'utf-8')
        const stat = await fs.stat(full)
        sessions.push({
          sessionId: f.replace(/\.jsonl$/, ''),
          entries: raw.split('\n').filter((l) => l.trim()).length,
          sizeBytes: stat.size
        })
      } catch {
        // Unreadable file — skip it rather than failing the whole listing.
      }
    }
    return sessions
  } catch {
    return []
  }
}

/**
 * Decrypt a session log and verify its hash chain. Returns the plaintext
 * entries plus whether the chain is intact — a broken chain is reported, not
 * hidden, because that is the entire point of having one. Exported for the
 * test suite; the renderer reaches it only through audit:export.
 */
export async function readSessionPlaintext(
  sessionId: string
): Promise<{ entries: AuditEntry[]; chainValid: boolean } | { error: string }> {
  const file = sessionFile(sessionId)
  if (!file) return { error: 'Invalid session id.' }
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch {
    return { error: 'Session log not found.' }
  }

  const entries: AuditEntry[] = []
  let chainValid = true
  let expected = GENESIS_HASH
  for (const line of raw.split('\n').filter((l) => l.trim())) {
    try {
      const entry = JSON.parse(decryptLine(line)) as AuditEntry
      if (entry.prevHash !== expected) chainValid = false
      entries.push(entry)
      expected = sha256(JSON.stringify(entry))
    } catch {
      // A line that will not decrypt or parse is itself evidence of tampering.
      chainValid = false
    }
  }
  return { entries, chainValid }
}

/** The session id this app launch is logging under. Exported for tests. */
export function currentAuditSessionId(): string {
  return SESSION_ID
}

/** Delete every audit log. Used by the Purge button and by auto-purge-on-quit. */
export async function purgeAuditLogs(): Promise<{ removed: number }> {
  const sessions = await listSessions()
  await fs.rm(auditDir(), { recursive: true, force: true })
  return { removed: sessions.length }
}

export function registerAuditHandlers(): void {
  ipcMain.handle('audit:status', async () => ({
    available: safeStorage.isEncryptionAvailable(),
    enabled: getSettings().audit.enabled,
    currentSessionId: SESSION_ID,
    sessions: await listSessions()
  }))

  ipcMain.handle('audit:record', async (_e, input: AuditEntryInput) => {
    await recordAuditEntry(input)
    return true
  })

  ipcMain.handle('audit:export', async (event, sessionId?: string) => {
    const id = typeof sessionId === 'string' && sessionId ? sessionId : SESSION_ID
    const result = await readSessionPlaintext(id)
    if ('error' in result) return { ok: false, error: result.error }

    const win = hostWindow(event.sender)
    if (!win) return { ok: false, canceled: true }
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export audit log (decrypted)',
      defaultPath: join(app.getPath('documents'), `${id}.jsonl`),
      filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }

    const header = {
      exportedAt: new Date().toISOString(),
      sessionId: id,
      entries: result.entries.length,
      hashChainValid: result.chainValid,
      note: 'Decrypted export of the Sigma Oasis session audit log. Anyone with this file can read it.'
    }
    try {
      const body = [JSON.stringify(header), ...result.entries.map((e) => JSON.stringify(e))].join(
        '\n'
      )
      await fs.writeFile(filePath, `${body}\n`, 'utf-8')
      return {
        ok: true,
        path: filePath,
        entries: result.entries.length,
        chainValid: result.chainValid
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('audit:purge', async () => purgeAuditLogs())
}
