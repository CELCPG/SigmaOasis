import { useState, type ReactNode } from 'react'

/**
 * A titled, collapsible block in the panel. Open by default; the open state is
 * per-mount (not persisted) — these are glanceable groups, not layout.
 */
export function PanelSection({
  title,
  hint,
  right,
  defaultOpen = true,
  children
}: {
  title: string
  hint?: string
  right?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="border-b border-black/10 dark:border-white/10 px-4 py-3 last:border-b-0">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          aria-expanded={open}
          title={hint}
        >
          <span className="w-3 text-[9px] text-ink-muted">{open ? '▼' : '▶'}</span>
          <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
            {title}
          </span>
        </button>
        {right}
      </div>
      {open && <div className="mt-2">{children}</div>}
    </section>
  )
}

