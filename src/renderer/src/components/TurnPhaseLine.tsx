import { useEffect, useState } from 'react'
import { startWaitClock } from '../lib/oasisRipple'
import { VERIFY_BUDGET_MS, waitElapsed, type TurnPhase } from '../lib/turnPhase'

/**
 * The named wait. Before the model is asked, a context provider can hold the
 * turn open on the network; after the last token, the checks run for seconds
 * more. Both used to be a spinner over an unexplained pause — this says which
 * one it is, and (while verifying) that the answer above is already yours to
 * use. Same shape as the compaction line in ChatArea, deliberately.
 *
 * v1.12.6: the gathering half also counts. Naming the wait told the reader WHAT
 * they were waiting on and never that they were STILL waiting, or how long they
 * had been — and the label changes as the walk moves from the search to the
 * library, so the only thing on screen reset while the wait did not. The count
 * runs from the turn's opening (`phase.since`), which is the same origin the
 * stat line's "gathering" figure is measured from, so the number the reader
 * watches climb is the number they are shown afterwards.
 */
export function TurnPhaseLine({ phase }: { phase: TurnPhase }): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  // Wall clock rather than a tick count: Chromium throttles intervals in an
  // occluded window, which must make the counter update less often, never wrongly.
  useEffect(() => {
    setNow(Date.now())
    return startWaitClock(() => setNow(Date.now()))
  }, [phase.stage, phase.since])
  return (
    <div
      className="mt-2 flex items-center gap-2 text-[11px]"
      style={{ color: 'var(--accent-ink)' }}
      role="status"
      aria-live="polite"
      title={
        phase.stage === 'verifying'
          ? `The reply is complete and you can copy, read or branch it now. These checks run on top of it; if one finds something, the reply is revised and the change is disclosed. After ${VERIFY_BUDGET_MS / 1000}s no further check is started and the line says what was left unchecked — a check already running is left to finish, so the wait can be longer than that.`
          : 'The app is gathering context for this turn — the model has not been asked yet. The count is how long that has taken so far, and it is the “gathering” figure in the stat line once the turn ends.'
      }
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent shadow-[0_0_8px_rgba(0,212,170,0.8)]" />
      <span className="font-medium tracking-[0.08em]">{phase.label}…</span>
      {phase.stage === 'gathering' && (
        <span className="tabular-nums text-ink-secondary">{waitElapsed(phase, now)}</span>
      )}
      <span className="min-w-0 truncate text-ink-secondary">{phase.detail}</span>
    </div>
  )
}
