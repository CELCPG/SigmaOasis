import { useCallback } from 'react'
import { useAppStore } from '../stores/appStore'

/**
 * Model discovery + connection status against LM Studio.
 *
 * The request runs in the main process (main/ipc/modelCatalog.ts) rather than
 * as a renderer `fetch`. That is not incidental: a renderer fetch bypasses the
 * egress allowlist and never appears in the Privacy activity log, so the log
 * quietly understated what the app talks to. Routing it through IPC also gets
 * us the capability fields LM Studio's own REST API reports — context length,
 * vision, whether the model is currently loaded.
 */
export function useModels(): { refresh: () => Promise<void> } {
  const setConnection = useAppStore((s) => s.setConnection)
  const setAvailableModels = useAppStore((s) => s.setAvailableModels)

  const refresh = useCallback(async (): Promise<void> => {
    if (!useAppStore.getState().settings?.baseUrl) return

    setConnection('connecting')
    try {
      const result = await window.api.getModelCatalog()
      if ('error' in result) throw new Error(result.error)
      setAvailableModels(result.models)
      setConnection('online')
    } catch {
      setAvailableModels([])
      setConnection('offline')
    }
  }, [setConnection, setAvailableModels])

  return { refresh }
}
