import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { buttonClass, type ButtonKind, type ButtonSize } from './tokens'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  kind?: ButtonKind
  size?: ButtonSize
  /** Shown in place of the label while true, and the button is disabled. */
  busy?: string
  children: ReactNode
}

/** The one button. Four kinds, two sizes, and never a `type` other than button. */
export function Button({ kind = 'secondary', size = 'sm', busy, children, className = '', disabled, ...rest }: ButtonProps): JSX.Element {
  return (
    <button
      type="button"
      data-kit="button"
      className={`${buttonClass(kind, size)}${className ? ` ${className}` : ''}`}
      disabled={disabled || Boolean(busy)}
      aria-busy={busy ? true : undefined}
      {...rest}
    >
      {busy ?? children}
    </button>
  )
}
