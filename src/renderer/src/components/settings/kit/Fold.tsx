import { useState, type ReactNode } from 'react'
import { Disclosure } from '../../Disclosure'
import { HELP } from './tokens'

export interface FoldProps {
  title: ReactNode
  /** What is inside, while closed: "6 of 27 tools", "Qwen3 defaults". */
  summary?: ReactNode
  defaultOpen?: boolean
  /** Controlled, when the tab wants to open one from a deep link. */
  open?: boolean
  onToggle?: (open: boolean) => void
  children: ReactNode
}

/**
 * A disclosure with a header (v4.0): the animated body from Disclosure.tsx
 * with the button that opens it, in place of the native `<details>` the
 * Models tab used and nothing else in the app did.
 */
export function Fold({ title, summary, defaultOpen = false, open: controlled, onToggle, children }: FoldProps): JSX.Element {
  const [own, setOwn] = useState(defaultOpen)
  const open = controlled ?? own
  const toggle = (): void => {
    const next = !open
    setOwn(next)
    onToggle?.(next)
  }
  return (
    <div className="kit-fold rounded-lg border border-black/10 dark:border-white/10">
      <button
        type="button"
        data-kit="fold"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-black/5 dark:hover:bg-white/5"
      >
        <span className="w-3 text-[9px] text-ink-muted" aria-hidden="true">
          {open ? '▼' : '▶'}
        </span>
        <span className="min-w-0 flex-1 text-sm font-medium text-ink-primary">{title}</span>
        {summary && <span className={`${HELP} shrink-0`}>{summary}</span>}
      </button>
      <Disclosure open={open} className="px-3 pb-3 pt-1">
        <div className="space-y-4">{children}</div>
      </Disclosure>
    </div>
  )
}
