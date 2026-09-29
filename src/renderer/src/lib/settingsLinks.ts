/**
 * Deep links into Settings (v4.0, S5). A target is a tab key ('tools') or a
 * row id ('tools.web_search', as `defineRows` names them). `openSettingsAt`
 * takes either; the modal opens the tab and, for a row, scrolls to it and
 * pulses it once. `settingsPath` is the same target in words, for prose that
 * cannot hold a control — "Settings → Tools › Web search".
 */
import { SETTINGS_TABS, settingsTab, type SettingsTabKey } from '../components/settings/tabs'
import { settingsIndex, tabOfRow } from './settingsKit'

export type SettingsTargetId = SettingsTabKey | `${SettingsTabKey}.${string}`

export function isSettingsTab(key: string): key is SettingsTabKey {
  return SETTINGS_TABS.some((t) => t.key === key)
}

/** The tab a target opens, or null when the target names no tab this build has. */
export function targetTab(target: string): SettingsTabKey | null {
  const key = tabOfRow(target)
  return isSettingsTab(key) ? key : null
}

/** The target in words: the tab's label, and the row's label after › when it is a row. */
export function settingsPath(target: string): string {
  const tab = targetTab(target)
  if (!tab) return 'Settings'
  const label = settingsTab(tab).label
  if (!target.includes('.')) return `Settings → ${label}`
  const row = settingsIndex().find((r) => r.id === target)
  return row ? `Settings → ${label} › ${row.label}` : `Settings → ${label}`
}
