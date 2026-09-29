import { useEffect, useState } from 'react'

export interface SliderProps {
  value: number
  /** Called when the reader lets go, not on every pixel. */
  onCommit: (value: number) => void
  min: number
  max: number
  step?: number
  /** How the value reads beside the slider: `(v) => \`${v}px\``. */
  format?: (value: number) => string
  /** Live preview while dragging (the font size, the theme's contrast). */
  onPreview?: (value: number) => void
  disabled?: boolean
  labelledBy?: string
  describedBy?: string
  label?: string
}

/** A range with its value shown at the right (v4.0), applying on release. */
export function Slider({ value, onCommit, min, max, step = 1, format, onPreview, disabled, label, labelledBy, describedBy }: SliderProps): JSX.Element {
  const [live, setLive] = useState(value)
  useEffect(() => setLive(value), [value])
  const commit = (): void => {
    if (live !== value) onCommit(live)
  }
  return (
    <div className="flex w-full max-w-xs items-center gap-3">
      <input
        type="range"
        data-kit="slider"
        min={min}
        max={max}
        step={step}
        value={live}
        disabled={disabled}
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-valuetext={format ? format(live) : undefined}
        onChange={(e) => {
          const v = Number(e.target.value)
          setLive(v)
          onPreview?.(v)
        }}
        onMouseUp={commit}
        onTouchEnd={commit}
        onKeyUp={(e) => {
          if (/^(Arrow|Home|End|Page)/.test(e.key)) commit()
        }}
        onBlur={commit}
        className="flex-1 accent-accent"
      />
      <span className="w-12 shrink-0 text-right text-xs tabular-nums text-ink-secondary">{format ? format(live) : live}</span>
    </div>
  )
}
