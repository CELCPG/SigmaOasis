import { useState } from 'react'

interface Props {
  /** The model's chain-of-thought, already separated from the answer. */
  reasoning: string
  /** Milliseconds spent thinking, for the collapsed label. */
  reasoningMs?: number
  /** True while this message is still streaming. */
  isStreaming: boolean
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds / 60)}m`
}

/**
 * Collapsible chain-of-thought, shown above the answer. Deliberately collapsed
 * by default: thinking is context for the curious, not the reply, and a
 * reasoning model can easily produce more of it than the answer itself.
 *
 * Mirrors ToolCallBlock's shape so the two disclosures in a message read as
 * one system.
 */
export function ReasoningBlock({ reasoning, reasoningMs, isStreaming }: Props): JSX.Element {
  const [open, setOpen] = useState(false)

  const label = isStreaming
    ? 'Thinking…'
    : `Thought${reasoningMs ? ` for ${formatDuration(reasoningMs)}` : ''}`

  return (
    <div className="my-2 overflow-hidden rounded-2xl border border-black/10 dark:border-white/10 bg-black/[0.03] dark:bg-white/[0.03] text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-black/10 dark:hover:bg-white/5"
      >
        <span className={isStreaming ? 'animate-pulse' : ''}>💭</span>
        <span className="font-medium text-neutral-500">{label}</span>
        <span className="ml-auto text-neutral-400">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap px-3 pb-3 pt-1 font-mono text-neutral-500">
          {reasoning}
        </pre>
      )}
    </div>
  )
}
