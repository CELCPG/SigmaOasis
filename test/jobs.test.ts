import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { load, resetState, state, testUserDataDir } from './harness'
import { afterRun, dueJobs, JOB_INTERVAL_MS, MAX_JOB_FAILURES } from '../src/shared/jobs'
import { claimKey, expiresAtFor, LEDGER_PACK_ID } from '../src/shared/factLedger'
import type { ClaimClass } from '../src/shared/factLedger'
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
        ledger: async () => ({ outcome: 'ok', note: 'nothing' }),
        agent: async () => ({ outcome: 'ok', note: '' })
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
        ledger: async () => ({ outcome: 'ok', note: '' }),
        agent: async () => ({ outcome: 'ok', note: '' })
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
    // v4.0 (C5): the agent kind is an experiment, refused while its switch is off.
    await assert.rejects(() => jobsMod.addJob({ kind: 'agent', args: { folder: '/somewhere', prompt: 'Summarize' } }), /an experiment/)
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

describe('the ledger runner', () => {
  const jobsMod = load<typeof import('../src/main/ipc/jobs')>('jobs')
  const ledger = load<typeof import('../src/main/ipc/factLedger')>('factLedger')
  const lib = load<typeof import('../src/main/ipc/library')>('library')
  const DAY = 24 * HOUR
  let dir = ''

  const draft = (claimClass: ClaimClass, question: string, value: string, sentence: string, url: string) => ({
    key: claimKey(claimClass, question),
    claimClass,
    value,
    sentence,
    url,
    question
  })

  /** One ledger run at `at` on the ledger's clock: what it said, and which pages it fetched. */
  const run = async (at: number): Promise<{ note: string; digest: string; fetched: string[] }> => {
    process.env.SIGMA_LEDGER_NOW = String(at)
    state.fetchLog = []
    const r = await jobsMod.SHIPPED_RUNNERS.ledger(job({ kind: 'ledger' }))
    return { note: r.note, digest: r.digest ?? '', fetched: state.fetchLog.map((f) => f.url) }
  }

  beforeEach(() => {
    resetState()
    dir = mkdtempSync(join(tmpdir(), 'sigma-ledger-job-'))
    lib.setLibraryDirForTests(dir)
  })
  afterEach(() => {
    delete process.env.SIGMA_LEDGER_NOW
    lib.setLibraryDirForTests(null)
    rmSync(dir, { recursive: true, force: true })
  })

  test('a claim its source still states is fresh for its class’s window again; one it no longer states stays expired', async () => {
    process.env.SIGMA_LEDGER_NOW = String(T0)
    await ledger.upsertClaims([
      draft('money', 'How much is an adult ticket to the Harrowgate Maritime Museum?', '$18.50', 'An adult ticket costs $18.50.', 'https://harrowgate.example/visit'),
      draft('contact', 'What is the Harrowgate Maritime Museum’s phone number?', '(555) 014-2290', 'Call (555) 014-2290.', 'https://harrowgate.example/contact')
    ])
    // Past both windows: a price holds a day, a phone number 180.
    const later = T0 + 181 * DAY
    process.env.SIGMA_LEDGER_NOW = String(later)
    state.responses = [
      { match: 'harrowgate.example/visit', contentType: 'text/html', body: '<html><body><p>Adult tickets cost $18.50.</p></body></html>' },
      { match: 'harrowgate.example/contact', contentType: 'text/html', body: '<html><body><p>Call us on (555) 014-9999.</p></body></html>' }
    ]

    const first = await jobsMod.SHIPPED_RUNNERS.ledger(job({ kind: 'ledger' }))
    assert.equal(first.note, '1/2 re-confirmed')
    const docs = (await lib.readAppPack(LEDGER_PACK_ID))!.docs
    const price = docs.find((d) => d.claim?.claimClass === 'money')!
    const phone = docs.find((d) => d.claim?.claimClass === 'contact')!
    // Re-confirmed is refreshed, as upsertClaims refreshes a claim a reply states again.
    assert.equal(price.expiresAt, expiresAtFor('money', later))
    assert.equal(price.checkedAt, later)
    const day = new Date(later).toISOString().slice(0, 10)
    assert.equal(price.date, `checked ${day}`)
    assert.match(price.text, new RegExp(`\\nChecked: ${day}\\n`))
    // Not re-confirmed is left as it was: still expired, still dated when it was last true.
    assert.equal(phone.expiresAt, expiresAtFor('contact', T0))
    assert.equal(phone.checkedAt, T0)
    assert.deepEqual(await ledger.ledgerStats(), { entries: 2, expired: 1 })

    // The next run re-checks only what is still past its freshness.
    state.fetchLog = []
    const second = await jobsMod.SHIPPED_RUNNERS.ledger(job({ kind: 'ledger' }))
    assert.equal(second.note, '0/1 re-confirmed')
    assert.deepEqual(state.fetchLog.map((f) => f.url), ['https://harrowgate.example/contact'])
  })

  test('a claim that no longer holds goes to the back of the queue, so every expired claim is re-checked in turn', async () => {
    // Two more expired claims than a run re-checks; only the last one's source still states it.
    const batch = jobsMod.LEDGER_RECHECKS_PER_RUN
    const n = batch + 2
    const items = Array.from({ length: n }, (_, i) => `item${String(i + 1).padStart(2, '0')}`)
    const url = (item: string): string => `https://museum.example/${item}/`
    process.env.SIGMA_LEDGER_NOW = String(T0)
    await ledger.upsertClaims(items.map((item) => draft('money', `How much is the ${item} pass?`, '$18.50', `The ${item} pass costs $18.50.`, url(item))))
    state.responses = items.map((item, i) => ({
      match: `museum.example/${item}/`,
      contentType: 'text/html',
      body: `<html><body><p>The ${item} pass costs ${i === n - 1 ? '$18.50' : '$21.00'}.</p></body></html>`
    }))

    const first = await run(T0 + 2 * DAY)
    assert.equal(first.note, `0/${n} re-confirmed`)
    assert.deepEqual(first.fetched, items.slice(0, batch).map(url))
    // The next run starts with the two it has not tried, not the ten that just
    // failed, and fills its batch with the failures it tried longest ago.
    const second = await run(T0 + 2 * DAY + HOUR)
    assert.equal(second.note, `1/${n} re-confirmed`)
    assert.deepEqual(second.fetched, [...items.slice(batch), ...items.slice(0, batch - 2)].map(url))
    // And the queue keeps turning: the two failures left out last time lead this
    // one. (The eight behind them fail for the third time in a row and are dropped.)
    const third = await run(T0 + 2 * DAY + 2 * HOUR)
    assert.equal(third.note, `0/${n - 1} re-confirmed, ${batch - 2} dropped`)
    assert.deepEqual(third.fetched, [...items.slice(batch - 2, batch), ...items.slice(0, batch - 2)].map(url))
  })

  test('a claim is dropped when its source has not stated it for three re-checks in a row', async () => {
    assert.equal(jobsMod.LEDGER_MAX_RECHECK_FAILURES, 3)
    const url = (name: string): string => `https://museum.example/${name}/`
    const page = (name: string, price: string) => ({
      match: `museum.example/${name}/`,
      contentType: 'text/html',
      body: `<html><body><p>The ${name} pass costs ${price}.</p></body></html>`
    })
    // changed: the page now states another price. deleted: the page is gone.
    // down: the page cannot be reached. flaky: wrong twice, then right, then wrong again.
    const names = ['changed', 'deleted', 'down', 'flaky']
    process.env.SIGMA_LEDGER_NOW = String(T0)
    await ledger.upsertClaims(names.map((name) => draft('money', `How much is the ${name} pass?`, '$18.50', `The ${name} pass costs $18.50.`, url(name))))
    const responses = (flaky: string) => [
      page('changed', '$21.00'),
      { match: 'museum.example/deleted/', contentType: 'text/html', body: '', status: 404 },
      { match: 'museum.example/down/', contentType: 'text/html', body: '', status: 503 },
      page('flaky', flaky)
    ]
    const claims = async () =>
      Object.fromEntries(((await lib.readAppPack(LEDGER_PACK_ID))?.docs ?? []).map((d) => [d.source!.split('/')[3], d]))
    const t1 = T0 + 2 * DAY

    state.responses = responses('$21.00')
    assert.equal((await run(t1)).note, '0/4 re-confirmed')
    assert.equal((await run(t1 + HOUR)).note, '0/4 re-confirmed')
    let now = await claims()
    assert.deepEqual([now.changed?.recheckFailures, now.deleted?.recheckFailures, now.flaky?.recheckFailures], [2, 2, 2])
    // An unreachable page checked nothing, so it counts for nothing: an outage
    // or a proxy that is down must not empty the ledger.
    assert.equal(now.down?.recheckFailures, undefined)

    // Third time: the two that are still wrong go; flaky is right again, and its streak ends.
    state.responses = responses('$18.50')
    const third = await run(t1 + 2 * HOUR)
    assert.equal(third.note, '1/4 re-confirmed, 2 dropped')
    assert.match(third.digest, /🗑️ dropped \$18\.50 .*The changed pass costs/)
    assert.match(third.digest, /🗑️ dropped \$18\.50 .*The deleted pass costs/)
    assert.match(third.digest, /could not re-check \$18\.50 .*The down pass costs/)
    now = await claims()
    assert.deepEqual(Object.keys(now).sort(), ['down', 'flaky'])
    assert.equal(now.flaky?.recheckFailures, undefined)
    assert.deepEqual(await ledger.ledgerStats(), { entries: 2, expired: 1 })

    // Past flaky's new window it is wrong again: a first failure, not a third.
    state.responses = responses('$21.00')
    const fourth = await run(t1 + 2 * HOUR + 2 * DAY)
    assert.equal(fourth.note, '0/2 re-confirmed')
    assert.match(fourth.digest, /no longer states \$18\.50 \(1 of 3 in a row\).*The flaky pass costs/)
    now = await claims()
    assert.deepEqual(Object.keys(now).sort(), ['down', 'flaky'])
    assert.equal(now.flaky?.recheckFailures, 1)
  })

  test('dropping the last claim removes the ledger pack rather than leaving it empty', async () => {
    process.env.SIGMA_LEDGER_NOW = String(T0)
    await ledger.upsertClaims([draft('money', 'How much is the only pass?', '$18.50', 'The only pass costs $18.50.', 'https://museum.example/only/')])
    state.responses = [{ match: 'museum.example/only/', contentType: 'text/html', body: '<html><body><p>The only pass costs $21.00.</p></body></html>' }]
    for (let i = 0; i < 3; i++) await run(T0 + 2 * DAY + i * HOUR)
    assert.equal(await lib.readAppPack(LEDGER_PACK_ID), null)
    assert.deepEqual(await lib.listPacks(), [])
    assert.deepEqual(await ledger.ledgerStats(), { entries: 0, expired: 0 })
    assert.equal((await run(T0 + 3 * DAY)).note, 'nothing past its freshness')
  })
})
