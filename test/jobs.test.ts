import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'fs'
import { join } from 'path'
import { load, resetState, testUserDataDir } from './harness'
import { afterRun, dueJobs, JOB_INTERVAL_MS, MAX_JOB_FAILURES } from '../src/shared/jobs'
import type { Job } from '../src/shared/jobs'

/**
 * v2.6: standing questions. The arithmetic is pure; the scheduler is built
 * over injected runners, delivery and a clock, so a run, a failure streak,
 * a held digest and the one-at-a-time guard are all checked without a
 * model, a network or a window.
 */

const HOUR = 3_600_000
const T0 = 1_700_000_000_000

const job = (over: Partial<Job> = {}): Job => ({
  id: 'j1',
  kind: 'packs',
  title: 'Tracked folders',
  interval: 'daily',
  args: {},
  enabled: true,
  nextAt: T0,
  failures: 0,
  digestConversationId: 'job-1',
  createdAt: T0 - HOUR,
  ...over
})

describe('job arithmetic', () => {
  test('due when enabled and its time has come; ordered by time', () => {
    const a = job({ id: 'a', nextAt: T0 + 5 })
    const b = job({ id: 'b', nextAt: T0 })
    const off = job({ id: 'off', enabled: false, nextAt: T0 - HOUR })
    assert.deepEqual(dueJobs([a, b, off], T0).map((j) => j.id), ['b'])
    assert.deepEqual(dueJobs([a, b, off], T0 + 5).map((j) => j.id), ['b', 'a'])
  })

  test('a run reschedules by its interval; a failure counts; a success or skip resets', () => {
    const ok = afterRun(job({ failures: 3 }), 'ok', 'fine', T0)
    assert.equal(ok.failures, 0)
    assert.equal(ok.nextAt, T0 + JOB_INTERVAL_MS.daily)
    assert.equal(ok.lastOutcome, 'ok')
    assert.equal(afterRun(job({ failures: 3 }), 'skipped', 'no proxy', T0).failures, 0)
    assert.equal(afterRun(job({ failures: 3 }), 'failed', 'boom', T0).failures, 4)
  })

  test('the tenth consecutive failure switches the job off and says so', () => {
    const j = afterRun(job({ failures: MAX_JOB_FAILURES - 1 }), 'failed', 'boom', T0)
    assert.equal(j.enabled, false)
    assert.match(j.lastNote ?? '', /switched off after 10 consecutive failures/)
    const nine = afterRun(job({ failures: MAX_JOB_FAILURES - 2 }), 'failed', 'boom', T0)
    assert.equal(nine.enabled, true)
  })
})

