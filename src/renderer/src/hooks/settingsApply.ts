import { useCallback } from 'react'
import { useAppStore } from '../stores/appStore'
import type { AppSettings } from '../types'
import { describeValue, firstChange, type RowMeta } from '../lib/settingsKit'

/**
 * Apply as you go (v4.0, S3). Settings had a draft that Save committed on ten
 * tabs and instant writes on four, with nothing on screen saying which. Now
 * every control applies when it commits, through this one function: the
 * change is written, the store follows, and a toast at the panel's foot says
 * what changed and offers Undo for four seconds.
 *
 * The write is the whole settings object, as `setSettings` always was: conf
 * rewrites the file whole either way, and a patch protocol would only add a
 * second path to keep in step.
 */
export type ApplySettings = (meta: RowMeta | null, partial: Partial<AppSettings>, shown?: string) => void

let nextToastId = 1

export function applySettings(meta: RowMeta | null, partial: Partial<AppSettings>, shown?: string): void {
  const state = useAppStore.getState()
  const previous = state.settings
  if (!previous) return
  const next: AppSettings = { ...previous, ...partial }
  const change = firstChange(previous, next)
  if (!change) return
  const write = (value: AppSettings): void => {
    state.setSettings(value)
    void window.api.setSettings(value)
  }
  write(next)
  const label = meta?.label ?? change.path
  state.pushSettingsToast({
    id: nextToastId++,
    label,
    value: shown ?? describeValue(change.value),
    undo: () => write(previous)
  })
}

/** The same, as a stable callback for a component. */
export function useApplySettings(): ApplySettings {
  return useCallback(applySettings, [])
}
