import { useRef, type ReactNode } from 'react'
import { segmentedKey } from '../../../lib/settingsKit'
import { HELP } from './tokens'

export interface SegmentedOption<V extends string> {
  value: V
  label: ReactNode
  /** Shown under the label in the `cards` variant; a tooltip in the pill variant. */
  hint?: string
  disabled?: boolean
}

export interface SegmentedProps<V extends string> {
  value: V
  onChange: (value: V) => void
  options: SegmentedOption<V>[]
  /** `pill`: a compact switcher. `cards`: one bordered card per option, hint shown. */
  variant?: 'pill' | 'cards'
  labelledBy?: string
  describedBy?: string
  label?: string
}

/**
 * A two-to-four-way exclusive choice (v4.0): the theme switcher, the search
 * provider, the agent's mode — three controls that were three components.
 * A radiogroup with roving focus: arrows move and select, Tab leaves.
 */
export function Segmented<V extends string>({ value, onChange, options, variant = 'pill', label, labelledBy, describedBy }: SegmentedProps<V>): JSX.Element {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  )
  const onKey = (e: React.KeyboardEvent, i: number): void => {
    const next = segmentedKey(e.key, i, options.length)
    if (next === null) return
    e.preventDefault()
    const option = options[next]
    if (!option || option.disabled) return
    onChange(option.value)
    refs.current[next]?.focus()
  }
  const group = {
    role: 'radiogroup' as const,
    'aria-label': label,
    'aria-labelledby': label ? undefined : labelledBy,
    'aria-describedby': describedBy
  }
  if (variant === 'cards') {
    return (
      <div {...group} className="grid gap-2 sm:grid-cols-2">
        {options.map((o, i) => {
          const selected = o.value === value
          return (
            <button
              key={o.value}
              ref={(el) => {
                refs.current[i] = el
              }}
              type="button"
              role="radio"
              data-kit="segment"
              aria-checked={selected}
              tabIndex={i === index ? 0 : -1}
              disabled={o.disabled}
              onClick={() => onChange(o.value)}
              onKeyDown={(e) => onKey(e, i)}
              className={`rounded-xl border p-3 text-left transition-colors disabled:opacity-40 ${
                selected
                  ? 'border-accent/50 bg-accent/10'
                  : 'border-black/10 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5'
              }`}
            >
              <span className="block text-sm font-medium text-ink-primary">{o.label}</span>
              {o.hint && <span className={`${HELP} mt-0.5 block`}>{o.hint}</span>}
            </button>
          )
        })}
      </div>
    )
  }
  return (
    <div {...group} className="inline-flex rounded-lg bg-black/5 p-0.5 text-sm dark:bg-white/10">
      {options.map((o, i) => {
        const selected = o.value === value
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            data-kit="segment"
            aria-checked={selected}
            tabIndex={i === index ? 0 : -1}
            disabled={o.disabled}
            title={o.hint}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
            className={`rounded-md px-3 py-1 transition-colors disabled:opacity-40 ${
              selected ? 'bg-white text-ink-primary shadow-sm dark:bg-neutral-700' : 'text-ink-secondary hover:text-ink-primary'
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
