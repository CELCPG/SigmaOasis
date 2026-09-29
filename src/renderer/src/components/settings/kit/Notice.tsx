import type { ReactNode } from 'react'
import { NOTICE_TONE, TEXT_TONE, type Tone } from './tokens'

/**
 * A line the tab says to the reader (v4.0): a warning, a result, a note.
 * Four tones on one surface; `role=status` so a screen reader hears a
 * notice that appears after an action.
 */
export function Notice({ tone = 'info', children, className = '' }: { tone?: Tone; children: ReactNode; className?: string }): JSX.Element {
  return (
    <div role="status" className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${NOTICE_TONE[tone]} ${tone === 'muted' ? 'text-ink-secondary' : TEXT_TONE[tone]} ${className}`}>
      {children}
    </div>
  )
}
