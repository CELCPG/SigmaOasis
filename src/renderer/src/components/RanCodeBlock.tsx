import { useEffect, useMemo, useState } from 'react'
import type { ToolCallRecord } from '../types'
import { renderMarkdown } from '../lib/markdown'
import { startWaitClock, WAIT_TICK_MS } from '../lib/oasisRipple'
import { parseRanCode } from '../lib/ranCode'
import { RanCodeHeader } from './RanCodeHeader'
import { Disclosure } from './Disclosure'
import { ToolCallBlock } from './ToolCallBlock'

/**
 * v1.6 "Ran code": what run_python did, visible by default. The code the model
 * wrote is shown highlighted (through the same sanitized markdown renderer as
 * replies, so it gets the same Copy button), and the output is split into
 * stdout / result / stderr / error / files. Open by default because the point
 * of computing instead of recalling is that the user can see the computation;
 * a collapsed block would hide exactly the evidence.
 *
 * v1.12.4: the header lives in RanCodeHeader so it can be rendered without the
 * markdown pipeline, and the run that pays the one-time runtime start says so
 * while it is paying it.
 */

/** How often the block re-asks whether the runtime has finished coming up. */
const BOOT_POLL_MS = 1_000

/**
 * Is this run waiting on the sandbox rather than on Python?
 *
 * Only the main process knows: the job is not even sent to the page until the
 * runtime is up, so nothing that arrives with the result can describe the wait
 * that preceded it. `warm` means the runtime is loaded and serving — not that a
 * window object exists, which is true from the first millisecond of a boot that
 * has seconds left to run. Asked once when the run starts and once a second
 * after, so the label yields to "running…" the moment Python actually has the
 * code. `waitedMs` is read off the wall clock (startWaitClock), so a throttled
 * background window counts slower, never wrongly.
 */
function useSandboxBoot(running: boolean): { booting: boolean; waitedMs: number } {
  const [booting, setBooting] = useState(false)
  const [waitedMs, setWaitedMs] = useState(0)
  useEffect(() => {
    if (!running) {
      setBooting(false)
      setWaitedMs(0)
      return
    }
    let live = true
    const ask = (): void => {
      void window.api
        .workbenchStatus()
        .then((s) => {
          if (live) setBooting(s.available && !s.warm)
        })
        .catch(() => undefined)
    }
    ask()
    const poll = setInterval(ask, BOOT_POLL_MS)
    const stopClock = startWaitClock(setWaitedMs, WAIT_TICK_MS)
    return () => {
      live = false
      clearInterval(poll)
      stopClock()
    }
  }, [running])
  return { booting, waitedMs }
}

export function RanCodeBlock({
  record,
  onCodeBlockClick,
  children
}: {
  record: ToolCallRecord
  onCodeBlockClick: (e: React.MouseEvent<HTMLDivElement>) => void
  /** v2.7 Code Mode: the tool calls this program made, shown under its code. */
  children?: ToolCallRecord[]
}): JSX.Element {
  const [open, setOpen] = useState(true)
  const code = String(record.args.code ?? '')
  const parsed = useMemo(() => (record.result !== undefined ? parseRanCode(record.result, record.status === 'done') : null), [record.result, record.status])
  const codeHtml = useMemo(() => renderMarkdown('```python\n' + code + '\n```'), [code])
  const running = record.status === 'running'
  const color = record.status === 'error' ? '#ef4444' : '#ffd166'
  const boot = useSandboxBoot(running)

  return (
    <div className="my-2 overflow-hidden rounded-2xl border text-xs" style={{ borderColor: `${color}40`, background: `${color}0a` }}>
      <RanCodeHeader
        status={record.status}
        parsed={parsed}
        booting={boot.booting}
        waitedMs={boot.waitedMs}
        open={open}
        onToggle={() => setOpen((o) => !o)}
      />
      {record.preamble && <div className="px-3 pb-1.5 italic text-ink-secondary">“{record.preamble}”</div>}
      <Disclosure open={open} className="space-y-2 px-3 pb-3">
          <div className="markdown-body text-xs" onClick={onCodeBlockClick} dangerouslySetInnerHTML={{ __html: codeHtml }} />
          {children && children.length > 0 && (
            <Section label={`Tool calls the program made (${children.length})`}>
              <div className="space-y-1.5">
                {children.map((c) => (
                  <ToolCallBlock key={c.id} record={c} />
                ))}
              </div>
            </Section>
          )}
          {parsed && (
            <>
              {parsed.stdout && (
                <Section label="Output">
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-black/5 p-2 font-mono dark:bg-white/5">{parsed.stdout}</pre>
                </Section>
              )}
              {parsed.result && (
                <Section label="Result (last expression)">
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/5 p-2 font-mono dark:bg-white/5">{parsed.result}</pre>
                </Section>
              )}
              {parsed.error && (
                <Section label="Error">
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-red-500/10 p-2 font-mono text-ink-danger">{parsed.error}</pre>
                </Section>
              )}
              {parsed.stderr && (
                <Section label="stderr">
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/5 p-2 font-mono text-ink-secondary dark:bg-white/5">{parsed.stderr}</pre>
                </Section>
              )}
              {parsed.files.length > 0 && (
                <Section label="Files written">
                  <ul className="list-disc pl-5 text-ink-secondary">
                    {parsed.files.map((f, i) => (
                      <li key={i} className="whitespace-pre-wrap font-mono">{f}</li>
                    ))}
                  </ul>
                </Section>
              )}
              {!parsed.stdout && !parsed.result && !parsed.error && parsed.files.length === 0 && (
                <div className="text-ink-tertiary">(no output)</div>
              )}
              {parsed.notes.length > 0 && <div className="text-[11px] text-ink-tertiary">{parsed.notes.join(' · ')}</div>}
            </>
          )}
      </Disclosure>
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <div className="mb-1 font-medium text-ink-secondary">{label}</div>
      {children}
    </div>
  )
}
