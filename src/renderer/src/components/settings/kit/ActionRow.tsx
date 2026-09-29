import type { ReactNode } from 'react'
import { Button } from './Button'
import { StatusDot } from './StatusDot'
import { TEXT_TONE, type Tone } from './tokens'
import type { ButtonKind } from './tokens'

export interface ActionResult {
  tone: Tone
  text: string
}

export interface ActionRowProps {
  /** The button's label. */
  action: string
  onAction: () => void
  /** Shown in the button while the action runs; the button is disabled. */
  busy?: string | null
  kind?: ButtonKind
  disabled?: boolean
  title?: string
  /** The result, at the button's right: a dot in its tone and one line. */
  result?: ActionResult | null
  /** More buttons after the first. */
  children?: ReactNode
}

/**
 * A button with its readout (v4.0): Test, Refresh, Re-check, Run eval, Look
 * up — seven tabs each drew their own. The result stays on the line the
 * button is on, so the eye does not hunt for it.
 */
export function ActionRow({ action, onAction, busy, kind = 'secondary', disabled, title, result, children }: ActionRowProps): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button kind={kind} onClick={onAction} busy={busy ?? undefined} disabled={disabled} title={title}>
        {action}
      </Button>
      {children}
      {result && (
        <span role="status" className={`inline-flex min-w-0 items-center gap-1.5 text-xs ${TEXT_TONE[result.tone]}`}>
          <StatusDot tone={result.tone} />
          <span className="min-w-0">{result.text}</span>
        </span>
      )}
    </div>
  )
}
