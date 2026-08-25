import { formatElapsed } from '../lib/oasisRipple'
import { describeRun, explainRun, type RanCodeOutput } from '../lib/ranCode'
import { SANDBOX_BOOT_WAIT } from '../lib/turnPhase'

/**
 * The "Ran Python" block's one-line header, and the whole of what the reader
 * sees while the run is in flight.
 *
 * Split out of RanCodeBlock so it renders in plain Node without the markdown
 * pipeline behind it — the same reason OasisRippleView is split out — because
 * what it says during a cold start is the point (test/ranCode.test.ts).
 *
 * Measured on TTU2 (.h2h-runs/judge-r3/TTU2/run-1): the run that loaded the
 * runtime showed '⏳' and the word "running…" — the one thing the runtime was
 * not yet doing — and then reported "ran in 6 ms" against a later warm run's
 * "ran in 20 ms". Both halves are fixed here: the wait is named while it
 * happens, in the turn's own named-wait vocabulary (SANDBOX_BOOT_WAIT), and
 * the boot it paid for is stated afterwards instead of dropped.
 */
export function RanCodeHeader({
  status,
  parsed,
  booting,
  waitedMs,
  open,
  onToggle
}: {
  status: 'running' | 'done' | 'error'
  parsed: RanCodeOutput | null
  /** The runtime is still coming up, so this run has not started yet. */
  booting: boolean
  /** Elapsed since the run was asked for; drives the boot counter. */
  waitedMs: number
  open: boolean
  onToggle: () => void
}): JSX.Element {
  const running = status === 'running'
  const elapsed = waitedMs >= 1000 ? ` · ${formatElapsed(waitedMs)}` : ''
  const state = running ? (booting ? 'booting' : 'running') : status
  const label = running
    ? booting
      ? `${SANDBOX_BOOT_WAIT.label} — ${SANDBOX_BOOT_WAIT.detail}${elapsed}`
      : `running…${elapsed}`
    : parsed
      ? describeRun(parsed)
      : ''

  return (
    <button
      type="button"
      onClick={onToggle}
      data-run-state={state}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-black/10 dark:hover:bg-white/5"
      title={running && booting ? `${SANDBOX_BOOT_WAIT.label} — ${SANDBOX_BOOT_WAIT.detail}` : explainRun(parsed)}
    >
      <span className={status === 'error' ? 'text-red-500' : status === 'done' ? 'text-green-500' : ''}>
        {running ? '⏳' : status === 'done' ? '✓' : '✗'}
      </span>
      <span className="font-medium">⚡ Ran Python</span>
      <span className="text-ink-tertiary">
        {label}
        {parsed && parsed.files.length > 0 ? ` · ${parsed.files.length} file${parsed.files.length === 1 ? '' : 's'}` : ''}
      </span>
      <span className="ml-auto text-ink-tertiary">{open ? '▾' : '▸'}</span>
    </button>
  )
}
