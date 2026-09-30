import { dialog, ipcMain } from 'electron'
import { hostWindow } from '../hostWindow'
import { formatLookup } from './format'
import { lookupLibrary } from './lookup'
import { embedPack } from './embedJob'
import {
  checkPackFreshness,
  createPackFromFolder,
  installBundledPack,
  installPackFromDirectory,
  libraryStats,
  listBundledPacks,
  listPacks,
  registerZimPack,
  removePack,
  updatePackFromFolder
} from './packs'

// v4.2 (L1): the IPC surface, split out of library.ts unchanged.

/** One embed job at a time; a second request while one runs is refused, not queued. */
let embedJob: { packId: string; abort: AbortController } | null = null

export function registerLibraryHandlers(): void {
  ipcMain.handle('library:list', () => listPacks())
  ipcMain.handle('library:stats', () => libraryStats())
  ipcMain.handle('library:remove', (_e, id: string) => removePack(String(id ?? '')))
  ipcMain.handle('library:lookup', async (_e, query: string, packId?: string | null, topK?: number, opts?: { modelId?: unknown }) => {
    const q = String(query ?? '')
    // v4.2 (L2): the renderer names the answering slot's model for a re-rank.
    const modelId = typeof opts?.modelId === 'string' && opts.modelId.trim() ? opts.modelId : undefined
    const outcome = await lookupLibrary({ query: q, packId: packId ?? null, topK, modelId })
    // `formatted` is the model-facing text — the same the tool returns — so
    // the renderer's app-initiated lookup injects exactly what a tool call would.
    return { ...outcome, formatted: outcome.ok ? formatLookup(outcome, q) : '' }
  })

  ipcMain.handle('library:installFromDirectory', async (event, path?: string) => {
    let dir = typeof path === 'string' && path.trim() ? path : null
    if (!dir) {
      const win = hostWindow(event.sender)
      if (!win) return { ok: false, error: 'No window to show a picker in.' }
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: 'Install a reference pack (folder with manifest.json)',
        properties: ['openDirectory']
      })
      if (canceled || filePaths.length === 0) return { ok: false, cancelled: true }
      dir = filePaths[0]
    }
    try {
      return { ok: true, pack: await installPackFromDirectory(dir, { replace: true }) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // v2.8: a ZIM file, registered where it is.
  ipcMain.handle('library:addZim', async (event, path?: string) => {
    let file = typeof path === 'string' && path.trim() ? path : null
    if (!file) {
      const win = hostWindow(event.sender)
      if (!win) return { ok: false, error: 'No window to show a picker in.' }
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: 'Add a Kiwix ZIM file (offline Wikipedia, WikiMed, …) to the reference library',
        properties: ['openFile'],
        filters: [{ name: 'ZIM files', extensions: ['zim'] }]
      })
      if (canceled || filePaths.length === 0) return { ok: false, cancelled: true }
      file = filePaths[0]
    }
    try {
      return { ok: true, pack: await registerZimPack(file) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('library:addFolder', async (event, path?: string, name?: string) => {
    let dir = typeof path === 'string' && path.trim() ? path : null
    if (!dir) {
      const win = hostWindow(event.sender)
      if (!win) return { ok: false, error: 'No window to show a picker in.' }
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: 'Add a folder of your documents to the reference library',
        properties: ['openDirectory']
      })
      if (canceled || filePaths.length === 0) return { ok: false, cancelled: true }
      dir = filePaths[0]
    }
    try {
      return { ok: true, pack: await createPackFromFolder(dir, { name: typeof name === 'string' ? name : undefined }) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('library:bundled', () => listBundledPacks())

  ipcMain.handle('library:installBundled', async (_e, id: string) => {
    try {
      return { ok: true, pack: await installBundledPack(String(id ?? '')) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('library:updateFromFolder', async (_e, id: string) => {
    try {
      return { ok: true, ...(await updatePackFromFolder(String(id ?? ''))) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('library:checkFresh', (_e, id: string) => checkPackFreshness(String(id ?? '')))

  ipcMain.handle('library:embed', async (event, id: string) => {
    if (embedJob) return { ok: false, error: `Already embedding "${embedJob.packId}".` }
    const abort = new AbortController()
    embedJob = { packId: String(id), abort }
    try {
      return await embedPack(
        String(id),
        (done, total) => {
          if (!event.sender.isDestroyed()) event.sender.send('library:embedProgress', { packId: id, done, total })
        },
        abort.signal
      )
    } finally {
      embedJob = null
    }
  })

  ipcMain.handle('library:cancelEmbed', () => {
    embedJob?.abort.abort()
    return { ok: true }
  })
}
