import { useState, type CSSProperties } from 'react'
import type { ToolCallRecord } from '../types'
import { toolVisualForName } from '../lib/oasisRipple'

const STATUS_ICON: Record<ToolCallRecord['status'], string> = {
  running: '⏳',
  done: '✓',
  error: '✗'
}

/** Collapsible block for a tool call — or a model-to-model consultation. */
export function ToolCallBlock({ record }: { record: ToolCallRecord }): JSX.Element {
  const [open, setOpen] = useState(false)

  const isConsult = record.name === 'consult_model'
  const visual = toolVisualForName(record.name)
  const label = isConsult
    ? `🤝 Consulted ${String(record.args.role ?? 'specialist')}`
    : `${visual.icon} ${record.name}`

  return (
    <div
      className="my-2 overflow-hidden rounded-2xl border text-xs"
      style={{ borderColor: `${visual.color}30`, background: `${visual.color}08` }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-black/10 dark:hover:bg-white/5"
      >
        <span
          className={
            record.status === 'error'
              ? 'text-red-500'
              : record.status === 'done'
                ? 'text-green-500'
                : ''
          }
        >
          {STATUS_ICON[record.status]}
        </span>
        <span className="font-medium" style={{ color: record.status === 'running' ? visual.color : undefined }}>
          {label}
        </span>
        <span className="ml-auto text-neutral-400">{open ? '▾' : '▸'}</span>
      </button>
      {record.preamble && (
        <div className="px-3 pb-1.5 italic text-neutral-500">
          “{record.preamble}”
        </div>
      )}
      {/* v1.7: while the tool runs, a light travels its base in the tool's color. */}
      {record.status === 'running' && (
        <div className="tool-scanline" style={{ '--scan-color': visual.color } as CSSProperties} />
      )}
      {open && (
        <div className="space-y-2 p-3">
          <div>
            <div className="mb-1 font-medium text-neutral-500">
              {isConsult ? 'Task delegated' : 'Arguments'}
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-black/5 dark:bg-white/5 p-2 font-mono">
              {isConsult ? String(record.args.task ?? '') : JSON.stringify(record.args, null, 2)}
            </pre>
          </div>
          {record.result !== undefined && (
            <div>
              <div className="mb-1 font-medium text-neutral-500">
                {isConsult ? 'Specialist reply' : 'Result'}
              </div>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-black/5 dark:bg-white/5 p-2 font-mono">
                {record.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
