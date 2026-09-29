// Settings → Jobs (v4.0, S4): each standing question a card with its
// switch, its interval, Run now and a two-click Remove; the add-a-job form
// folded until wanted. A job is a tool the user already ran once, re-run on a
// schedule while the app is open, its result delivered to a digest
// conversation of its own.
import { useCallback, useEffect, useState } from 'react'
import type { Job, JobInterval, JobKind } from '../../types'
import { describeInterval, JOB_KIND_LABELS, MAX_JOB_FAILURES } from '../../../../shared/jobs'
import { defineRows, registerRows } from '../../lib/settingsKit'
import { Button, Card, DangerRow, Field, Fold, Notice, Row, Section, Select, StatusDot, Switch, type ActionResult } from './kit'

export const ROWS = defineRows('jobs', {
  jobs: { label: 'Standing questions', help: `A job re-runs something you already ran once — a research question, a watched price, the verified claims past their freshness, the tracked pack folders — on a schedule, while this app is open and only then. Each result is a message in a conversation named after the job. Every run is in the audit log; every request it makes is under Activity. A job never runs a tool that asks for confirmation. After ${MAX_JOB_FAILURES} failures in a row it switches itself off and says why.`, keywords: ['schedule', 'digest', 'recurring', 'cron'] },
  kind: { label: 'Kind', help: 'What is re-run.', keywords: ['job', 'add'] },
  interval: { label: 'How often', help: 'The first run is on the next tick after you add it.', keywords: ['hourly', 'daily', 'weekly'] },
  question: { label: 'Question', help: 'The research question, as you would type it.', keywords: ['research'] },
  depth: { label: 'Depth', help: 'The deep research budget for each run.', keywords: ['quick', 'standard', 'thorough'] },
  watchedItem: { label: 'Watched item', help: 'An item already on the price_watch list.', keywords: ['price', 'watchlist'] }
})
registerRows(ROWS)

const REFRESH_MS = 5000

function when(ms: number | undefined): string {
  if (!ms) return '—'
  const d = new Date(ms)
  return `${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 5)}`
}

