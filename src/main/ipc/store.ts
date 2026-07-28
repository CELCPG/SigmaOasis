import Store from 'electron-store'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { existsSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { writeFileAtomic } from './fsAtomic'

/**
 * Default settings shape. The renderer keeps a mirror of this shape in its
 * Zustand store, but electron-store is the source of truth for persistence.
 */
export interface ModelConfig {
  id: string
  modelId: string // the model identifier from LM Studio /v1/models
  roleName: string
  systemPrompt: string
  color: string // 'blue' | 'purple' | 'green' (accent key)
  enabled: boolean
}

export interface ToolToggles {
  read_file: boolean
  write_file: boolean
  list_directory: boolean
  run_terminal_command: boolean
  web_search: boolean
  get_current_datetime: boolean
  create_note: boolean
  list_notes: boolean
  read_note: boolean
  memory_save: boolean
  memory_search: boolean
  memory_forget: boolean
}

export interface VoiceSettings {
  autoRead: boolean
  voiceURI: string
  rate: number
}

export interface SttSettings {
  whisperCliPath: string
  whisperModelPath: string
}

export interface MemorySettings {
  autoContext: boolean
  topK: number
  embeddingModel: string
}

export interface AppSettings {
  baseUrl: string
  models: ModelConfig[]
  theme: 'light' | 'dark'
  fontSize: number
  historyLimit: number
  tools: ToolToggles
  workingDirectory: string
  pipeline: string[] // ordered list of model config ids for collaborative mode
  voice: VoiceSettings
  stt: SttSettings
  memory: MemorySettings
  /** First-run setup checklist has been dismissed. */
  onboardingCompleted: boolean
  /** Hide tool-call blocks in chat; show a thinking animation instead. */
  hideToolCalls: boolean
}

function defaultSettings(): AppSettings {
  return {
    baseUrl: 'http://127.0.0.1:1234/v1',
    models: [
      {
        id: 'model-1',
        modelId: 'google/gemma-4-12b-qat',
        roleName: 'Assistant',
        systemPrompt:
          'You are a helpful, harmless, and honest AI assistant. Answer questions clearly and concisely.',
        color: 'blue',
        enabled: true
      },
      {
        id: 'model-2',
        modelId: '',
        roleName: 'Researcher',
        systemPrompt:
          'You are a meticulous researcher. Use available tools to gather facts, cite sources, and summarize findings.',
        color: 'purple',
        enabled: false
      },
      {
        id: 'model-3',
        modelId: '',
        roleName: 'Coder',
        systemPrompt:
          'You are an expert software engineer. Write clean, correct code and explain your reasoning briefly.',
        color: 'green',
        enabled: false
      }
    ],
    theme: 'dark',
    fontSize: 15,
    historyLimit: 100,
    tools: {
      read_file: true,
      // Off by default: these two mutate the machine. Opt in under Settings → Tools.
      write_file: false,
      list_directory: true,
      run_terminal_command: false,
      web_search: true,
      get_current_datetime: true,
      create_note: true,
      list_notes: true,
      read_note: true,
      memory_save: true,
      memory_search: true,
      memory_forget: true
    },
    workingDirectory: '',
    pipeline: ['model-1'],
    voice: {
      autoRead: false,
      voiceURI: '',
      rate: 1
    },
    stt: {
      whisperCliPath: '',
      whisperModelPath: ''
    },
    memory: {
      autoContext: true,
      topK: 3,
      embeddingModel: ''
    },
    onboardingCompleted: false,
    hideToolCalls: false
  }
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * Keeps malformed values out of persistence, whether they come from the
 * settings UI or a hand-edited / corrupted config.json. A historyLimit of 0 —
 * which a cleared number input produces — would otherwise make the renderer
 * prune every saved conversation from disk on the next load.
 */
function normalizeSettings(settings: AppSettings): AppSettings {
  const defaults = defaultSettings()
  const rate = Number(settings.voice?.rate)

  const models = Array.isArray(settings.models) && settings.models.length > 0
    ? settings.models.map((m, i) => {
        const base = defaults.models[i] ?? defaults.models[0]
        return {
          ...base,
          ...m,
          id: str(m?.id, base.id),
          modelId: str(m?.modelId, ''),
          roleName: str(m?.roleName, base.roleName),
          systemPrompt: str(m?.systemPrompt, base.systemPrompt),
          color: ['blue', 'purple', 'green'].includes(m?.color) ? m.color : base.color,
          enabled: Boolean(m?.enabled)
        }
      })
    : defaults.models

  const tools = { ...defaults.tools }
  for (const key of Object.keys(tools) as (keyof ToolToggles)[]) {
    if (settings.tools && key in settings.tools) tools[key] = Boolean(settings.tools[key])
  }

  return {
    ...settings,
    baseUrl: str(settings.baseUrl, defaults.baseUrl),
    models,
    theme: settings.theme === 'light' ? 'light' : 'dark',
    fontSize: clamp(settings.fontSize, 12, 20, 15),
    historyLimit: clamp(settings.historyLimit, 10, 1000, 100),
    tools,
    workingDirectory: str(settings.workingDirectory, ''),
    pipeline: Array.isArray(settings.pipeline)
      ? settings.pipeline.filter((id): id is string => typeof id === 'string')
      : defaults.pipeline,
    voice: {
      ...defaults.voice,
      ...settings.voice,
      autoRead: Boolean(settings.voice?.autoRead),
      voiceURI: str(settings.voice?.voiceURI, ''),
      rate: Number.isFinite(rate) ? Math.min(2, Math.max(0.5, rate)) : 1
    },
    stt: {
      whisperCliPath: str(settings.stt?.whisperCliPath, ''),
      whisperModelPath: str(settings.stt?.whisperModelPath, '')
    },
    memory: {
      ...defaults.memory,
      ...settings.memory,
      autoContext: Boolean(settings.memory?.autoContext),
      embeddingModel: str(settings.memory?.embeddingModel, ''),
      topK: clamp(settings.memory?.topK, 1, 8, 3)
    },
    onboardingCompleted: Boolean(settings.onboardingCompleted),
    hideToolCalls: Boolean(settings.hideToolCalls)
  }
}

/**
 * Fills in settings keys added after the user's config was first written
 * (e.g. voice/stt landed in v0.3). Runs once at startup.
 */
export function migrateSettings(): void {
  const current = store.get('settings') as Partial<AppSettings>
  const defaults = defaultSettings()
  const merged: AppSettings = {
    ...defaults,
    ...current,
    tools: { ...defaults.tools, ...current.tools },
    voice: { ...defaults.voice, ...current.voice },
    stt: { ...defaults.stt, ...current.stt },
    memory: { ...defaults.memory, ...current.memory }
  } as AppSettings
  store.set('settings', normalizeSettings(merged))
}

/**
 * Rebrand migration (FunkinAI → Sigma Oasis): the app data directory is named
 * after the app, so renaming the app would orphan every setting, conversation,
 * note and memory. Chromium creates the new profile directory at startup —
 * before this module runs — so migration is per-item: legacy data wins over
 * the just-created fresh defaults (those are kept as *.pre-rebrand-backup).
 * Runs at import time, before `new Store` below.
 */
function migrateLegacyDataDir(): void {
  try {
    const current = app.getPath('userData')
    const marker = join(current, '.rebrand-migrated')
    if (existsSync(marker)) return
    const appData = app.getPath('appData')
    // 'FunkinAI' = packaged builds (productName), 'funkinai' = dev (npm name).
    // Prefer the dir matching this run mode when both exist.
    const packaged = join(appData, 'FunkinAI')
    const dev = join(appData, 'funkinai')
    const candidates = app.isPackaged ? [packaged, dev] : [dev, packaged]
    for (const legacy of candidates) {
      if (legacy === current || !existsSync(legacy)) continue
      for (const item of ['config.json', 'conversations', 'notes.json', 'memory.json']) {
        const src = join(legacy, item)
        const dst = join(current, item)
        if (!existsSync(src)) continue
        if (existsSync(dst) && !existsSync(`${dst}.pre-rebrand-backup`)) {
          renameSync(dst, `${dst}.pre-rebrand-backup`)
        }
        if (!existsSync(dst)) renameSync(src, dst)
      }
      writeFileSync(marker, new Date().toISOString())
      return
    }
    // No legacy data found — nothing to migrate; re-check next launch.
  } catch {
    // Best effort — a fresh directory is created either way.
  }
}
migrateLegacyDataDir()

const store = new Store<{ settings: AppSettings }>({
  defaults: { settings: defaultSettings() }
})

// ---- Conversation & note file persistence ----------------------------------

function conversationsDir(): string {
  return join(app.getPath('userData'), 'conversations')
}

function notesFile(): string {
  return join(app.getPath('userData'), 'notes.json')
}

/**
 * Conversation ids become filenames, so they must not contain separators or
 * `..` — otherwise a save/delete could reach outside the conversations dir.
 */
function conversationFile(id: string): string | null {
  return /^[A-Za-z0-9_-]+$/.test(id) ? join(conversationsDir(), `${id}.json`) : null
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

export interface Note {
  title: string
  content: string
  createdAt: number
}

export async function readNotes(): Promise<Note[]> {
  try {
    const raw = await fs.readFile(notesFile(), 'utf-8')
    return JSON.parse(raw) as Note[]
  } catch {
    return []
  }
}

export async function writeNotes(notes: Note[]): Promise<void> {
  await writeFileAtomic(notesFile(), JSON.stringify(notes, null, 2))
}

/**
 * Registers all IPC handlers related to persistence: settings, conversations.
 */
export function registerStoreHandlers(): void {
  ipcMain.handle('store:getSettings', () => ({
    // Merge defaults so installs created before a setting existed still get it.
    ...defaultSettings(),
    ...store.get('settings')
  }))

  ipcMain.handle('store:setSettings', (_e, settings: AppSettings) => {
    store.set('settings', normalizeSettings(settings))
    return true
  })

  ipcMain.handle('store:resetSettings', () => {
    store.set('settings', defaultSettings())
    return store.get('settings')
  })

  // Conversations are stored as one JSON file per conversation.
  ipcMain.handle('conversations:list', async () => {
    const dir = conversationsDir()
    await ensureDir(dir)
    const files = await fs.readdir(dir)
    const convos: unknown[] = []
    for (const f of files.filter((f) => f.endsWith('.json'))) {
      try {
        const raw = await fs.readFile(join(dir, f), 'utf-8')
        convos.push(JSON.parse(raw))
      } catch {
        // ignore corrupt file
      }
    }
    return convos
  })

  ipcMain.handle('conversations:save', async (_e, convo: { id: string }) => {
    const file = conversationFile(String(convo?.id ?? ''))
    if (!file) return false
    await ensureDir(conversationsDir())
    await writeFileAtomic(file, JSON.stringify(convo, null, 2))
    return true
  })

  ipcMain.handle('conversations:delete', async (_e, id: string) => {
    const file = conversationFile(String(id ?? ''))
    if (!file) return false
    try {
      await fs.unlink(file)
    } catch {
      // already gone
    }
    return true
  })

  // Export a rendered Markdown transcript via the native save dialog.
  ipcMain.handle(
    'conversations:exportMarkdown',
    async (event, payload: { title: string; markdown: string }) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const safeName =
        String(payload.title ?? 'conversation')
          .replace(/[^\w\s-]+/g, '')
          .trim()
          .replace(/\s+/g, '-')
          .slice(0, 60) || 'conversation'
      const { canceled, filePath } = await dialog.showSaveDialog(win!, {
        title: 'Export conversation as Markdown',
        defaultPath: join(app.getPath('documents'), `${safeName}.md`),
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (canceled || !filePath) return { ok: false, canceled: true }
      try {
        await fs.writeFile(filePath, String(payload.markdown ?? ''), 'utf-8')
        return { ok: true, path: filePath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}

export function getSettings(): AppSettings {
  return store.get('settings')
}
