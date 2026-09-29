import type { ReactNode } from 'react'
import { DangerRow } from './DangerRow'
import { HELP, SECTION_TITLE } from './tokens'

export interface SectionProps {
  title: string
  /** One line saying what the section governs. */
  description?: string
  /** An action at the title's right: a switch for the whole group, a Refresh, an Add… */
  right?: ReactNode
  /** Puts this section's settings back to their defaults; drawn as a two-click Reset. */
  onReset?: () => void
  id?: string
  children: ReactNode
}

/**
 * A titled group of rows (v4.0). Replaces the `border-t` dividers and the bare
 * bold `<div>`s each tab drew its own way; the title is the uppercase tracked
 * label the right panel already uses, so Settings reads like the rest.
 */
export function Section({ title, description, right, onReset, id, children }: SectionProps): JSX.Element {
  return (
    <section className="kit-section" data-section={id}>
      <div className="mb-3 flex items-start gap-3 border-b border-black/10 pb-2 dark:border-white/10">
        <div className="min-w-0 flex-1">
          <h3 className={SECTION_TITLE}>{title}</h3>
          {description && <p className={`${HELP} mt-0.5`}>{description}</p>}
        </div>
        {right && <div className="shrink-0">{right}</div>}
        {onReset && (
          <div className="shrink-0">
            <DangerRow variant="inline" label="" action="Reset" confirm={`Reset ${title.toLowerCase()}?`} onConfirm={onReset} />
          </div>
        )}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  )
}