export function JobsTab(): JSX.Element {
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [watches, setWatches] = useState<{ url: string; name: string }[]>([])
  const [notice, setNotice] = useState<ActionResult | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [kind, setKind] = useState<JobKind>('research')
  const [question, setQuestion] = useState('')
  const [depth, setDepth] = useState<'quick' | 'standard' | 'thorough'>('standard')
  const [url, setUrl] = useState('')
  const [interval, setIntervalValue] = useState<JobInterval>('daily')

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
    const r = await window.api.jobsAdd({ kind, interval, args: kind === 'research' ? { question, depth } : kind === 'price' ? { url } : {} })
    setNotice(r.ok ? { tone: 'ok', text: `Added. It runs on the next tick, then ${describeInterval(interval)}; its digests land in a conversation named after it.` } : { tone: 'danger', text: r.error ?? 'Could not add the job.' })
    if (r.ok) {
      setQuestion('')
      setFormOpen(false)
    }
    await refresh()
  }

  const tone = (j: Job): 'ok' | 'warn' | 'danger' | 'muted' => (!j.enabled ? 'muted' : j.lastOutcome === 'failed' ? 'danger' : j.lastOutcome === 'skipped' ? 'warn' : 'ok')

  return (
    <div className="space-y-8">
      <Section title="Standing questions" description={ROWS.jobs.help} right={<Button kind="primary" onClick={() => setFormOpen((o) => !o)}>{formOpen ? 'Close' : 'Add a job…'}</Button>}>
        <Row meta={ROWS.jobs} bare>
          <div className="space-y-3">
            {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
            <Fold title="Add a job" summary="runs on the next tick, then on its schedule" open={formOpen} onToggle={setFormOpen}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Row meta={ROWS.kind} layout="stack">
                  <Select value={kind} onChange={(v) => setKind(v as JobKind)} options={(Object.keys(JOB_KIND_LABELS) as JobKind[]).map((k) => ({ value: k, label: JOB_KIND_LABELS[k] }))} />
                </Row>
                <Row meta={ROWS.interval} layout="stack">
                  <Select
                    value={interval}
                    onChange={(v) => setIntervalValue(v as JobInterval)}
                    options={[
                      { value: 'hourly', label: 'every hour' },
                      { value: 'daily', label: 'every day' },
                      { value: 'weekly', label: 'every week' }
                    ]}
                  />
                </Row>
              </div>
              {kind === 'research' && (
                <>
                  <Row meta={ROWS.question} layout="stack">
                    <Field value={question} onChange={setQuestion} onCommit={setQuestion} placeholder="What changed in the local planning rules this week?" />
                  </Row>
                  <Row meta={ROWS.depth} layout="stack">
                    <Select
                      value={depth}
                      onChange={(v) => setDepth(v as 'quick' | 'standard' | 'thorough')}
                      options={[
                        { value: 'quick', label: 'quick' },
                        { value: 'standard', label: 'standard' },
                        { value: 'thorough', label: 'thorough' }
                      ]}
                    />
                  </Row>
                </>
              )}
              {kind === 'price' && (
                <Row meta={ROWS.watchedItem} layout="stack">
                  {watches.length === 0 ? (
                    <Notice tone="muted">Nothing on the watchlist — ask a model to price_watch an item first.</Notice>
                  ) : (
                    <Select value={url} onChange={setUrl} options={watches.map((w) => ({ value: w.url, label: w.name }))} />
                  )}
                </Row>
              )}
              <Button kind="primary" disabled={(kind === 'research' && !question.trim()) || (kind === 'price' && !url)} onClick={() => void add()}>
                Add job
              </Button>
            </Fold>

            {jobs === null ? (
              <p className="text-xs text-ink-tertiary">Loading…</p>
            ) : jobs.length === 0 ? (
              <Notice tone="muted">No jobs.</Notice>
            ) : (
              jobs.map((j) => (
                <Card
                  key={j.id}
                  title={
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <StatusDot tone={tone(j)} />
                      <span className="truncate" title={j.title}>
                        {j.title}
                      </span>
                    </span>
                  }
                  status={`${JOB_KIND_LABELS[j.kind]} · ${describeInterval(j.interval)} · next ${j.enabled ? when(j.nextAt) : 'off'} · last ${j.lastRunAt ? `${when(j.lastRunAt)} (${j.lastOutcome})` : 'never'}${j.failures > 0 ? ` · ${j.failures} failure${j.failures === 1 ? '' : 's'} in a row` : ''}`}
                  right={
                    <>
                      <Select
                        compact
                        label={`${j.title} interval`}
                        value={j.interval}
                        onChange={(v) => void window.api.jobsUpdate(j.id, { interval: v as JobInterval }).then(refresh)}
                        options={[
                          { value: 'hourly', label: 'hourly' },
                          { value: 'daily', label: 'daily' },
                          { value: 'weekly', label: 'weekly' }
                        ]}
                      />
                      <Button
                        onClick={() =>
                          void window.api.jobsRunNow(j.id).then((r) => {
                            setNotice(r.ok ? { tone: 'ok', text: `Ran: ${r.outcome} — ${r.note}` } : { tone: 'danger', text: r.error ?? 'Could not run it.' })
                            void refresh()
                          })
                        }
                      >
                        Run now
                      </Button>
                      <DangerRow variant="inline" label="" action="Remove" confirm="Remove this job?" onConfirm={() => window.api.jobsRemove(j.id).then(refresh)} />
                      <Switch label={`${j.title} enabled`} checked={j.enabled} onChange={(enabled) => void window.api.jobsUpdate(j.id, { enabled }).then(refresh)} />
                    </>
                  }
                >
                  {j.lastNote && <p className="text-xs text-ink-tertiary">{j.lastNote}</p>}
                </Card>
              ))
            )}
          </div>
        </Row>
      </Section>
    </div>
  )
}
