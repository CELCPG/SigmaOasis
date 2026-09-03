// v2.6: Settings → Jobs — standing questions. A job is a tool the user already ran once,
// re-run on a schedule while the app is open, its result delivered as a message in a digest
// conversation of its own. Self-fetching, like the MCP tab: jobs are not a setting.
import React, { useCallback, useEffect, useState } from 'react'
import type { Job, JobInterval, JobKind } from '../../types'
import { describeInterval, JOB_KIND_LABELS, MAX_JOB_FAILURES } from '../../../../shared/jobs'

const REFRESH_MS = 5000
const BUTTON = 'rounded-lg border border-black/10 dark:border-white/10 px-2.5 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40'

function when(ms: number | undefined): string {
  if (!ms) return '—'
  const d = new Date(ms)
  return `${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 5)}`
}

export function JobsTab(): JSX.Element {
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [watches, setWatches] = useState<{ url: string; name: string }[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [kind, setKind] = useState<JobKind>('research')
  const [question, setQuestion] = useState('')
  const [depth, setDepth] = useState<'quick' | 'standard' | 'thorough'>('standard')
  const [url, setUrl] = useState('')
  const [interval, setInterval_] = useState<JobInterval>('daily')

  const refresh = useCallback(async () => {
    const [list, w] = await Promise.all([window.api.jobsList().catch(() => []), window.api.watchlistList().catch(() => [])])
    setJobs(list)
    setWatches(w)
    if (!url && w[0]) setUrl(w[0].url)
  }, [url])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), REFRESH_MS)
    return () => clearInterval(t)
  }, [refresh])

  const add = async (): Promise<void> => {
    const r = await window.api.jobsAdd({
      kind,
      interval,
      args: kind === 'research' ? { question, depth } : kind === 'price' ? { url } : {}
    })
    setNotice(r.ok ? `Added. It runs on the next tick, then ${describeInterval(interval)}; its digests land in a conversation named after it.` : (r.error ?? 'Could not add the job.'))
    if (r.ok) setQuestion('')
    await refresh()
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-sm font-medium">Standing questions</div>
        <p className="mt-1 text-xs text-ink-secondary">
          A job re-runs something you already ran once — a research question, a watched price, the
          verified claims past their freshness, the tracked pack folders — on a schedule, while this
          app is open and only then. Each result is a message in a conversation named after the job.
          Every run is in the audit log; every request it makes is in the network activity log. A job
          never runs a tool that asks for confirmation. After {MAX_JOB_FAILURES} failures in a row it
          switches itself off and says why.
        </p>
      </div>

      {notice && (
        <p className="rounded-lg bg-amber-500/10 p-3 text-sm text-ink-primary" role="status">
          {notice}
        </p>
      )}

      {jobs === null ? (
        <p className="text-sm text-ink-tertiary">Loading…</p>
      ) : jobs.length === 0 ? (
        <p className="text-sm text-ink-tertiary">No jobs.</p>
      ) : (
        <ul className="space-y-3">
          {jobs.map((j) => (
            <li key={j.id} className="glass-panel rounded-xl p-3">
              <div className="flex items-center gap-3">
                <span
                  className={`inline-block h-2.5 w-2.5 rounded-full ${!j.enabled ? 'bg-ink-muted' : j.lastOutcome === 'failed' ? 'bg-red-500' : j.lastOutcome === 'skipped' ? 'bg-amber-500' : 'bg-emerald-500'}`}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium" title={j.title}>
                    {j.title}
                  </div>
                  <div className="text-xs text-ink-secondary">
                    {JOB_KIND_LABELS[j.kind]} · {describeInterval(j.interval)} · next {j.enabled ? when(j.nextAt) : 'off'} · last{' '}
                    {j.lastRunAt ? `${when(j.lastRunAt)} (${j.lastOutcome})` : 'never'}
                    {j.failures > 0 ? ` · ${j.failures} failure${j.failures === 1 ? '' : 's'} in a row` : ''}
                  </div>
                  {j.lastNote && <div className="text-xs text-ink-tertiary">{j.lastNote}</div>}
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={j.enabled}
                    onChange={(e) => void window.api.jobsUpdate(j.id, { enabled: e.target.checked }).then(refresh)}
                    aria-label={`${j.title} enabled`}
                  />
                  On
                </label>
                <select
                  className="rounded-lg text-xs"
                  value={j.interval}
                  onChange={(e) => void window.api.jobsUpdate(j.id, { interval: e.target.value as JobInterval }).then(refresh)}
                  aria-label={`${j.title} interval`}
                >
                  <option value="hourly">hourly</option>
                  <option value="daily">daily</option>
                  <option value="weekly">weekly</option>
                </select>
                <button
                  type="button"
                  className={BUTTON}
                  onClick={() =>
                    void window.api.jobsRunNow(j.id).then((r) => {
                      setNotice(r.ok ? `Ran: ${r.outcome} — ${r.note}` : (r.error ?? 'Could not run it.'))
                      void refresh()
                    })
                  }
                >
                  Run now
                </button>
                <button type="button" className={`${BUTTON} text-ink-danger`} onClick={() => void window.api.jobsRemove(j.id).then(refresh)}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="glass-panel rounded-xl p-3">
        <div className="mb-2 text-sm font-medium">Add a job</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs">
            Kind
            <select className="mt-1 w-full" value={kind} onChange={(e) => setKind(e.target.value as JobKind)}>
              {(Object.keys(JOB_KIND_LABELS) as JobKind[]).map((k) => (
                <option key={k} value={k}>
                  {JOB_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            How often
            <select className="mt-1 w-full" value={interval} onChange={(e) => setInterval_(e.target.value as JobInterval)}>
              <option value="hourly">every hour</option>
              <option value="daily">every day</option>
              <option value="weekly">every week</option>
            </select>
          </label>
          {kind === 'research' && (
            <>
              <label className="text-xs sm:col-span-2">
                Question
                <input className="mt-1 w-full" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="What changed in the local planning rules this week?" />
              </label>
              <label className="text-xs">
                Depth
                <select className="mt-1 w-full" value={depth} onChange={(e) => setDepth(e.target.value as 'quick' | 'standard' | 'thorough')}>
                  <option value="quick">quick</option>
                  <option value="standard">standard</option>
                  <option value="thorough">thorough</option>
                </select>
              </label>
            </>
          )}
          {kind === 'price' && (
            <label className="text-xs sm:col-span-2">
              Watched item
              {watches.length === 0 ? (
                <span className="mt-1 block text-ink-tertiary">Nothing on the watchlist — ask a model to <code>price_watch</code> an item first.</span>
              ) : (
                <select className="mt-1 w-full" value={url} onChange={(e) => setUrl(e.target.value)}>
                  {watches.map((w) => (
                    <option key={w.url} value={w.url}>
                      {w.name}
                    </option>
                  ))}
                </select>
              )}
            </label>
          )}
        </div>
        <button
          type="button"
          className="mt-3 rounded-lg bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50"
          disabled={(kind === 'research' && !question.trim()) || (kind === 'price' && !url)}
          onClick={() => void add()}
        >
          Add job
        </button>
      </div>
    </div>
  )
}
