import { app, dialog, ipcMain, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { getSettings } from './ipc/store'

/**
 * Auto-update via electron-updater + GitHub Releases (the publish provider
 * in electron-builder.yml). Update checks contact GitHub — one of only two
 * non-loopback network paths in the app — so background checks are **opt-in**
 * (Settings → General → "Automatically check for updates"). The manual
 * "Check now" button always works. In dev the handlers still register
 * (returning a 'dev build' status) so the renderer never has to care which
 * mode it's in.
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
    // A background download can finish with every window closed (macOS keeps
    // the app alive). No window means no dialog — autoInstallOnAppQuit already
    // covers the install, and the status push above covers the UI.
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (!win) return
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Update ready',
      message: `Sigma Oasis ${info.version} is ready`,
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

  // Background checks only when the user opted in (Settings → General). The
  // manual updates:check handler above always works.
  const checkIfEnabled = (): void => {
    if (getSettings().updates.autoCheck) {
      void autoUpdater.checkForUpdates().catch(() => undefined)
    }
  }
  const initialCheck = setTimeout(checkIfEnabled, 10_000)
  const periodicCheck = setInterval(checkIfEnabled, CHECK_INTERVAL_MS)
  // Don't let a scheduled check fire into a tearing-down app.
  app.on('will-quit', () => {
    clearTimeout(initialCheck)
    clearInterval(periodicCheck)
  })
}
