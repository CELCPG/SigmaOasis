import type { ReactNode } from 'react'

export interface Chip<V extends string> {
  value: V
  label: ReactNode
  hint?: string
  /** A swatch colour, for the accent picker. */
  swatch?: string
}

export interface ChipsProps<V extends string> {
  value: V | null
  onChange: (value: V) => void
  chips: Chip<V>[]
  labelledBy?: string
  describedBy?: string
  label?: string
}

/** A row of selectable chips (v4.0): sampling presets, an accent colour. One selected at a time. */
export function Chips<V extends string>({ value, onChange, chips, label, labelledBy, describedBy }: ChipsProps<V>): JSX.Element {
  return (
    <div role="radiogroup" aria-label={label} aria-labelledby={label ? undefined : labelledBy} aria-describedby={describedBy} className="flex flex-wrap gap-1.5">
      {chips.map((c) => {
        const selected = c.value === value
        if (c.swatch) {
          return (
            <button
              key={c.value}
              type="button"
              role="radio"
              data-kit="chip"
              aria-checked={selected}
              aria-label={typeof c.label === 'string' ? c.label : c.value}
              title={c.hint ?? (typeof c.label === 'string' ? c.label : undefined)}
              onClick={() => onChange(c.value)}
              style={{ background: c.swatch }}
              className={`h-6 w-6 rounded-full border-2 transition-transform ${
                selected ? 'scale-110 border-ink-primary' : 'border-transparent hover:scale-105'
              }`}
            />
          )
        }
        return (
          <button
            key={c.value}
            type="button"
            role="radio"
            data-kit="chip"
            aria-checked={selected}
            title={c.hint}
            onClick={() => onChange(c.value)}
            className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
              selected
                ? 'border-accent/50 bg-accent/15 text-accent-ink'
                : 'border-black/10 text-ink-secondary hover:bg-black/5 hover:text-ink-primary dark:border-white/10 dark:hover:bg-white/10'
            }`}
          >
            {c.label}
          </button>
        )
      })}
    </div>
  )
}
