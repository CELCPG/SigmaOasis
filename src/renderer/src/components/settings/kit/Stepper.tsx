import { useEffect, useRef, useState } from 'react'
import { clampStep, parseTyped } from '../../../lib/settingsKit'
import { FIELD_COMPACT } from './tokens'

export interface StepperProps {
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  step?: number
  /** Shown after the value: "px", "s", "tokens". */
  unit?: string
  disabled?: boolean
  labelledBy?: string
  describedBy?: string
  label?: string
}

/**
 * A number with a floor, a ceiling and a step (v4.0). The − and + buttons
 * step and apply at once; a typed value applies on Enter or blur, clamped —
 * so a stepper can never hold 0 steps or a 9,000-second command limit.
 */
export function Stepper({ value, onChange, min, max, step = 1, unit, disabled, label, labelledBy, describedBy }: StepperProps): JSX.Element {
  const [draft, setDraft] = useState(String(value))
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(String(value))
  }, [value])
  const apply = (next: number): void => {
    const clamped = clampStep(next, value, min, max, step)
    setDraft(String(clamped))
    if (clamped !== value) onChange(clamped)
  }
  const nudge = 'h-7 w-7 rounded-md text-sm text-ink-secondary hover:bg-black/5 hover:text-ink-primary disabled:opacity-30 dark:hover:bg-white/10'
  return (
    <div className="inline-flex items-center gap-1">
      <button type="button" data-kit="step" className={nudge} disabled={disabled || value <= min} onClick={() => apply(value - step)} aria-label={`Decrease${label ? ` ${label}` : ''}`}>
        −
      </button>
      <input
        type="text"
        inputMode="decimal"
        data-kit="stepper"
        value={draft}
        disabled={disabled}
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => {
          focused.current = true
        }}
        onBlur={() => {
          focused.current = false
          apply(parseTyped(draft))
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') apply(parseTyped(draft))
          else if (e.key === 'ArrowUp') {
            e.preventDefault()
            apply(value + step)
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            apply(value - step)
          }
        }}
        className={`${FIELD_COMPACT} w-16 text-center tabular-nums`}
      />
      {unit && <span className="text-xs text-ink-tertiary">{unit}</span>}
      <button type="button" data-kit="step" className={nudge} disabled={disabled || value >= max} onClick={() => apply(value + step)} aria-label={`Increase${label ? ` ${label}` : ''}`}>
        +
      </button>
    </div>
  )
}
