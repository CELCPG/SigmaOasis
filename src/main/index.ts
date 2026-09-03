import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { registerStoreHandlers, migrateSettings, getSettings } from './ipc/store'
import { hostWindow } from './ipc/hostWindow'
import { registerToolHandlers } from './ipc/tools'
import { registerMcpHandlers } from './ipc/mcp'
import { registerGrantHandlers } from './ipc/grants'
import { registerToolRankHandlers } from './ipc/toolRank'
import { registerAttachmentHandlers } from './ipc/attachments'
import { registerVoiceHandlers } from './ipc/voice'
import { registerMemoryHandlers } from './ipc/memory'
import { registerLibraryHandlers } from './ipc/library'
import { registerWorkbenchHandlers, registerWorkbenchScheme } from './ipc/workbench'
import { registerNetworkHandlers } from './ipc/net'
import { registerSearchHandlers } from './ipc/search'
import { registerAuditHandlers, purgeAuditLogs } from './ipc/audit'
import { registerTraceHandlers } from './ipc/traces'
import { registerPlanHandlers } from './ipc/plan'
import { registerModelPinHandlers, hasLegacyPins, unloadLegacyPins } from './ipc/modelPin'
import { registerModelCatalogHandlers } from './ipc/modelCatalog'
import { registerSummarizeHandlers } from './ipc/summarize'
import { readEvalResults, readEvalFixtures, saveEvalResult } from './ipc/evalResults'
import { TOOL_SCHEMAS } from '../shared/tools'
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

// The Workbench sandbox serves its runtime over a privileged app scheme;
// schemes must be registered before ready.
registerWorkbenchScheme()

app.whenReady().then(() => {
  migrateSettings()
  registerStoreHandlers()
  registerToolHandlers()
  registerToolRankHandlers()
  registerAttachmentHandlers()
  registerVoiceHandlers()
  registerMemoryHandlers()
  registerLibraryHandlers()
  registerWorkbenchHandlers()
  registerNetworkHandlers()
  registerSearchHandlers()
  registerUpdateHandlers()
  registerModelPinHandlers()
  registerModelCatalogHandlers()
  registerSummarizeHandlers()
  registerAuditHandlers()
  registerTraceHandlers()
  registerPlanHandlers()
  registerMcpHandlers()
  registerGrantHandlers()

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

  // Layer 0c: measured tool-choice scores for the model picker. Lives beside
  // the app like package.json does in dev; absent in packaged builds, where
  // readEvalResults returns an empty list.
  ipcMain.handle('eval:scores', () => readEvalResults(join(app.getAppPath(), '.eval-results')))

  // In-app "Run eval" support: the renderer runs the shared eval runner and
  // main supplies the repo fixtures plus the full toolbox (unfiltered by the
  // user's toggles, so scores stay comparable with the CLI baseline), then
  // persists each model's result with the CLI's filename convention.
  ipcMain.handle('eval:fixtures', () => ({
    fixtures: readEvalFixtures(
      join(app.getAppPath(), 'test', 'fixtures', 'toolchoice'),
      TOOL_SCHEMAS.map((t) => t.function.name)
    ),
    tools: TOOL_SCHEMAS
  }))
  ipcMain.handle('eval:saveResult', (_e, payload: unknown) =>
    saveEvalResult(join(app.getAppPath(), '.eval-results'), payload)
  )

  ipcMain.handle('dialog:pickDirectory', async (event) => {
    const win = hostWindow(event.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle(
    'dialog:pickFile',
    async (event, filters?: { name: string; extensions: string[] }[]) => {
      const win = hostWindow(event.sender)
      if (!win) return null
      const result = await dialog.showOpenDialog(win, {
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
  // Auto-purge the session audit log when the user asked for that (v0.9).
  // Best effort and synchronous-adjacent: do not hold the quit hostage.
  try {
    if (getSettings().audit.enabled && getSettings().audit.autoPurgeOnQuit) {
      void purgeAuditLogs()
    }
  } catch {
    // Settings unreadable at quit — nothing sane to do but exit.
  }
  if (allowQuit || !hasLegacyPins()) return
  event.preventDefault()
  void unloadLegacyPins().finally(() => {
    allowQuit = true
    app.quit()
  })
})
