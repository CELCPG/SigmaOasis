import { useAppStore } from '../stores/appStore'

/**
 * Enter or leave VIBE (v3.0). Persisted like the rail's collapse (⌘B): the
 * store first so the window changes on this frame, then electron-store so the
 * choice survives a restart. A no-op when the mode is already where asked.
 */
export function setVibeMode(on: boolean): void {
  const current = useAppStore.getState().settings
  if (!current || current.vibeMode === on) return
  const updated = { ...current, vibeMode: on }
  useAppStore.getState().setSettings(updated)
  void window.api.setSettings(updated)
}
