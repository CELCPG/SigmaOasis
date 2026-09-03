import { app, ipcMain } from 'electron'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import { writeFileAtomic } from './fsAtomic'

/**
 * v2.6: standing grants for the tools that confirm each call.
 *
 * A confirmation dialog has always had two answers, run or cancel, and so the
 * two tools that ask (run_terminal_command, and write_file outside a working
 * directory) are the two nobody enables. This module adds the third answer,
 * "Always allow", as OpenClaw's exec approvals define it: a grant is bound to
 * the tool and the **exact** arguments and working directory it was given at
 * the moment of approval — a different byte anywhere is a different call and
 * asks again. Nothing is matched by pattern, prefix or wildcard.
 *
 * Grants live in their own file (`grants.json`), not in settings: they are
 * minted from the main process while a dialog is up, and a settings write
 * from there would race the Settings modal's draft. The panel under
 * Settings → Tools lists them with their use counts and revokes them one at
 * a time; revocation is immediate, the next call asks.
 *
 * What a grant never does: widen. A grant cannot be created without the user
 * pressing the button in a dialog the app raised; there is no IPC that mints
 * one, so neither a model nor a page nor a server can hand itself a grant.
 */

export interface Grant {
  id: string
  /** Wire name: a built-in or an MCP tool. */
  tool: string
  /** SHA-256 over the canonical binding — the only thing a call is matched on. */
  key: string
  /** What the panel shows: the command, the path, or the arguments, cut short. */
  summary: string
  /** The working directory the grant was made in, when the tool has one. */
  cwd?: string
  createdAt: number
  uses: number
  lastUsedAt?: number
}

export interface GrantBinding {
  tool: string
  /** The exact arguments the call carries, canonicalized before hashing. */
  args: Record<string, unknown>
  cwd?: string
}

interface GrantsFile {
  grants: Grant[]
}

export const MAX_GRANTS = 200
const SUMMARY_MAX = 160

function grantsFile(): string {
  return join(app.getPath('userData'), 'grants.json')
}

/** Stable JSON: object keys sorted at every depth, so `{a,b}` and `{b,a}` hash alike. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** The key a call is matched on. Byte-exact over tool, arguments and cwd. */
export function grantKey(binding: GrantBinding): string {
  return createHash('sha256')
    .update(canonicalJson({ tool: binding.tool, args: binding.args, cwd: binding.cwd ?? '' }))
    .digest('hex')
}

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

function cut(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > SUMMARY_MAX ? `${one.slice(0, SUMMARY_MAX - 1)}…` : one
}

let queue: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

async function readGrants(): Promise<GrantsFile> {
  try {
    const raw = JSON.parse(await fs.readFile(grantsFile(), 'utf-8')) as Partial<GrantsFile>
    return { grants: Array.isArray(raw.grants) ? raw.grants.filter(isGrant) : [] }
  } catch {
    return { grants: [] }
  }
}

function isGrant(g: unknown): g is Grant {
  const x = g as Partial<Grant>
  return (
    !!x &&
    typeof x.id === 'string' &&
    typeof x.tool === 'string' &&
    typeof x.key === 'string' &&
    typeof x.summary === 'string' &&
    typeof x.createdAt === 'number' &&
    typeof x.uses === 'number'
  )
}

async function writeGrants(data: GrantsFile): Promise<void> {
  await writeFileAtomic(grantsFile(), JSON.stringify(data))
}

/**
 * Find the grant for this exact call and count the use. Null when there is
 * none — the caller asks. A revoked grant is simply absent.
 */
export async function useGrant(binding: GrantBinding): Promise<Grant | null> {
  const key = grantKey(binding)
  return withLock(async () => {
    const data = await readGrants()
    const hit = data.grants.find((g) => g.key === key && g.tool === binding.tool)
    if (!hit) return null
    hit.uses += 1
    hit.lastUsedAt = Date.now()
    await writeGrants(data)
    return hit
  })
}

/**
 * Mint a grant from a dialog answer. `summary` is what the user saw in the
 * dialog, cut to a line, so the panel shows exactly what was approved.
 */
export async function createGrant(binding: GrantBinding, summary: string): Promise<Grant> {
  const key = grantKey(binding)
  return withLock(async () => {
    const data = await readGrants()
    const existing = data.grants.find((g) => g.key === key && g.tool === binding.tool)
    if (existing) return existing
    if (data.grants.length >= MAX_GRANTS) {
      throw new Error(`Too many standing grants (${MAX_GRANTS}). Revoke some under Settings → Tools.`)
    }
    const grant: Grant = {
      id: uid(),
      tool: binding.tool,
      key,
      summary: cut(summary),
      ...(binding.cwd ? { cwd: binding.cwd } : {}),
      createdAt: Date.now(),
      uses: 0
    }
    data.grants.push(grant)
    await writeGrants(data)
    return grant
  })
}

export async function listGrants(): Promise<Grant[]> {
  const data = await readGrants()
  return [...data.grants].sort((a, b) => b.createdAt - a.createdAt)
}

export async function revokeGrant(id: string): Promise<{ removed: number }> {
  return withLock(async () => {
    const data = await readGrants()
    const before = data.grants.length
    data.grants = data.grants.filter((g) => g.id !== id)
    await writeGrants(data)
    return { removed: before - data.grants.length }
  })
}

export async function revokeAllGrants(): Promise<{ removed: number }> {
  return withLock(async () => {
    const data = await readGrants()
    const removed = data.grants.length
    await writeGrants({ grants: [] })
    return { removed }
  })
}

/** The line appended to a tool's output when a grant, not a dialog, allowed the call. */
export const GRANT_NOTE = '(allowed by a standing grant — revoke under Settings → Tools)'

export function registerGrantHandlers(): void {
  ipcMain.handle('grants:list', () => listGrants())
  ipcMain.handle('grants:revoke', async (_e, id: unknown) => {
    try {
      return { ok: true, ...(await revokeGrant(String(id ?? ''))) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('grants:revokeAll', async () => {
    try {
      return { ok: true, ...(await revokeAllGrants()) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
