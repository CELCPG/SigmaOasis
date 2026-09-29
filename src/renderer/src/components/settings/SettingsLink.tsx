import type { ReactNode } from 'react'
import { useAppStore } from '../../stores/appStore'
import { settingsPath } from '../../lib/settingsLinks'
import type { SettingsTarget } from '../../../../shared/failure'

/**
 * A link into Settings (v4.0, S5): where prose used to say "Settings → Tools",
 * a control that opens that tab — or that row — instead. The text defaults
 * to the path in words, so a link reads as the sentence did.
 */
export function SettingsLink({ to, children, className = '' }: { to: string; children?: ReactNode; className?: string }): JSX.Element {
  const openSettingsAt = useAppStore((s) => s.openSettingsAt)
  return (
    <button
      type="button"
      data-kit="link"
      onClick={(e) => {
        e.stopPropagation()
        openSettingsAt(to as SettingsTarget)
      }}
      className={`inline underline decoration-dotted underline-offset-2 hover:text-ink-primary ${className}`}
    >
      {children ?? settingsPath(to)}
    </button>
  )
}
