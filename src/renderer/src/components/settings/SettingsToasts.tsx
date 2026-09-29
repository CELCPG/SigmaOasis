import { useEffect } from 'react'
import { useAppStore } from '../../stores/appStore'
import { TOAST_MS } from '../../lib/settingsKit'
import { Button } from './kit'

/**
 * The foot of the Settings panel (v4.0, S3): each applied change as one line —
 * "Theme: Dark — Undo" — for four seconds. Undo puts that one value back.
 * `role="status"` so a screen reader hears the change without focus moving.
 */
export function SettingsToasts(): JSX.Element | null {
  const toasts = useAppStore((s) => s.settingsToasts)
  const dismiss = useAppStore((s) => s.dismissSettingsToast)
  useEffect(() => {
    if (toasts.length === 0) return
    const newest = toasts[toasts.length - 1]!
    const timer = window.setTimeout(() => dismiss(newest.id), TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [toasts, dismiss])
  if (toasts.length === 0) return null
  return (
    <div role="status" aria-live="polite" className="flex min-w-0 flex-1 flex-col gap-1" data-settings-toasts>
      {toasts.map((t) => (
        <div key={t.id} className="row-enter flex min-w-0 items-center gap-2 text-xs text-ink-secondary">
          <span className="min-w-0 truncate">
            <span className="font-medium text-ink-primary">{t.label}</span>
            {': '}
            {t.value}
          </span>
          <Button
            kind="ghost"
            onClick={() => {
              t.undo()
              dismiss(t.id)
            }}
          >
            Undo
          </Button>
        </div>
      ))}
    </div>
  )
}
