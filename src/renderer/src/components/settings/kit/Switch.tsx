import { useId } from 'react'

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  /** The accessible name when the switch is not inside a Row that names it. */
  label?: string
  /** The id of the element that names it, when it is (Row supplies this). */
  labelledBy?: string
  describedBy?: string
  disabled?: boolean
  /** Only inside a list row, where the full size crowds the line. */
  size?: 'md' | 'sm'
}

/**
 * A switch, not a checkbox (v4.0). Every boolean in Settings was a bare
 * `<input type=checkbox>` in five variants; this is one control with
 * `role="switch"`, a track and a thumb in the accent, Space and Enter to
 * toggle, and the app's one focus ring from index.css.
 */
export function Switch({ checked, onChange, label, labelledBy, describedBy, disabled, size = 'md' }: SwitchProps): JSX.Element {
  const id = useId()
  const track = size === 'sm' ? 'h-4 w-7' : 'h-5 w-9'
  const thumb = size === 'sm' ? 'h-3 w-3' : 'h-4 w-4'
  const travel = size === 'sm' ? 'translate-x-3' : 'translate-x-4'
  return (
    <button
      id={id}
      type="button"
      role="switch"
      data-kit="switch"
      aria-checked={checked}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`kit-switch relative inline-flex ${track} shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        checked
          ? 'border-accent bg-accent'
          : 'border-black/15 bg-black/10 hover:bg-black/15 dark:border-white/15 dark:bg-white/10 dark:hover:bg-white/15'
      }`}
    >
      <span
        aria-hidden="true"
        className={`kit-switch-thumb ${thumb} translate-x-0.5 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.35)] transition-transform ${
          checked ? travel : ''
        }`}
      />
    </button>
  )
}
