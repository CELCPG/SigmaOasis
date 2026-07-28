import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppSettings,
  AttachmentLoadResult,
  Conversation,
  MemorySearchResult,
  MemoryStats,
  SttStatus,
  ToolResult,
  ToolSchema
} from '../renderer/src/types'

/**
 * Secure context bridge — the only surface the renderer can use to talk to
 * the main process. Exposed as `window.api`; typings live in index.d.ts.
 */
const api = {
  // Settings (electron-store)
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('store:getSettings'),
  setSettings: (settings: AppSettings): Promise<boolean> =>
    ipcRenderer.invoke('store:setSettings', settings),
  resetSettings: (): Promise<AppSettings> => ipcRenderer.invoke('store:resetSettings'),

  // Native dialogs
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDirectory'),
  pickFile: (filters?: { name: string; extensions: string[] }[]): Promise<string | null> =>
    ipcRenderer.invoke('dialog:pickFile', filters),

  // Conversation persistence (one JSON file per conversation in userData)
  listConversations: (): Promise<Conversation[]> => ipcRenderer.invoke('conversations:list'),
  saveConversation: (convo: Conversation): Promise<boolean> =>
    ipcRenderer.invoke('conversations:save', convo),
  deleteConversation: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('conversations:delete', id),
  exportConversationMarkdown: (
    title: string,
    markdown: string
  ): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('conversations:exportMarkdown', { title, markdown }),

  // Agentic tool execution (main/ipc/tools.ts)
  listTools: (): Promise<ToolSchema[]> => ipcRenderer.invoke('tools:list'),
  executeTool: (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
    ipcRenderer.invoke('tools:execute', name, args),

  // Attachments (main/ipc/attachments.ts)
  pickAttachments: (): Promise<AttachmentLoadResult> => ipcRenderer.invoke('attachments:pick'),
  loadAttachments: (paths: string[]): Promise<AttachmentLoadResult> =>
    ipcRenderer.invoke('attachments:load', paths),
  /** Absolute path for a dropped File object (sandbox-safe replacement for File.path). */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  // Voice (main/ipc/voice.ts)
  getSttStatus: (): Promise<SttStatus> => ipcRenderer.invoke('voice:sttStatus'),
  transcribeAudio: (wav: ArrayBuffer): Promise<{ ok: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('voice:transcribe', wav),
  transcribeAudioFile: (
    path: string
  ): Promise<{ ok: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('voice:transcribeFile', path),

  // Local memory / RAG (main/ipc/memory.ts)
  memoryStats: (): Promise<MemoryStats> => ipcRenderer.invoke('memory:stats'),
  memorySearch: (
    query: string,
    topK?: number
  ): Promise<{ ok: boolean; results: MemorySearchResult[]; error?: string }> =>
    ipcRenderer.invoke('memory:search', query, topK),
  memoryAddDocument: (
    source: string,
    text: string
  ): Promise<{ ok: boolean; chunks?: number; error?: string }> =>
    ipcRenderer.invoke('memory:addDocument', source, text),
  memoryAddDocumentFromPath: (
    path: string
  ): Promise<{ ok: boolean; name?: string; chunks?: number; truncated?: boolean; error?: string }> =>
    ipcRenderer.invoke('memory:addDocumentFromPath', path),
  memoryDeleteSource: (source: string): Promise<{ ok: boolean; removed?: number; error?: string }> =>
    ipcRenderer.invoke('memory:delete', source)
}

export type AppApi = typeof api

contextBridge.exposeInMainWorld('api', api)
