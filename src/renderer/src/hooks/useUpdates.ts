import { useEffect, useState } from 'react'
import type { UpdateStatus } from '../types'

/**
 * Auto-update status, live from the main process (main/updates.ts).
 * In dev builds the state is simply 'dev'.
 */
export function useUpdates(): {
  status: UpdateStatus | null
  check: () => Promise<void>
  install: () => void
} {
  const [status, setStatus] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    void window.api.getUpdateStatus().then(setStatus).catch(() => undefined)
    return window.api.onUpdateStatus(setStatus)
  }, [])

  const check = async (): Promise<void> => {
    setStatus(await window.api.checkForUpdates().catch(() => null))
  }

  const install = (): void => {
    void window.api.installUpdate()
  }

  return { status, check, install }
}
