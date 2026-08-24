import { useMemo, useState } from 'react'
import type { ToolCallRecord } from '../types'
import { renderMarkdown } from '../lib/markdown'
import { describeRun, parseRanCode } from '../lib/ranCode'

/**
 * v1.6 "Ran code": what run_python did, visible by default. The code the model
 * wrote is shown highlighted (through the same sanitized markdown renderer as
 * replies, so it gets the same Copy button), and the output is split into
 * stdout / result / stderr / error / files. Open by default because the point
 * of computing instead of recalling is that the user can see the computation;
 * a collapsed block would hide exactly the evidence.
 */
export function RanCodeBlock({ record, onCodeBlockClick }: { record: ToolCallRecord; onCodeBlockClick: (e: React.MouseEvent<HTMLDivElement>) => void }): JSX.Element {
  const [open, setOpen] = useState(true)
  const code = String(record.args.code ?? '')
  const parsed = useMemo(() => (record.result !== undefined ? parseRanCode(record.result, record.status === 'done') : null), [record.result, record.status])
  const codeHtml = useMemo(() => renderMarkdown('```python\n' + code + '\n```'), [code])
  const running = record.status === 'running'
  const color = record.status === 'error' ? '#ef4444' : '#ffd166'

  return (
    <div className="my-2 overflow-hidden rounded-2xl border text-xs" style={{ borderColor: `${color}40`, background: `${color}0a` }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-black/10 dark:hover:bg-white/5"
        title="Python the model wrote and ran in the sandbox (no network, no access to your disk). Click to collapse."
      >
        <span className={record.status === 'error' ? 'text-red-500' : record.status === 'done' ? 'text-green-500' : ''}>
          {running ? '⏳' : record.status === 'done' ? '✓' : '✗'}
        </span>
        <span className="font-medium">⚡ Ran Python</span>
        <span className="text-ink-tertiary">
          {running ? 'running…' : parsed ? describeRun(parsed) : ''}
          {parsed && parsed.files.length > 0 ? ` · ${parsed.files.length} file${parsed.files.length === 1 ? '' : 's'}` : ''}
        </span>
        <span className="ml-auto text-ink-tertiary">{open ? '▾' : '▸'}</span>
      </button>
      {record.preamble && <div className="px-3 pb-1.5 italic text-ink-secondary">“{record.preamble}”</div>}
      {open && (
        <div className="space-y-2 px-3 pb-3">
          <div className="markdown-body text-xs" onClick={onCodeBlockClick} dangerouslySetInnerHTML={{ __html: codeHtml }} />
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
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-red-500/10 p-2 font-mono text-red-700 dark:text-red-300">{parsed.error}</pre>
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
        </div>
      )}
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
