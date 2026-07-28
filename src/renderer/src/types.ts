/**
 * Shared renderer-side types. The settings shapes mirror src/main/ipc/store.ts
 * (electron-store is the source of truth; this is the renderer's mirror).
 */

export type AccentColor = 'blue' | 'purple' | 'green'

export interface ModelConfig {
  id: string
  modelId: string // the model identifier from LM Studio /v1/models
  roleName: string
  systemPrompt: string
  color: AccentColor
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
  /** Automatically read assistant replies aloud (voice mode). */
  autoRead: boolean
  /** speechSynthesis voice URI; empty = system default. */
  voiceURI: string
  /** Speech rate, 0.5–2. */
  rate: number
}

export interface SttSettings {
  /** Path to the whisper.cpp CLI; empty = auto-detect (Homebrew, PATH). */
  whisperCliPath: string
  /** Path to a ggml whisper model file (e.g. ggml-base.en.bin). */
  whisperModelPath: string
}

export interface SttStatus {
  available: boolean
  cliPath: string | null
  modelPath: string | null
  reason?: string
}

// ---- Local memory (RAG) -------------------------------------------------------

export interface MemorySettings {
  /** Automatically inject relevant memory chunks into each chat turn. */
  autoContext: boolean
  /** How many chunks to inject / return by default. */
  topK: number
  /** Embedding model id; empty = auto-detect (first /v1/models id containing "embed"). */
  embeddingModel: string
}

export interface MemorySourceStat {
  source: string
  chunks: number
  updatedAt: number
}

export interface MemoryStats {
  available: boolean
  embeddingModel: string | null
  reason?: string
  /** Sources were indexed by more than one embedding model — some are unsearchable. */
  mixedModels: boolean
  totalChunks: number
  sources: MemorySourceStat[]
}

export interface MemorySearchResult {
  source: string
  text: string
  score: number
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
}

// ---- LM Studio / OpenAI-compatible API --------------------------------------

export type ConnectionStatus = 'offline' | 'connecting' | 'online'

export interface ModelInfo {
  id: string
}

// ---- Attachments ------------------------------------------------------------

export interface Attachment {
  id: string
  kind: 'image' | 'file'
  name: string
  mimeType: string
  sizeBytes: number
  /** Images: base64 data URL, used both for display and for the vision API. */
  dataUrl?: string
  /** Text files: extracted (possibly truncated) content. */
  textContent?: string
  /** Set when a text file was cut down to fit the context window. */
  truncated?: boolean
}

export interface AttachmentLoadResult {
  attachments: Attachment[]
  rejected: { name: string; reason: string }[]
}

// ---- Chat domain ------------------------------------------------------------

export type ChatMode = 'independent' | 'collaborative' | 'orchestrated'

export interface ToolCallRecord {
  id: string
  name: string
  args: Record<string, unknown>
  result?: string
  status: 'running' | 'done' | 'error'
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  attachments?: Attachment[]
  /** Present on assistant messages: which model slot produced this reply. */
  modelId?: string
  roleName?: string
  color?: AccentColor
  toolCalls?: ToolCallRecord[]
  createdAt: number
}

export interface Conversation {
  id: string
  title: string
  mode: ChatMode
  /** Active model slot id for independent mode. */
  activeModelSlotId?: string
  /** Orchestrator slot id for orchestrated mode. */
  orchestratorSlotId?: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}

// ---- Tool execution (renderer ↔ main) ----------------------------------------

/** OpenAI-compatible function/tool schema, as sent to the chat completions API. */
export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ToolResult {
  ok: boolean
  /** Tool output fed back to the model when ok is true. */
  output?: string
  error?: string
}
