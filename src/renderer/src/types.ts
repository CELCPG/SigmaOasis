/**
 * Shared renderer-side types. The settings shapes mirror src/main/ipc/store.ts
 * (electron-store is the source of truth; this is the renderer's mirror).
 */

export type AccentColor = 'blue' | 'purple' | 'green'

/** Per-role sampling parameters sent with every chat completion. */
export interface SamplingSettings {
  /** 0–2. 0 is greedy decoding: same prompt, same answer. */
  temperature: number
  /** 0–1 nucleus sampling. 1 disables it. */
  topP: number
  /** Reply length cap. -1 leaves it to the server. */
  maxTokens: number
  /** Fixed RNG seed for reproducible replies; null lets the server choose. */
  seed: number | null
}

export interface ModelConfig {
  id: string
  modelId: string // the model identifier from LM Studio /v1/models
  roleName: string
  systemPrompt: string
  color: AccentColor
  enabled: boolean
  sampling: SamplingSettings
}

export interface ToolToggles {
  read_file: boolean
  write_file: boolean
  list_directory: boolean
  run_terminal_command: boolean
  web_search: boolean
  fetch_webpage: boolean
  get_current_datetime: boolean
  create_note: boolean
  list_notes: boolean
  read_note: boolean
  memory_save: boolean
  memory_search: boolean
  memory_forget: boolean
  deep_research: boolean
}

export type SearchProviderId = 'searxng' | 'brave' | 'duckduckgo'

export interface SearchSettings {
  /** Which backend serves the web_search tool. */
  provider: SearchProviderId
  /** Base URL of a self-hosted SearXNG instance (loopback recommended). */
  searxngUrl: string
  /** Max results handed to the model per search (1–10). */
  maxResults: number
  /** Show a confirmation dialog with the exact outgoing query before every search. */
  confirmBeforeSearch: boolean
  /** Re-read JavaScript-dependent pages in an offscreen browser. Off by default. */
  useHeadlessRenderer: boolean
}

export interface ResearchSettings {
  /** Budget preset for a single deep_research call. */
  depth: 'quick' | 'standard' | 'thorough'
  /** Approve the whole research plan before any query is sent. */
  confirmPlan: boolean
}

export interface ProxySettings {
  /** Route outbound traffic through a proxy. LM Studio is never proxied. */
  mode: 'none' | 'socks5' | 'http'
  host: string
  port: number
}

export interface UpdateSettings {
  /** Periodic background update checks. Off by default — manual "Check now" always works. */
  autoCheck: boolean
}

/** One entry in the main-process network activity log (Settings → Privacy). */
export interface NetworkActivityEntry {
  at: number
  purpose: 'lmstudio' | 'search' | 'webpage' | 'render' | 'proxytest' | 'update'
  /** Origin only — full URLs (and queries) are never logged. */
  origin: string
  method: string
  status: number | null
  ok: boolean
  blocked?: boolean
  error?: string
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

/**
 * Live size of the ephemeral research index — web pages fetched this session,
 * chunked and embedded in RAM for relevance ranking. Never written to disk and
 * discarded when the app exits.
 */
export interface ResearchIndexStats {
  pages: number
  chunks: number
  chars: number
  embeddedChunks: number
  /** Cached search responses held in RAM. */
  searchQueries: number
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
  search: SearchSettings
  research: ResearchSettings
  proxy: ProxySettings
  updates: UpdateSettings
  /** First-run setup checklist has been dismissed. */
  onboardingCompleted: boolean
  /** Hide tool-call blocks in chat; show a thinking animation instead. */
  hideToolCalls: boolean
  /** Show tokens/sec and time-to-first-token under each reply. */
  showResponseStats: boolean
  /**
   * What happens when a conversation outgrows the model's context window.
   * 'compact' summarizes the dropped span and carries it forward; 'trim'
   * silently drops it, which is what every version before 0.8.2 did.
   */
  contextManagement: 'compact' | 'trim'
}

// ---- LM Studio / OpenAI-compatible API --------------------------------------

export type ConnectionStatus = 'offline' | 'connecting' | 'online'

/**
 * A model as LM Studio describes it. Everything past `id` comes from LM
 * Studio's own REST API (`/api/v0/models`) and is absent on older builds that
 * only serve the OpenAI-compatible `/v1/models`.
 */
export interface ModelInfo {
  id: string
  /** 'llm' | 'vlm' | 'embeddings' when known. */
  type?: string
  /** True when the model accepts images. Tool support is not reported by LM Studio. */
  vision?: boolean
  /** Context the model is loaded with right now — the number that matters for budgeting. */
  loadedContextLength?: number
  /** Context the model supports at most. */
  maxContextLength?: number
  loaded?: boolean
  quantization?: string
  arch?: string
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
  /** Audio files to transcribe locally instead of attaching. */
  audioPaths: string[]
}

// ---- Auto-update ------------------------------------------------------------

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
  version?: string
  percent?: number
  error?: string
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
  /**
   * A reasoning model's chain-of-thought, kept out of `content` so it is not
   * rendered as the answer, read aloud, or replayed to the model next turn.
   */
  reasoning?: string
  /** How long the model spent thinking, for the "Thought for Ns" label. */
  reasoningMs?: number
  /** Measured generation performance. Token counts only when the server reported them. */
  stats?: ResponseStats
  createdAt: number
}

/**
 * What a reply cost, as measured rather than estimated.
 *
 * Token counts come from the server's own `usage` block. When a server does
 * not report one, they stay undefined and the UI shows timing alone — an
 * invented tokens/sec figure is indistinguishable from a measured one, which
 * makes it worse than no figure at all.
 */
export interface ResponseStats {
  promptTokens?: number
  completionTokens?: number
  tokensPerSecond?: number
  /** Time to the first content or reasoning delta. */
  ttftMs: number
  totalMs: number
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
  /**
   * Rolling summary of messages that no longer fit the context window. Carried
   * into the system prompt so the model keeps the shape of a conversation
   * whose opening it can no longer see.
   */
  summary?: ConversationSummary
  createdAt: number
  updatedAt: number
}

export interface ConversationSummary {
  text: string
  /** The last message folded into this summary — everything up to and including it. */
  throughMessageId: string
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
