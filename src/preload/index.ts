import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppSettings,
  AttachmentLoadResult,
  AttachmentPassagesResult,
  AttachmentRef,
  AuditEntryInput,
  AuditStatus,
  LibraryEmbedResult,
  LibraryLookupResult,
  LibraryPackResult,
  LibraryPackSummary,
  LibraryStats,
  Conversation,
  MemorySearchResult,
  MemoryStats,
  ModelInfo,
  NetworkActivityEntry,
  ResearchIndexStats,
  SttStatus,
  ToolResult,
  ToolSchema,
  UpdateStatus,
  EvalScoreSummary
} from '../renderer/src/types'
import type { EvalFixture } from '../renderer/src/lib/evalRunner'

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
  executeTool: (
    name: string,
    args: Record<string, unknown>,
    context?: { modelId?: string }
  ): Promise<ToolResult> => ipcRenderer.invoke('tools:execute', name, args, context),
  /**
   * Rank candidate tools against the user's message by embedding cosine
   * (main/ipc/toolRank.ts). { ok: false } means "no ranking available" — the
   * caller falls back to its full list; it is never a turn failure.
   */
  rankTools: (
    query: string,
    tools: { name: string; description: string }[]
  ): Promise<{ ok: boolean; scores?: Record<string, number>; error?: string }> =>
    ipcRenderer.invoke('tools:rank', query, tools),

  /**
   * Measured tool-choice scores per evaluated model (main/ipc/evalResults.ts,
   * Layer 0c). Empty list when no eval has been run.
   */
  evalScores: (): Promise<EvalScoreSummary[]> => ipcRenderer.invoke('eval:scores'),

  /**
   * In-app "Run eval" support (Settings → Models): the fixtures plus the full
   * unfiltered toolbox, and persistence for each model's result. An empty
   * fixture list means the test tree is unavailable (packaged app).
   */
  evalFixtures: (): Promise<{ fixtures: EvalFixture[]; tools: ToolSchema[] }> =>
    ipcRenderer.invoke('eval:fixtures'),
  saveEvalResult: (payload: unknown): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('eval:saveResult', payload),

  // Keep a chat model resident in LM Studio (main/ipc/modelPin.ts)
  pinModel: (modelId: string): Promise<boolean> => ipcRenderer.invoke('models:pin', modelId),

  /**
   * The model list with capabilities (main/ipc/modelCatalog.ts). Goes through
   * the main process rather than fetching from the renderer so it passes the
   * egress allowlist and shows up in the Privacy activity log like every other
   * request.
   */
  getModelCatalog: (): Promise<
    { models: ModelInfo[]; detailed: boolean } | { error: string }
  > => ipcRenderer.invoke('models:catalog'),

  /** Compact dropped conversation history into a carry-forward note (main/ipc/summarize.ts). */
  summarizeConversation: (request: {
    previousSummary?: string
    droppedText: string
    modelId?: string
  }): Promise<{ ok: true; summary: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('chat:summarize', request),

  // Build version shown in the sidebar footer
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),

  /** Live phase updates from a running deep_research call. */
  onResearchProgress: (
    cb: (update: { phase: string; detail: string }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      update: { phase: string; detail: string }
    ): void => cb(update)
    ipcRenderer.on('research:progress', listener)
    return () => {
      ipcRenderer.removeListener('research:progress', listener)
    }
  },

  // Private web search (main/ipc/search.ts)
  testSearchProvider: (): Promise<{ ok: boolean; detail: string }> =>
    ipcRenderer.invoke('search:test'),
  braveKeyStatus: (): Promise<{ set: boolean; encrypted: boolean }> =>
    ipcRenderer.invoke('search:braveKeyStatus'),
  setBraveApiKey: (key: string): Promise<{ ok: boolean; warning?: string }> =>
    ipcRenderer.invoke('search:setBraveApiKey', key),

  // Ephemeral research index over fetched pages (main/ipc/researchIndex.ts).
  // RAM only — nothing here is ever written to disk.
  researchIndexStats: (): Promise<ResearchIndexStats> => ipcRenderer.invoke('research:stats'),
  clearResearchIndex: (): Promise<{ pages: number; entries: number }> =>
    ipcRenderer.invoke('research:clear'),

  // Network egress audit (main/ipc/net.ts)
  getNetworkActivity: (): Promise<NetworkActivityEntry[]> => ipcRenderer.invoke('net:getActivity'),
  clearNetworkActivity: (): Promise<boolean> => ipcRenderer.invoke('net:clearActivity'),
  getProxyStatus: (): Promise<{ mode: string; description: string; error?: string }> =>
    ipcRenderer.invoke('net:proxyStatus'),
  testProxy: (): Promise<{ ok: boolean; detail: string }> => ipcRenderer.invoke('net:testProxy'),

  // Attachments (main/ipc/attachments.ts)
  pickAttachments: (): Promise<AttachmentLoadResult> => ipcRenderer.invoke('attachments:pick'),
  loadAttachments: (paths: string[]): Promise<AttachmentLoadResult> =>
    ipcRenderer.invoke('attachments:load', paths),
  /** v1.4.8: passages from indexed attachments most relevant to `query` (RAM index, loopback only). */
  attachmentPassages: (
    refs: AttachmentRef[],
    query: string,
    topK: number
  ): Promise<AttachmentPassagesResult> => ipcRenderer.invoke('attachments:passages', refs, query, topK),
  /** Absolute path for a dropped File object (sandbox-safe replacement for File.path). */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  // v1.5 Reference library (main/ipc/library.ts) — offline; disk + loopback only.
  libraryList: (): Promise<LibraryPackSummary[]> => ipcRenderer.invoke('library:list'),
  libraryStats: (): Promise<LibraryStats> => ipcRenderer.invoke('library:stats'),
  libraryLookup: (query: string, packId?: string | null, topK?: number): Promise<LibraryLookupResult> =>
    ipcRenderer.invoke('library:lookup', query, packId ?? null, topK),
  libraryInstallFromDirectory: (path?: string): Promise<LibraryPackResult> =>
    ipcRenderer.invoke('library:installFromDirectory', path),
  libraryAddFolder: (path?: string, name?: string): Promise<LibraryPackResult> =>
    ipcRenderer.invoke('library:addFolder', path, name),
  libraryRemove: (id: string): Promise<{ removed: boolean }> => ipcRenderer.invoke('library:remove', id),
  libraryEmbed: (id: string): Promise<LibraryEmbedResult> => ipcRenderer.invoke('library:embed', id),
  libraryCancelEmbed: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('library:cancelEmbed'),
  onLibraryEmbedProgress: (
    cb: (p: { packId: string; done: number; total: number }) => void
  ): (() => void) => {
    const listener = (_e: unknown, p: { packId: string; done: number; total: number }): void => cb(p)
    ipcRenderer.on('library:embedProgress', listener)
    return () => ipcRenderer.removeListener('library:embedProgress', listener)
  },

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
    topK?: number,
    minScore?: number,
    sources?: string[] | null
  ): Promise<{ ok: boolean; results: MemorySearchResult[]; error?: string }> =>
    ipcRenderer.invoke('memory:search', query, topK, minScore, sources ?? null),
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
    ipcRenderer.invoke('memory:delete', source),

  // Session audit log (main/ipc/audit.ts) — opt-in, encrypted, tamper-evident.
  auditStatus: (): Promise<AuditStatus> => ipcRenderer.invoke('audit:status'),
  auditRecord: (input: AuditEntryInput): Promise<boolean> =>
    ipcRenderer.invoke('audit:record', input),
  auditExport: (
    sessionId?: string
  ): Promise<
    | { ok: true; path: string; entries: number; chainValid: boolean }
    | { ok: false; canceled?: boolean; error?: string }
  > => ipcRenderer.invoke('audit:export', sessionId),
  auditPurge: (): Promise<{ removed: number }> => ipcRenderer.invoke('audit:purge'),

  // Layer 4 trace export (main/ipc/traces.ts) — OpenAI JSONL for out-of-band
  // fine-tuning, labeled from outcomes, redacted, schema-stamped. Opt-in per
  // export via the save dialog; writes to local disk only.
  tracesExport: (
    sessionId?: string
  ): Promise<
    | {
        ok: true
        paths: { positive: string; rejected: string; manifest: string; tools: string }
        counts: {
          turns: number
          positive: number
          rejected: number
          unlabeled: number
          skippedEntries: number
        }
        outcomesMatched: number
        schemaVersion: string | null
        chainValid: boolean
      }
    | { ok: false; canceled?: boolean; error?: string }
  > => ipcRenderer.invoke('traces:export', sessionId),

  // Plan mode (main/ipc/plan.ts) — structured plan generation; execution is renderer-side.
  planGenerate: (
    task: string,
    modelId?: string,
    maxSteps?: number,
    /** The conversation the task came from, so a follow-up plans against it. */
    context?: string
  ): Promise<{ ok: boolean; steps?: { title: string; detail: string }[]; error?: string }> =>
    ipcRenderer.invoke('plan:generate', task, modelId, maxSteps, context),

  // Auto-update (main/updates.ts)
  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('updates:getStatus'),
  checkForUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke('updates:check'),
  installUpdate: (): Promise<boolean> => ipcRenderer.invoke('updates:install'),
  onUpdateStatus: (cb: (status: UpdateStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatus): void => cb(status)
    ipcRenderer.on('updates:status', listener)
    return () => {
      ipcRenderer.removeListener('updates:status', listener)
    }
  }
}

export type AppApi = typeof api

contextBridge.exposeInMainWorld('api', api)
