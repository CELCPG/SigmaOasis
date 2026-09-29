import { useEffect, useRef, useState, type ReactNode } from 'react'
import { DANGER_ARM_MS, dangerClick, type DangerState } from '../../../lib/settingsKit'
import { Button } from './Button'
import { HELP } from './tokens'

export interface DangerRowProps {
  /** What the row is: a grant's summary, a server's name, "the network log". */
  label: ReactNode
  /** Under the label: where, when, how many uses. */
  detail?: ReactNode
  /** The button: "Remove", "Revoke", "Forget", "Clear". */
  action: string
  /** What the second click will do, in the armed button: "Remove Filesystem?". */
  confirm: string
  onConfirm: () => void | Promise<void>
  disabled?: boolean
  /** More controls before the danger button: a switch, a select. */
  children?: ReactNode
  /** `row` (default): a bordered list row. `inline`: the button and label alone. */
  variant?: 'row' | 'inline'
}

/**
 * A destructive action that takes two clicks (v4.0). Eleven Remove, Revoke,
 * Forget and Clear buttons acted on one; this is the rule Reset to defaults
 * has kept since v2.x — arm, then act within four seconds — as one component,
 * so a stray click on an MCP server's Remove is a stray click.
 */
export function DangerRow({ label, detail, action, confirm, onConfirm, disabled, children, variant = 'row' }: DangerRowProps): JSX.Element {
  const [state, setState] = useState<DangerState>({ armed: false })
  const [busy, setBusy] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(() => {
    if (!state.armed) return
    timer.current = window.setTimeout(() => setState({ armed: false }), DANGER_ARM_MS)
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [state])
  const click = async (): Promise<void> => {
    const next = dangerClick(state, Date.now())
    setState(next.state)
    if (!next.act) return
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      setBusy(false)
    }
  }
  const button = (
    <Button kind="danger" onClick={() => void click()} disabled={disabled} busy={busy ? '…' : undefined} aria-live="polite" className={state.armed ? 'border-[var(--text-danger)] bg-red-500/10' : ''}>
      {state.armed ? confirm : action}
    </Button>
  )
  if (variant === 'inline') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {children}
        {button}
        {label && <span className={HELP}>{label}</span>}
      </div>
    )
  }
  return (
    <div className="flex items-center gap-3 rounded-lg border border-black/10 px-3 py-2 dark:border-white/10">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-ink-primary">{label}</div>
        {detail && <div className={`${HELP} truncate`}>{detail}</div>}
      </div>
      {children}
      {button}
    </div>
  )
}
