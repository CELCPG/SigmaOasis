import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppSettings,
  AttachmentFileRef,
  AttachmentLoadResult,
  AttachmentPassagesResult,
  AttachmentRef,
  AuditEntryInput,
  AuditStatus,
  LibraryBundledPack,
  LibraryEmbedResult,
  LibraryFreshness,
  LibraryLookupResult,
  LibraryPackResult,
  LibraryPackSummary,
  LibraryStats,
  LibraryUpdateResult,
  Conversation,
  MemorySearchResult,
  MemoryStats,
  ModelInfo,
  NetworkActivityEntry,
  ProjectFileStatus,
  ProjectRecallOutcome,
  ResearchIndexStats,
  SttStatus,
  ToolResult,
  ToolSchema,
  UpdateStatus,
  WorkbenchStatus,
  EvalScoreSummary,
  McpServerConfig,
  McpServerStatus,
  Grant
} from '../renderer/src/types'
import type { EvalFixture } from '../renderer/src/lib/evalRunner'
import type { MemoryOrigin } from '../shared/memoryOrigin'
import type { LedgerEntryDraft, LedgerHit, LedgerUpsertResult } from '../shared/factLedger'
import type { Job, JobArgs, JobInterval, JobKind, JobOutcome } from '../shared/jobs'

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
    context?: { modelId?: string; attachments?: AttachmentFileRef[]; conversationId?: string; tainted?: boolean }
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
  /** v2.6: hosts each purpose may reach right now — the privacy audit's last row. */
  allowedHostsByPurpose: (): Promise<Record<string, string[]>> => ipcRenderer.invoke('net:allowedHosts'),
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
  /** v1.7.1: curated packs shipped inside this build, installable offline with one click. */
  libraryBundled: (): Promise<LibraryBundledPack[]> => ipcRenderer.invoke('library:bundled'),
  libraryInstallBundled: (id: string): Promise<LibraryPackResult> =>
    ipcRenderer.invoke('library:installBundled', id),
  /** v1.7: rebuild a user pack from its tracked folder; unchanged documents keep their vectors. */
  libraryUpdateFromFolder: (id: string): Promise<LibraryUpdateResult> =>
    ipcRenderer.invoke('library:updateFromFolder', id),
  /** v1.7: cheap stat-only check — has the tracked folder drifted from the snapshot? */
  libraryCheckFresh: (id: string): Promise<LibraryFreshness> => ipcRenderer.invoke('library:checkFresh', id),
  libraryEmbed: (id: string): Promise<LibraryEmbedResult> => ipcRenderer.invoke('library:embed', id),
  libraryCancelEmbed: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('library:cancelEmbed'),
  onLibraryEmbedProgress: (
    cb: (p: { packId: string; done: number; total: number }) => void
  ): (() => void) => {
    const listener = (_e: unknown, p: { packId: string; done: number; total: number }): void => cb(p)
    ipcRenderer.on('library:embedProgress', listener)
    return () => ipcRenderer.removeListener('library:embedProgress', listener)
  },

  // v1.6 Workbench (main/ipc/workbench.ts) — sandboxed Python runtime status.
  workbenchStatus: (): Promise<WorkbenchStatus> => ipcRenderer.invoke('workbench:status'),
  /** Start the sandbox ahead of a likely job; best effort, returns immediately. */
  warmWorkbench: (): Promise<boolean> => ipcRenderer.invoke('workbench:warm'),

  // Voice (main/ipc/voice.ts)
  getSttStatus: (): Promise<SttStatus> => ipcRenderer.invoke('voice:sttStatus'),
  transcribeAudio: (wav: ArrayBuffer): Promise<{ ok: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('voice:transcribe', wav),
  transcribeAudioFile: (
    path: string
  ): Promise<{ ok: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('voice:transcribeFile', path),

  // v1.10 Projects (main/ipc/store.ts + projectRecall.ts)
  /** Passages from the project's other chats most relevant to `query`. Reads disk only; ephemeral chats are never seen. */
  projectRecall: (
    conversationIds: string[],
    query: string,
    topK: number
  ): Promise<ProjectRecallOutcome> => ipcRenderer.invoke('projects:recall', conversationIds, query, topK),
  /** Exists / indexed / size for each pinned file (stat only). */
  projectFileStatus: (
    files: { id: string; sourcePath: string }[]
  ): Promise<Record<string, ProjectFileStatus>> => ipcRenderer.invoke('projects:fileStatus', files),
  /** Read and index one pinned file now (the per-turn path, taken early). */
  projectReindexFile: (file: {
    id: string
    name: string
    sourcePath: string
  }): Promise<{ ok: boolean; chunks?: number; chars?: number; truncated?: boolean; error?: string }> =>
    ipcRenderer.invoke('projects:reindexFile', file),
  /** Native picker returning paths only — nothing is read. */
  projectPickFiles: (): Promise<{ name: string; sourcePath: string }[]> =>
    ipcRenderer.invoke('projects:pickFiles'),

  // Local memory / RAG (main/ipc/memory.ts)
  memoryStats: (): Promise<MemoryStats> => ipcRenderer.invoke('memory:stats'),
  memorySearch: (
    query: string,
    topK?: number,
    minScore?: number,
    sources?: string[] | null,
    origins?: readonly MemoryOrigin[] | null
  ): Promise<{ ok: boolean; results: MemorySearchResult[]; error?: string }> =>
    ipcRenderer.invoke('memory:search', query, topK, minScore, sources ?? null, origins ?? null),
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
  /** v2.6: forget every chunk of one origin — the panel's "forget all web-origin memories". */
  memoryDeleteOrigin: (origin: MemoryOrigin): Promise<{ ok: boolean; removed?: number; error?: string }> =>
    ipcRenderer.invoke('memory:deleteOrigin', origin),

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

  // MCP servers (main/ipc/mcp.ts) — v2.5. Off until turned on, one at a time.
  // v2.6: standing questions (main/ipc/jobs.ts) — run while the app is open, delivered as digests.
  jobsList: (): Promise<Job[]> => ipcRenderer.invoke('jobs:list'),
  jobsAdd: (input: { kind: JobKind; title?: string; interval?: JobInterval; args?: JobArgs }): Promise<{ ok: boolean; job?: Job; error?: string }> =>
    ipcRenderer.invoke('jobs:add', input),
  jobsUpdate: (id: string, patch: { enabled?: boolean; interval?: JobInterval }): Promise<{ ok: boolean; job?: Job; error?: string }> =>
    ipcRenderer.invoke('jobs:update', id, patch),
  jobsRemove: (id: string): Promise<{ ok: boolean; removed?: number }> => ipcRenderer.invoke('jobs:remove', id),
  jobsRunNow: (id: string): Promise<{ ok: boolean; outcome?: JobOutcome; note?: string; error?: string }> =>
    ipcRenderer.invoke('jobs:runNow', id),
  watchlistList: (): Promise<{ url: string; name: string; targetPrice?: number; currency?: string }[]> =>
    ipcRenderer.invoke('watchlist:list'),
  /** A job's digest for its conversation; the renderer appends it and saves. */
  onJobDigest: (cb: (digest: { conversationId: string; title: string; content: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, digest: { conversationId: string; title: string; content: string }): void => cb(digest)
    ipcRenderer.on('jobs:digest', listener)
    return () => {
      ipcRenderer.removeListener('jobs:digest', listener)
    }
  },

  // v2.6: outline-then-fill (main/ipc/outline.ts) — sections arrive as they are written.
  outlineWrite: (input: { model: string; persona: string; request: string; messageId: string }): Promise<
    { ok: true; outline: { title: string; sections: { heading: string; brief: string }[] }; sections: { heading: string; text: string; truncated: boolean }[]; text: string; truncated: boolean } | { ok: false; error: string }
  > => ipcRenderer.invoke('outline:write', input),
  onOutlineSection: (cb: (update: { messageId: string; index: number; heading: string; words: number; text: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, update: { messageId: string; index: number; heading: string; words: number; text: string }): void => cb(update)
    ipcRenderer.on('outline:section', listener)
    return () => {
      ipcRenderer.removeListener('outline:section', listener)
    }
  },

  // v2.6: the fact ledger (main/ipc/factLedger.ts) — the app writes, the reader purges.
  ledgerLookup: (query: string): Promise<{ ok: boolean; hits: LedgerHit[]; error?: string }> =>
    ipcRenderer.invoke('ledger:lookup', query),
  ledgerUpsert: (drafts: LedgerEntryDraft[]): Promise<LedgerUpsertResult & { ok: boolean; error?: string }> =>
    ipcRenderer.invoke('ledger:upsert', drafts),
  ledgerStats: (): Promise<{ entries: number; expired: number }> => ipcRenderer.invoke('ledger:stats'),
  ledgerPurge: (): Promise<{ ok: boolean; removed?: boolean; error?: string }> => ipcRenderer.invoke('ledger:purge'),

  // v2.6: standing grants (main/ipc/grants.ts) — list and revoke only; nothing mints one but a dialog.
  grantsList: (): Promise<Grant[]> => ipcRenderer.invoke('grants:list'),
  grantsRevoke: (id: string): Promise<{ ok: boolean; removed?: number; error?: string }> =>
    ipcRenderer.invoke('grants:revoke', id),
  grantsRevokeAll: (): Promise<{ ok: boolean; removed?: number; error?: string }> =>
    ipcRenderer.invoke('grants:revokeAll'),

  mcpStatus: (): Promise<McpServerStatus[]> => ipcRenderer.invoke('mcp:status'),
  mcpAdd: (config: McpServerConfig): Promise<{ ok: boolean; error?: string; canceled?: boolean; server?: McpServerConfig }> =>
    ipcRenderer.invoke('mcp:add', config),
  mcpUpdate: (config: McpServerConfig): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('mcp:update', config),
  mcpRemove: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('mcp:remove', id),
  mcpReload: (id: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('mcp:reload', id),

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
    context?: string,
    /** Enabled tools, so each step can disclose what it may use before approval. */
    toolNames?: string[]
  ): Promise<{
    ok: boolean
    steps?: { title: string; detail: string; tools?: string[] }[]
    error?: string
  }> => ipcRenderer.invoke('plan:generate', task, modelId, maxSteps, context, toolNames),

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
