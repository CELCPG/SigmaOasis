import { app, dialog, ipcMain, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

/**
 * Auto-update via electron-updater + GitHub Releases (the publish provider
 * in electron-builder.yml). Packaged builds check 10s after launch and every
 * 4h; updates download in the background and offer a restart when ready.
 * In dev the handlers still register (returning a 'dev build' status) so the
 * renderer never has to care which mode it's in.
 */

export interface UpdateStatus {
  state:
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'unavailable'
    | 'error'
    | 'dev'
  currentVersion: string
  /** Version of the pending update, when known. */
  version?: string
  /** Download progress 0–100, while downloading. */
  percent?: number
  error?: string
}

let status: UpdateStatus = { state: 'idle', currentVersion: app.getVersion() }

function setStatus(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('updates:status', status)
  }
}

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

export function registerUpdateHandlers(): void {
  ipcMain.handle('updates:getStatus', () => status)

  if (!app.isPackaged) {
    setStatus({ state: 'dev' })
    ipcMain.handle('updates:check', () => status)
    ipcMain.handle('updates:install', () => false)
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking', error: undefined }))
  autoUpdater.on('update-available', (info) =>
    setStatus({ state: 'available', version: info.version, percent: 0 })
  )
  autoUpdater.on('update-not-available', () => setStatus({ state: 'unavailable' }))
  autoUpdater.on('download-progress', (p) =>
    setStatus({ state: 'downloading', percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', async (info) => {
    setStatus({ state: 'downloaded', version: info.version, percent: 100 })
    const win = BrowserWindow.getAllWindows()[0]
    const { response } = await dialog.showMessageBox(win!, {
      type: 'info',
      title: 'Update ready',
      message: `FunkinAI ${info.version} is ready`,
      detail: 'The update has been downloaded. Restart to finish installing it.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1
    })
    if (response === 0) autoUpdater.quitAndInstall()
  })
  autoUpdater.on('error', (err) =>
    setStatus({ state: 'error', error: err.message ?? String(err) })
  )

  ipcMain.handle('updates:check', async () => {
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      setStatus({ state: 'error', error: err instanceof Error ? err.message : String(err) })
    }
    return status
  })

  ipcMain.handle('updates:install', () => {
    if (status.state === 'downloaded') autoUpdater.quitAndInstall()
    return true
  })

  // First check shortly after launch, then periodically while running.
  setTimeout(() => void autoUpdater.checkForUpdates().catch(() => undefined), 10_000)
  setInterval(() => void autoUpdater.checkForUpdates().catch(() => undefined), CHECK_INTERVAL_MS)
}
