/**
 * v2.6: standing questions — a question the user wants re-asked.
 *
 * A job is a tool the user already ran once, re-run with the same arguments
 * on a schedule while the app is open: a saved deep-research question, a
 * watched price, the verified claims past their freshness, the tracked pack
 * folders. A job never invents a request, never runs a tool that confirms,
 * and delivers its result as a message in a digest conversation of its own.
 * Ten consecutive failures switch it off, with the reason on its row.
 *
 * Pure data and pure scheduling arithmetic, shared by main (the scheduler),
 * the renderer (the panel) and the tests.
 */

export type JobKind = 'research' | 'price' | 'ledger' | 'packs'
export type JobInterval = 'hourly' | 'daily' | 'weekly'
export type JobOutcome = 'ok' | 'failed' | 'skipped'

const HOUR = 3_600_000
export const JOB_INTERVAL_MS: Record<JobInterval, number> = {
  hourly: HOUR,
  daily: 24 * HOUR,
  weekly: 7 * 24 * HOUR
}

export const MAX_JOB_FAILURES = 10

export const JOB_KIND_LABELS: Record<JobKind, string> = {
  research: 'Re-run a research question',
  price: 'Re-check a watched price',
  ledger: 'Re-check verified claims past their freshness',
  packs: 'Check tracked pack folders for changes'
}

export interface JobArgs {
  /** research */
  question?: string
  depth?: 'quick' | 'standard' | 'thorough'
  modelId?: string
  /** price: the watchlist entry's URL */
  url?: string
}

export interface Job {
  id: string
  kind: JobKind
  title: string
  interval: JobInterval
  args: JobArgs
  enabled: boolean
  nextAt: number
  /** Consecutive failures; reset by a run that succeeds or is skipped. */
  failures: number
  lastRunAt?: number
  lastOutcome?: JobOutcome
  lastNote?: string
  /** The conversation the digests land in — one per job, created on first delivery. */
  digestConversationId: string
  /** A digest that could not be delivered (no window); handed over on the next tick that has one. */
  pendingDigest?: string
  createdAt: number
}

export function isDue(job: Job, now: number): boolean {
  return job.enabled && job.nextAt <= now
}

export function dueJobs(jobs: readonly Job[], now: number): Job[] {
  return jobs.filter((j) => isDue(j, now)).sort((a, b) => a.nextAt - b.nextAt)
}

/** The job after a run: rescheduled, its failure count kept, switched off at the cap. */
export function afterRun(job: Job, outcome: JobOutcome, note: string, now: number): Job {
  const failures = outcome === 'failed' ? job.failures + 1 : 0
  const disabled = failures >= MAX_JOB_FAILURES
  return {
    ...job,
    failures,
    enabled: disabled ? false : job.enabled,
    nextAt: now + JOB_INTERVAL_MS[job.interval],
    lastRunAt: now,
    lastOutcome: outcome,
    lastNote: disabled ? `${note} — switched off after ${MAX_JOB_FAILURES} consecutive failures` : note
  }
}

export function describeInterval(interval: JobInterval): string {
  return interval === 'hourly' ? 'every hour' : interval === 'daily' ? 'every day' : 'every week'
}
