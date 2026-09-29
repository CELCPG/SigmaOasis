import { useEffect, useRef, useState, type SelectHTMLAttributes } from 'react'
import { FIELD, FIELD_COMPACT } from './tokens'

interface Named {
  labelledBy?: string
  describedBy?: string
  /** The accessible name when not inside a Row. */
  label?: string
}

export interface FieldProps extends Named {
  value: string
  /**
   * Called when the value commits: on Enter, and on blur when it changed.
   * Typing never commits — a half-typed server address must not apply.
   */
  onCommit: (value: string) => void
  /** Live typing, for a caller that previews or validates as the reader types. */
  onChange?: (value: string) => void
  placeholder?: string
  type?: 'text' | 'password' | 'url'
  mono?: boolean
  compact?: boolean
  disabled?: boolean
  className?: string
  /** For a check that reads the field by name. */
  name?: string
}

/**
 * A text field that applies on commit (v4.0). Holds its own draft while
 * focused, so the settings store is not rewritten on every keystroke and
 * the toast fires once per change rather than once per letter.
 */
export function Field({
  value,
  onCommit,
  onChange,
  placeholder,
  type = 'text',
  mono,
  compact,
  disabled,
  className = '',
  name,
  label,
  labelledBy,
  describedBy
}: FieldProps): JSX.Element {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  // A value changed elsewhere (Undo, reset) replaces the draft unless the reader is mid-edit.
  useEffect(() => {
    if (!focused.current) setDraft(value)
  }, [value])
  const commit = (): void => {
    if (draft !== value) onCommit(draft)
  }
  return (
    <input
      type={type}
      data-kit="field"
      name={name}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={label}
      aria-labelledby={label ? undefined : labelledBy}
      aria-describedby={describedBy}
      onChange={(e) => {
        setDraft(e.target.value)
        onChange?.(e.target.value)
      }}
      onFocus={() => {
        focused.current = true
      }}
      onBlur={() => {
        focused.current = false
        commit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          setDraft(value)
        }
      }}
      className={`${compact ? FIELD_COMPACT : FIELD} ${mono ? 'font-mono' : ''} w-full ${className}`}
    />
  )
}

export interface SelectProps extends Named, Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'> {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string; disabled?: boolean }[]
  compact?: boolean
}

/** A select in the field surface. Applies on change, as a select should. */
export function Select({ value, onChange, options, compact, label, labelledBy, describedBy, className = '', ...rest }: SelectProps): JSX.Element {
  return (
    <select
      data-kit="select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      aria-labelledby={label ? undefined : labelledBy}
      aria-describedby={describedBy}
      className={`${compact ? FIELD_COMPACT : FIELD} ${className}`}
      {...rest}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export interface TextareaProps extends Named {
  value: string
  onCommit: (value: string) => void
  placeholder?: string
  mono?: boolean
  /** The fewest rows it shows; it grows to its content from there. */
  minRows?: number
  disabled?: boolean
  name?: string
}

/** A textarea that grows to its content and applies on blur. */
export function Textarea({ value, onCommit, placeholder, mono, minRows = 3, disabled, name, label, labelledBy, describedBy }: TextareaProps): JSX.Element {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!focused.current) setDraft(value)
  }, [value])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft])
  return (
    <textarea
      ref={ref}
      data-kit="textarea"
      name={name}
      rows={minRows}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={label}
      aria-labelledby={label ? undefined : labelledBy}
      aria-describedby={describedBy}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => {
        focused.current = true
      }}
      onBlur={() => {
        focused.current = false
        if (draft !== value) onCommit(draft)
      }}
      className={`${FIELD} ${mono ? 'font-mono text-xs leading-relaxed' : ''} w-full resize-none`}
    />
  )
}
