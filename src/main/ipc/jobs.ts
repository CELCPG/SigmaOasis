import { app, BrowserWindow, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { writeFileAtomic } from './fsAtomic'
import { getSettings } from './store'
import { recordAuditEntry } from './audit'
import { afterRun, dueJobs, JOB_INTERVAL_MS } from '../../shared/jobs'
import type { Job, JobArgs, JobInterval, JobKind, JobOutcome } from '../../shared/jobs'

/**
 * v2.6: the local scheduler. Runs while the app is open, and only then: no
 * daemon, no port, nothing acting while the window is closed. Modelled on
 * the update checker — settings re-read inside the tick, a delayed first
 * tick, torn down on will-quit — with the library's one-job-at-a-time guard.
 *
 * Every run is a row in the audit log under the digest conversation, and
 * every network request a runner makes goes through the same audited fetch
 * as a typed turn, under the runner's own purpose. A job never runs a tool
 * that confirms, so it never needs a grant; a runner that would need one
 * refuses and says so.
 */

export interface JobRunResult {
  outcome: JobOutcome
  /** One line for the job's row. */
  note: string
  /** The message for the digest conversation, when the run produced one. */
  digest?: string
}

export type JobRunner = (job: Job) => Promise<JobRunResult>

export interface SchedulerDeps {
  runners: Record<JobKind, JobRunner>
  /** Hand a digest to the renderer; false when no window is there to take it. */
  deliver: (job: Job, digest: string) => boolean
  audit: (job: Job, result: JobRunResult) => Promise<void>
  now: () => number
  /** The persisted list — injected so the scheduler is testable without a disk. */
  read: () => Promise<Job[]>
  write: (jobs: Job[]) => Promise<void>
}

export interface Scheduler {
  /** One pass: deliver held digests, run every due job in order. Returns how many ran. */
  tick: () => Promise<number>
  runNow: (id: string) => Promise<JobRunResult | null>
  /** True while a job is running; a tick that lands then does nothing. */
  busy: () => boolean
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  let running = false

  const runOne = async (job: Job): Promise<JobRunResult> => {
    let result: JobRunResult
    try {
      result = await deps.runners[job.kind](job)
    } catch (err) {
      result = { outcome: 'failed', note: err instanceof Error ? err.message : String(err) }
    }
    await deps.audit(job, result).catch(() => undefined)
    return result
  }

  const settle = async (job: Job, result: JobRunResult): Promise<void> => {
    const now = deps.now()
    let next = afterRun(job, result.outcome, result.note, now)
    if (result.digest) {
      const delivered = deps.deliver(next, result.digest)
      next = delivered ? { ...next, pendingDigest: undefined } : { ...next, pendingDigest: result.digest }
      if (!delivered) next.lastNote = `${next.lastNote} (digest held until a window opens)`
    }
    const jobs = await deps.read()
    // The job may have been edited or removed while it ran: an edit wins, a
    // removal stays removed.
    const current = jobs.find((j) => j.id === job.id)
    if (!current) return
    await deps.write(jobs.map((j) => (j.id === job.id ? { ...current, ...pick(next) } : j)))
  }

  const pick = (j: Job): Partial<Job> => ({
    failures: j.failures,
    enabled: j.enabled,
    nextAt: j.nextAt,
    lastRunAt: j.lastRunAt,
    lastOutcome: j.lastOutcome,
    lastNote: j.lastNote,
    pendingDigest: j.pendingDigest
  })

  const tick: Scheduler['tick'] = async () => {
    if (running) return 0
    running = true
    try {
      let jobs = await deps.read()
      // Held digests first: a window is there now, or still is not.
      let changed = false
      for (const j of jobs) {
        if (j.pendingDigest && deps.deliver(j, j.pendingDigest)) {
          j.pendingDigest = undefined
          changed = true
        }
      }
      if (changed) await deps.write(jobs)
      let ran = 0
      for (const job of dueJobs(jobs, deps.now())) {
        const result = await runOne(job)
        await settle(job, result)
        ran += 1
        jobs = await deps.read()
      }
      return ran
    } finally {
      running = false
    }
  }

  const runNow: Scheduler['runNow'] = async (id) => {
    if (running) return null
    running = true
    try {
      const job = (await deps.read()).find((j) => j.id === id)
      if (!job) return null
      const result = await runOne(job)
      await settle(job, result)
      return result
    } finally {
      running = false
    }
  }

  return { tick, runNow, busy: () => running }
}

// ---- the store -----------------------------------------------------------------

const KINDS: ReadonlySet<string> = new Set(['research', 'price', 'ledger', 'packs'])
const INTERVALS: ReadonlySet<string> = new Set(['hourly', 'daily', 'weekly'])
export const MAX_JOBS = 50

function jobsFile(): string {
  return join(app.getPath('userData'), 'jobs.json')
}

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

function isJob(j: unknown): j is Job {
  const x = j as Partial<Job>
  return (
    !!x &&
    typeof x.id === 'string' &&
    typeof x.kind === 'string' &&
    KINDS.has(x.kind) &&
    typeof x.title === 'string' &&
    typeof x.interval === 'string' &&
    INTERVALS.has(x.interval) &&
    !!x.args &&
    typeof x.args === 'object' &&
    typeof x.enabled === 'boolean' &&
    typeof x.nextAt === 'number' &&
    typeof x.failures === 'number' &&
    typeof x.digestConversationId === 'string' &&
    typeof x.createdAt === 'number'
  )
}

let queue: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

export async function readJobs(): Promise<Job[]> {
  try {
    const raw = JSON.parse(await fs.readFile(jobsFile(), 'utf-8')) as { jobs?: unknown[] }
    return Array.isArray(raw.jobs) ? raw.jobs.filter(isJob) : []
  } catch {
    return []
  }
}

export async function writeJobs(jobs: Job[]): Promise<void> {
  await writeFileAtomic(jobsFile(), JSON.stringify({ jobs }))
}

function sanitizeArgs(kind: JobKind, raw: unknown): JobArgs {
  const a = (raw ?? {}) as Record<string, unknown>
  const args: JobArgs = {}
  if (kind === 'research') {
    args.question = String(a.question ?? '').trim().slice(0, 500)
    args.depth = a.depth === 'quick' || a.depth === 'thorough' ? a.depth : 'standard'
    if (typeof a.modelId === 'string' && a.modelId.trim()) args.modelId = a.modelId.trim()
  }
  if (kind === 'price') args.url = String(a.url ?? '').trim()
  return args
}

export async function addJob(input: { kind: unknown; title?: unknown; interval?: unknown; args?: unknown }): Promise<Job> {
  const kind = String(input.kind ?? '')
  if (!KINDS.has(kind)) throw new Error('Unknown job kind.')
  const interval: JobInterval = INTERVALS.has(String(input.interval)) ? (input.interval as JobInterval) : 'daily'
  const args = sanitizeArgs(kind as JobKind, input.args)
  if (kind === 'research' && !args.question) throw new Error('A research job needs a question.')
  if (kind === 'price' && !/^https?:\/\//.test(args.url ?? '')) throw new Error('A price job needs the watched item’s URL.')
  const title =
    String(input.title ?? '').trim().slice(0, 120) ||
    (kind === 'research' ? args.question! : kind === 'price' ? args.url! : kind === 'ledger' ? 'Verified claims' : 'Tracked folders')
  return withLock(async () => {
    const jobs = await readJobs()
    if (jobs.length >= MAX_JOBS) throw new Error(`Too many jobs (${MAX_JOBS}).`)
    const now = Date.now()
    const job: Job = {
      id: uid(),
      kind: kind as JobKind,
      title,
      interval,
      args,
      enabled: true,
      // First run on the next tick, not in a day: the user just asked for it.
      nextAt: now,
      failures: 0,
      digestConversationId: `job-${uid()}`,
      createdAt: now
    }
    await writeJobs([...jobs, job])
    return job
  })
}

export async function updateJob(id: string, patch: { enabled?: unknown; interval?: unknown }): Promise<Job | null> {
  return withLock(async () => {
    const jobs = await readJobs()
    const job = jobs.find((j) => j.id === id)
    if (!job) return null
    if (typeof patch.enabled === 'boolean') {
      job.enabled = patch.enabled
      // Switching a job back on forgives its failures and runs it soon.
      if (patch.enabled) {
        job.failures = 0
        job.nextAt = Date.now()
      }
    }
    if (INTERVALS.has(String(patch.interval))) {
      job.interval = patch.interval as JobInterval
      job.nextAt = Math.min(job.nextAt, Date.now() + JOB_INTERVAL_MS[job.interval])
    }
    await writeJobs(jobs)
    return job
  })
}

export async function removeJob(id: string): Promise<{ removed: number }> {
  return withLock(async () => {
    const jobs = await readJobs()
    const kept = jobs.filter((j) => j.id !== id)
    await writeJobs(kept)
    return { removed: jobs.length - kept.length }
  })
}

// ---- the runners, as shipped ---------------------------------------------------

function dateLine(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 16)
}

function firstEnabledModel(): string | undefined {
  return getSettings().models.find((m) => m.enabled && m.modelId.trim())?.modelId
}

async function runResearchJob(job: Job): Promise<JobRunResult> {
  const { runDeepResearch } = require('./deepResearch') as typeof import('./deepResearch')
  const { formatResearch } = require('./toolHandlers/research') as typeof import('./toolHandlers/research')
  if (getSettings().research.confirmPlan) {
    return { outcome: 'skipped', note: 'Research plans need confirmation (Settings → Search); a job cannot confirm one.' }
  }
  const modelId = job.args.modelId ?? firstEnabledModel()
  if (!modelId) return { outcome: 'failed', note: 'No enabled model to research with.' }
  const outcome = await runDeepResearch({ question: job.args.question ?? '', depth: job.args.depth ?? 'standard', modelId })
  const formatted = formatResearch(outcome)
  if (!formatted.ok) return { outcome: 'failed', note: formatted.error ?? 'Research failed.' }
  return {
    outcome: 'ok',
    note: `${outcome.sources?.length ?? 0} source(s)`,
    digest: `**${job.title}** — re-run ${dateLine()}\n\n${formatted.output ?? ''}`
  }
}

async function runPriceJob(job: Job): Promise<JobRunResult> {
  const { fetchWebpage } = require('./search') as typeof import('./search')
  const { extractProduct } = require('./productExtract') as typeof import('./productExtract')
  const { readWatchlist, recordPrice } = require('./watchlist') as typeof import('./watchlist')
  const settings = getSettings()
  if (settings.shopping.requireProxy && settings.proxy.mode === 'none') {
    return { outcome: 'skipped', note: 'Shopping requires a proxy (Settings → Privacy) and none is set.' }
  }
  const url = job.args.url ?? ''
  const entry = (await readWatchlist()).find((w) => w.url === url)
  if (!entry) return { outcome: 'failed', note: 'This item is no longer on the watchlist.' }
  const page = await fetchWebpage(url, 'shop')
  if (!page.ok) return { outcome: 'failed', note: page.error ?? 'Could not fetch the page.' }
  const product = extractProduct(page.rawHtml ?? '', url, page.text)
  if (typeof product.price !== 'number') {
    return { outcome: 'failed', note: 'The page shows no price the app can read.' }
  }
  const recorded = await recordPrice(url, product.price, product.currency, Date.now())
  const cur = product.currency ?? entry.currency ?? ''
  const line =
    recorded.previous === null || recorded.previous === undefined
      ? `first check: ${cur}${product.price}`
      : recorded.changed
        ? `${cur}${recorded.previous} → ${cur}${product.price}`
        : `unchanged at ${cur}${product.price}`
  return {
    outcome: 'ok',
    note: line + (recorded.hitTarget ? ' — at or below your target' : ''),
    digest: `**${entry.name}** — price check ${dateLine()}\n\n${line}${recorded.hitTarget ? `\n\n🎯 At or below your target of ${cur}${entry.targetPrice}.` : ''}\n\n${url}`
  }
}

async function runLedgerJob(): Promise<JobRunResult> {
  const { readAppPack, writeAppPack } = require('./library') as typeof import('./library')
  const { LEDGER_PACK_ID, LEDGER_PACK_NAME } = require('../../shared/factLedger') as typeof import('../../shared/factLedger')
  const { fetchWebpage } = require('./search') as typeof import('./search')
  const pack = await readAppPack(LEDGER_PACK_ID)
  const now = Date.now()
  const expired = (pack?.docs ?? []).filter((d) => d.claim && typeof d.expiresAt === 'number' && now > d.expiresAt)
  if (expired.length === 0) return { outcome: 'ok', note: 'nothing past its freshness' }
  const lines: string[] = []
  let confirmed = 0
  for (const doc of expired.slice(0, 10)) {
    const page = doc.source ? await fetchWebpage(doc.source, 'webpage') : null
    const value = doc.claim!.value.toLowerCase()
    const still = page?.ok === true && page.text.toLowerCase().replace(/\s+/g, ' ').includes(value)
    if (still) {
      confirmed += 1
      doc.checkedAt = now
      doc.expiresAt = doc.expiresAt === null ? null : now + (doc.expiresAt! - (doc.checkedAt ?? now)) // same window again
      doc.date = `checked ${new Date(now).toISOString().slice(0, 10)}`
      lines.push(`✅ still states ${doc.claim!.value}: ${doc.title}`)
    } else {
      lines.push(`⚠️ no longer states ${doc.claim!.value}${page?.ok ? '' : ' (page unavailable)'}: ${doc.title} — ${doc.source ?? ''}`)
    }
  }
  if (confirmed > 0 && pack) {
    await writeAppPack({ id: LEDGER_PACK_ID, name: LEDGER_PACK_NAME, description: pack.manifest.description, docs: pack.docs })
  }
  return {
    outcome: 'ok',
    note: `${confirmed}/${expired.length} re-confirmed`,
    digest: `**Verified claims** — re-check ${dateLine()}\n\n${lines.join('\n')}${expired.length > 10 ? `\n\n(${expired.length - 10} more past freshness; the next run continues)` : ''}`
  }
}

async function runPacksJob(): Promise<JobRunResult> {
  const { listPacks, checkPackFreshness } = require('./library') as typeof import('./library')
  const tracked = (await listPacks()).filter((p) => p.kind === 'user' && p.sourceFolder)
  if (tracked.length === 0) return { outcome: 'ok', note: 'no tracked folders' }
  const lines: string[] = []
  let drifted = 0
  for (const p of tracked) {
    const r = await checkPackFreshness(p.id)
    if (!r.supported) continue
    if (r.missingFolder) {
      drifted += 1
      lines.push(`⚠️ ${p.name}: the folder is gone (${p.sourceFolder})`)
    } else if (!r.fresh) {
      drifted += 1
      lines.push(`✏️ ${p.name}: ${r.added} added, ${r.changed} changed, ${r.removed} removed — update it under Settings → Library`)
    } else {
      lines.push(`✅ ${p.name}: current`)
    }
  }
  return {
    outcome: 'ok',
    note: drifted === 0 ? `${tracked.length} folder(s) current` : `${drifted} folder(s) changed`,
    digest: drifted === 0 ? undefined : `**Tracked folders** — check ${dateLine()}\n\n${lines.join('\n')}`
  }
}

export const SHIPPED_RUNNERS: Record<JobKind, JobRunner> = {
  research: runResearchJob,
  price: runPriceJob,
  ledger: runLedgerJob,
  packs: runPacksJob
}

// ---- wiring ----------------------------------------------------------------------

const TICK_MS = 60_000
const FIRST_TICK_MS = 30_000

function deliverToWindows(job: Job, digest: string): boolean {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  if (wins.length === 0) return false
  for (const w of wins) w.webContents.send('jobs:digest', { conversationId: job.digestConversationId, title: job.title, content: digest })
  return true
}

let scheduler: Scheduler | null = null

export function jobScheduler(): Scheduler {
  if (!scheduler) {
    scheduler = createScheduler({
      runners: SHIPPED_RUNNERS,
      deliver: deliverToWindows,
      audit: (job, result) =>
        recordAuditEntry({
          conversationId: job.digestConversationId,
          kind: 'tool_call',
          toolName: `job:${job.kind}`,
          ok: result.outcome !== 'failed',
          text: `${job.title}\n→ ${result.outcome}: ${result.note}`
        }),
      now: () => Date.now(),
      read: readJobs,
      write: writeJobs
    })
  }
  return scheduler
}

export function registerJobHandlers(): void {
  ipcMain.handle('jobs:list', () => readJobs())
  ipcMain.handle('jobs:add', async (_e, input: unknown) => {
    try {
      return { ok: true, job: await addJob((input ?? {}) as Parameters<typeof addJob>[0]) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('jobs:update', async (_e, id: unknown, patch: unknown) => {
    const job = await updateJob(String(id ?? ''), (patch ?? {}) as Parameters<typeof updateJob>[1])
    return job ? { ok: true, job } : { ok: false, error: 'No such job.' }
  })
  ipcMain.handle('jobs:remove', async (_e, id: unknown) => ({ ok: true, ...(await removeJob(String(id ?? ''))) }))
  ipcMain.handle('jobs:runNow', async (_e, id: unknown) => {
    const r = await jobScheduler().runNow(String(id ?? ''))
    return r ? { ok: true, ...r } : { ok: false, error: jobScheduler().busy() ? 'A job is already running.' : 'No such job.' }
  })
  ipcMain.handle('watchlist:list', async () => {
    const { readWatchlist } = require('./watchlist') as typeof import('./watchlist')
    return readWatchlist()
  })

  const first = setTimeout(() => void jobScheduler().tick(), FIRST_TICK_MS)
  const periodic = setInterval(() => void jobScheduler().tick(), TICK_MS)
  app.on('will-quit', () => {
    clearTimeout(first)
    clearInterval(periodic)
  })
}
