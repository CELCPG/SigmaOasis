import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { registerStoreHandlers, migrateSettings } from './ipc/store'
import { registerToolHandlers } from './ipc/tools'
import { registerAttachmentHandlers } from './ipc/attachments'
import { registerVoiceHandlers } from './ipc/voice'
import { registerMemoryHandlers } from './ipc/memory'
import { registerNetworkHandlers } from './ipc/net'
import { registerSearchHandlers } from './ipc/search'
import { registerModelPinHandlers, hasLegacyPins, unloadLegacyPins } from './ipc/modelPin'
import { registerUpdateHandlers } from './updates'

/** electron-vite serves the renderer over http in dev, from a file in production. */
const DEV_URL = process.env['ELECTRON_RENDERER_URL']

function appEntryUrl(): string {
  return DEV_URL ?? pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
}

/**
 * True only for the app's own page. Everything else — including other file://
 * URLs — must never load in a window that has the preload attached, because
 * the preload exposes `window.api` (and with it the agentic tools) to whatever
 * document is loaded.
 */
function isAppUrl(url: string): boolean {
  const entry = appEntryUrl()
  if (url === entry || url.startsWith(`${entry}#`) || url.startsWith(`${entry}?`)) return true
  return DEV_URL !== undefined && url.startsWith(DEV_URL)
}

/** Only real web links are ever handed to the OS browser. */
function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.on('ready-to-show', () => win.show())

  // Open external links in the system browser, never in the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Links in model replies must never navigate this window: the preload is
  // re-injected on every navigation, so a remote page would inherit window.api.
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    if (isWebUrl(url)) void shell.openExternal(url)
  })

  // Push-to-talk needs the microphone; nothing else is granted, and only to
  // the app's own page.
  const { session } = win.webContents
  session.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permission === 'media' && isAppUrl(contents.getURL()))
  })
  session.setPermissionCheckHandler(
    (contents, permission) =>
      permission === 'media' && contents !== null && isAppUrl(contents.getURL())
  )

  // electron-vite: dev server URL in dev, built file in production.
  if (DEV_URL) {
    win.loadURL(DEV_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  migrateSettings()
  registerStoreHandlers()
  registerToolHandlers()
  registerAttachmentHandlers()
  registerVoiceHandlers()
  registerMemoryHandlers()
  registerNetworkHandlers()
  registerSearchHandlers()
  registerUpdateHandlers()
  registerModelPinHandlers()

  // Build version for the sidebar badge. Prefer the project's own
  // package.json: in dev, app.getVersion() can report Electron's version
  // instead, since the app path may resolve into node_modules/electron.
  ipcMain.handle('app:getVersion', () => {
    try {
      const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf-8')) as {
        version?: string
      }
      return pkg.version ?? app.getVersion()
    } catch {
      return app.getVersion()
    }
  })

  ipcMain.handle('dialog:pickDirectory', async (event) => {    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle(
    'dialog:pickFile',
    async (event, filters?: { name: string; extensions: string[] }[]) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = await dialog.showOpenDialog(win!, {
        properties: ['openFile'],
        filters
      })
      return result.canceled ? null : result.filePaths[0]
    }
  )

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Undo TTL-less model pins before exiting (see ipc/modelPin.ts): the legacy
// LM Studio load endpoint accepts no TTL, so models we explicitly loaded
// would otherwise stay resident after the app is gone.
let allowQuit = false
app.on('before-quit', (event) => {
  if (allowQuit || !hasLegacyPins()) return
  event.preventDefault()
  void unloadLegacyPins().finally(() => {
    allowQuit = true
    app.quit()
  })
})
