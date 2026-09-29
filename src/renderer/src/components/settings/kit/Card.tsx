import type { HTMLAttributes, ReactNode } from 'react'
import { CARD, HELP } from './tokens'

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** A title row: a dot, a name, a status, an action at the right. */
  title?: ReactNode
  status?: ReactNode
  right?: ReactNode
  children?: ReactNode
  className?: string
}

/** One card (v4.0): the glass surface at the small radius. Replaces two card styles. Data attributes pass through, for the checks that find a card by name. */
export function Card({ title, status, right, children, className = '', ...rest }: CardProps): JSX.Element {
  return (
    <div data-list-row className={`${CARD} ${className}`} {...rest}>
      {(title || right) && (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 text-sm font-medium text-ink-primary">
            {title}
            {status && <span className={`${HELP} ml-2 inline`}>{status}</span>}
          </div>
          {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
        </div>
      )}
      {children && <div className={title || right ? 'mt-3' : ''}>{children}</div>}
    </div>
  )
}
