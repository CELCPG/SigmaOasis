import { useCallback } from 'react'
import { useAppStore } from '../stores/appStore'
import type { ModelInfo } from '../types'

/**
 * Model discovery + connection status against LM Studio's OpenAI-compatible
 * server. `refresh()` hits GET {baseUrl}/models and updates the store.
 */
export function useModels(): { refresh: () => Promise<void> } {
  const setConnection = useAppStore((s) => s.setConnection)
  const setAvailableModels = useAppStore((s) => s.setAvailableModels)

  const refresh = useCallback(async (): Promise<void> => {
    const baseUrl = useAppStore.getState().settings?.baseUrl
    if (!baseUrl) return

    setConnection('connecting')
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { data?: { id: string }[] }
      const models: ModelInfo[] = (data.data ?? []).map((m) => ({ id: m.id }))
      setAvailableModels(models)
      setConnection('online')
    } catch {
      setAvailableModels([])
      setConnection('offline')
    }
  }, [setConnection, setAvailableModels])

  return { refresh }
}