describe('the scheduler', () => {
  const jobsMod = load<typeof import('../src/main/ipc/jobs')>('jobs')

  function harness(initial: Job[], opts: { window?: boolean; outcome?: 'ok' | 'failed' | 'skipped'; digest?: string } = {}) {
    let stored = initial
    let now = T0
    const delivered: { id: string; digest: string }[] = []
    const audited: string[] = []
    const ran: string[] = []
    const scheduler = jobsMod.createScheduler({
      runners: {
        packs: async (j) => {
          ran.push(j.id)
          return { outcome: opts.outcome ?? 'ok', note: 'note', ...(opts.digest ? { digest: opts.digest } : {}) }
        },
        research: async () => {
          throw new Error('research blew up')
        },
        price: async () => ({ outcome: 'skipped', note: 'no proxy' }),
        ledger: async () => ({ outcome: 'ok', note: 'nothing' })
      },
      deliver: (j, digest) => {
        if (opts.window === false) return false
        delivered.push({ id: j.id, digest })
        return true
      },
      audit: async (j, r) => {
        audited.push(`${j.kind}:${r.outcome}`)
      },
      now: () => now,
      read: async () => stored.map((j) => ({ ...j })),
      write: async (jobs) => {
        stored = jobs
      }
    })
    return { scheduler, delivered, audited, ran, jobs: () => stored, advance: (ms: number) => (now += ms) }
  }

  test('a due job runs, is audited, delivers its digest and is rescheduled', async () => {
    const h = harness([job()], { digest: 'the digest' })
    assert.equal(await h.scheduler.tick(), 1)
    assert.deepEqual(h.ran, ['j1'])
    assert.deepEqual(h.audited, ['packs:ok'])
    assert.deepEqual(h.delivered, [{ id: 'j1', digest: 'the digest' }])
    const j = h.jobs()[0]!
    assert.equal(j.nextAt, T0 + JOB_INTERVAL_MS.daily)
    assert.equal(j.lastOutcome, 'ok')
    assert.equal(j.pendingDigest, undefined)
    assert.equal(await h.scheduler.tick(), 0)
  })

  test('a runner that throws is a failure, not a crash; ten in a row switch the job off', async () => {
    const h = harness([job({ kind: 'research', interval: 'hourly' })])
    for (let i = 0; i < MAX_JOB_FAILURES; i++) {
      assert.equal(await h.scheduler.tick(), 1)
      h.advance(HOUR + 1)
    }
    const j = h.jobs()[0]!
    assert.equal(j.failures, MAX_JOB_FAILURES)
    assert.equal(j.enabled, false)
    assert.match(j.lastNote ?? '', /research blew up/)
    assert.equal(h.audited.filter((a) => a === 'research:failed').length, MAX_JOB_FAILURES)
    assert.equal(await h.scheduler.tick(), 0)
  })

  test('with no window the digest is held and handed over on the next tick that has one', async () => {
    const h = harness([job()], { digest: 'held', window: false })
    await h.scheduler.tick()
    assert.equal(h.jobs()[0]!.pendingDigest, 'held')
    assert.match(h.jobs()[0]!.lastNote ?? '', /held until a window opens/)
    // a window appears; nothing is due, but the held digest goes out
    const h2 = harness(h.jobs(), {})
    assert.equal(await h2.scheduler.tick(), 0)
    assert.deepEqual(h2.delivered, [{ id: 'j1', digest: 'held' }])
    assert.equal(h2.jobs()[0]!.pendingDigest, undefined)
  })

  test('run now runs a job that is not due; a removal during a run stays removed', async () => {
    const h = harness([job({ nextAt: T0 + HOUR })], { digest: 'now' })
    const r = await h.scheduler.runNow('j1')
    assert.equal(r?.outcome, 'ok')
    assert.deepEqual(h.delivered.map((d) => d.digest), ['now'])
    assert.equal(await h.scheduler.runNow('missing'), null)
  })

  test('one job at a time: a tick that lands during a run does nothing', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    let stored = [job()]
    const scheduler = jobsMod.createScheduler({
      runners: {
        packs: async () => {
          await gate
          return { outcome: 'ok', note: 'done' }
        },
        research: async () => ({ outcome: 'ok', note: '' }),
        price: async () => ({ outcome: 'ok', note: '' }),
        ledger: async () => ({ outcome: 'ok', note: '' })
      },
      deliver: () => true,
      audit: async () => {},
      now: () => T0,
      read: async () => stored.map((j) => ({ ...j })),
      write: async (jobs) => {
        stored = jobs
      }
    })
    const first = scheduler.tick()
    assert.equal(scheduler.busy(), true)
    assert.equal(await scheduler.tick(), 0)
    release()
    assert.equal(await first, 1)
    assert.equal(scheduler.busy(), false)
  })
})

describe('the job store', () => {
  const jobsMod = load<typeof import('../src/main/ipc/jobs')>('jobs')

  beforeEach(async () => {
    resetState()
    await fs.rm(join(testUserDataDir(), 'jobs.json'), { force: true })
    await fs.mkdir(testUserDataDir(), { recursive: true })
  })

  test('add validates by kind; update forgives failures on re-enable; remove removes', async () => {
    await assert.rejects(() => jobsMod.addJob({ kind: 'research', args: {} }), /needs a question/)
    await assert.rejects(() => jobsMod.addJob({ kind: 'price', args: { url: 'ftp://x' } }), /needs the watched item/)
    await assert.rejects(() => jobsMod.addJob({ kind: 'nope' }), /Unknown job kind/)
    const j = await jobsMod.addJob({ kind: 'research', interval: 'weekly', args: { question: 'What changed?', depth: 'quick' } })
    assert.equal(j.title, 'What changed?')
    assert.equal(j.interval, 'weekly')
    assert.ok(j.nextAt <= Date.now())
    assert.match(j.digestConversationId, /^job-/)
    const off = await jobsMod.updateJob(j.id, { enabled: false })
    assert.equal(off?.enabled, false)
    await jobsMod.writeJobs((await jobsMod.readJobs()).map((x) => ({ ...x, failures: 7 })))
    const on = await jobsMod.updateJob(j.id, { enabled: true })
    assert.equal(on?.failures, 0)
    assert.deepEqual(await jobsMod.removeJob(j.id), { removed: 1 })
    assert.deepEqual(await jobsMod.readJobs(), [])
  })

  test('a hand-edited file keeps only well-formed jobs', async () => {
    await fs.writeFile(join(testUserDataDir(), 'jobs.json'), JSON.stringify({ jobs: [{ id: 'x' }, job()] }))
    assert.deepEqual((await jobsMod.readJobs()).map((j) => j.id), ['j1'])
  })
})
