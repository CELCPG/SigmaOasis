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
  /** Top-k truncation. -1 follows the model family's recipe, 0 disables it. */
  topK: number
  /** Minimum-probability floor. -1 follows the family recipe, 0 disables it. */
  minP: number
}

export interface ModelConfig {
  id: string
  modelId: string // the model identifier from LM Studio /v1/models
  roleName: string
  systemPrompt: string
  color: AccentColor
  enabled: boolean
  sampling: SamplingSettings
  /** Context window override for budgeting; null = trust what LM Studio reports. */
  contextWindow: number | null
  /**
   * Per-role tool allowlist (v1.3). Absent/undefined = all globally-enabled
   * tools; an array — even empty — restricts the slot to the named tools that
   * are also globally enabled.
   */
  tools?: string[]
  /**
   * One-line routing declaration (v1.4): "send me X; don't send me Y". Shown
   * to other models in the consult_model roster and used by the pre-flight
   * router. Absent = the router falls back to the system prompt.
   */
  capability?: string
  /**
   * Structured routing tag (v1.4) the pre-flight classifier matches on.
   * Absent = generalist; the slot is never auto-routed a specialty signal.
   */
  specialty?: 'coding' | 'research' | 'finance' | 'data'
}

/**
 * Toggle keys derive from the tool table (src/shared/tools) — the same
 * declaration the main process uses, so the two can no longer drift.
 */
import type { ToolToggles } from '../../shared/tools'
export type { ToolToggles } from '../../shared/tools'

export interface ShoppingSettings {
  /** Refuse shopping fetches when no proxy is active. On by default. */
  requireProxy: boolean
  /** Sellers fetched per comparison (1–5). */
  maxSellers: number
  /** Drop affiliate listicles and content farms from candidate discovery. */
  excludeTierX: boolean
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
  /** Mirrors NetworkPurpose in src/main/ipc/net.ts — keep the two in step. */
  purpose:
    | 'lmstudio'
    | 'search'
    | 'webpage'
    | 'shop'
    | 'image'
    | 'render'
    | 'geo'
    | 'proxytest'
    | 'update'
    | 'market'
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

// ---- v0.9: Second opinion (critic pass) -------------------------------------

/** A different role's review of an assistant reply. Display-only. */
/** v1.5.1: the think-harder pass — draft → review → revise, disclosed. */
export interface DeliberationRecord {
  reviewerRole: string
  reviewerModelId: string
  /** The answerer reviewed its own draft (no second slot) — weaker, and said so. */
  self: boolean
  status: 'reviewing' | 'revising' | 'done' | 'error'
  /** The reply as it stood before the pass. */
  draft: string
  review: string
  /** True when the revision replaced the draft. */
  revised: boolean
  note?: string
  createdAt: number
}

export interface SecondOpinionRecord {
  roleName: string
  modelId: string
  text: string
  /**
   * v1.1 grounding: true when the review was triggered automatically because
   * the reply was flagged unverified, rather than requested by the user.
   */
  automatic?: boolean
  createdAt: number
}

export interface SecondOpinionSettings {
  /** Master switch for the critic pass. Off by default. */
  enabled: boolean
  /** Reviewing slot; null = auto (first enabled slot that is not the answerer). */
  criticSlotId: string | null
}

// ---- v1.2: claim check (settle the critic's list) -----------------------------

/**
 * How one extracted claim fared against sources. Never model self-graded.
 *
 * `unverifiable` and `unchecked` are different admissions and must stay apart:
 * a source was read and did not settle the claim, versus no source could be
 * reached at all. Reporting the second as the first is how a structurally
 * impossible pass looks like a completed one.
 */
export type ClaimVerdict = 'confirmed' | 'contradicted' | 'unverifiable' | 'unchecked'

export interface CheckedClaim {
  /** The bare factual claim as extracted by the critic. */
  text: string
  verdict: ClaimVerdict
  /** The source that settled the claim, when one did. */
  source?: string
  /** The one-line basis the judge gave for the verdict. */
  basis?: string
}

/** A mechanical per-claim verification of an assistant reply. Display-only. */
export interface ClaimCheckRecord {
  roleName: string
  modelId: string
  claims: CheckedClaim[]
  /** Set when the pass stopped early (claim cap, declined search, failures). */
  budgetNote?: string
  createdAt: number
}

/** Why an escalation is on the table, strongest signal first. */
export type EscalationReason = 'iteration_cap' | 'contradicted' | 'unverified'

/**
 * v1.4 escalation (Layer 2d): an offer to re-run the turn that produced this
 * reply on a bigger slot. `slotId` is re-validated against current settings
 * when clicked — the offer is a snapshot, never a command.
 */
export interface EscalationOffer {
  slotId: string
  roleName: string
  reason: EscalationReason
}

// ---- v1.4: measured tool-choice scores (Layer 0c) -----------------------------

export interface EvalRate {
  hit: number
  of: number
}

/**
 * One model's folded tool-choice eval scores, aggregated main-side from
 * .eval-results/ (main/ipc/evalResults.ts, duplicated there so the module
 * stays self-contained for node:test). Absent for models never evaluated.
 */
export interface EvalScoreSummary {
  model: string
  /** ISO timestamp of the newest run folded into this summary. */
  ranAt: string
  correctTool: EvalRate
  spuriousCall: EvalRate
  argValidity: EvalRate
  loop: EvalRate
}

export interface ClaimCheckSettings {
  /**
   * Master switch for the automatic claim-check pass on unverified answers.
   * Requires secondOpinion.enabled — the critic slot does the extraction and
   * judging, never the answerer.
   */
  enabled: boolean
  /** Cap on extracted claims checked per reply; keeps the pass cheap. */
  maxClaims: number
}

// ---- v0.9: visible memory recall ---------------------------------------------

/** A long-term memory chunk injected into the system prompt for one turn. */
export interface MemoryContextItem {
  source: string
  score: number
  text: string
  /**
   * v1.13: the bracketed number the model was given for this passage, when it
   * was given one (library lookups number theirs). The strip shows it, so a
   * `[1]` in the reply has something on screen to name.
   */
  index?: number
  /**
   * v1.13.1: did the reply actually cite this passage? Derived from the
   * answer at render time and never stored — the strip lists what was
   * retrieved, and only the finished answer says what was used.
   */
  cited?: boolean
  /** The document's own web source, when it has one — shown as a link. */
  url?: string
}

// ---- v0.9: session audit log ---------------------------------------------------

export interface AuditSettings {
  /** Append-only session transcript. Off by default — a privacy app does not log by default. */
  enabled: boolean
  /** Delete every audit log when the app quits. */
  autoPurgeOnQuit: boolean
}

export interface AuditSessionInfo {
  sessionId: string
  entries: number
  sizeBytes: number
}

export interface AuditStatus {
  /** safeStorage encryption is available; the log cannot run without it. */
  available: boolean
  enabled: boolean
  currentSessionId: string
  sessions: AuditSessionInfo[]
}

export type AuditEntryKind = 'session_start' | 'user_input' | 'assistant_output' | 'tool_call'

export interface AuditEntryInput {
  conversationId: string
  kind: AuditEntryKind
  roleName?: string
  modelId?: string
  toolName?: string
  ok?: boolean
  text: string
  /** Entries for ephemeral conversations are refused — no-trace includes the log. */
  ephemeral?: boolean
}

// ---- v0.9: Plan mode ------------------------------------------------------------

/**
 * `stopped` is the user's own Stop landing on the running step — not the step
 * blowing up. `skipped` is a step that will never run now: the plan ended
 * before it, so it must not look like a step still waiting its turn.
 */
export type PlanStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'stopped' | 'skipped'

/** How a plan ended. Absent while it awaits approval or is still running. */
export type PlanOutcome = 'completed' | 'cancelled' | 'stopped' | 'failed'

export interface PlanStep {
  id: string
  title: string
  detail: string
  status: PlanStepStatus
  /**
   * Tools this step may reach for, named by the planner and filtered to the
   * ones actually enabled. Shown before approval: the user authorises a plan
   * on what it will do, and a title is not that (v1.12.3).
   */
  tools?: string[]
  /** Capped result of the step's sub-turn, shown expandable in the checklist. */
  output?: string
}

export interface ChatPlan {
  steps: PlanStep[]
  /** Execution starts only after the user approves (Settings → General → Plan mode). */
  approved: boolean
  /**
   * Terminal state. Once set the plan is over: no approval controls, and the
   * header says how it ended rather than how many steps are done.
   */
  outcome?: PlanOutcome
  createdAt: number
}

export interface PlanSettings {
  /** Max steps a generated plan may contain (1–10). */
  maxSteps: number
  /** Show the plan for approval before executing. On by default. */
  confirmPlan: boolean
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
  /** v1.4.8: attached documents indexed for per-turn retrieval (RAM only). */
  pinnedDocs: number
  pinnedChars: number
}

/**
 * v1.10: a group of conversations in the rail, carrying the context every chat
 * in it shares. Mirrors src/main/ipc/projects.ts.
 */
export interface Project {
  id: string
  name: string
  color: ProjectColor
  createdAt: number
  /** Standing instructions appended to the system prompt of every chat in the project. '' = none. */
  instructions: string
  /** Files pinned to the project (paths only); each chat retrieves passages from them per turn. */
  files: ProjectFile[]
  /** Chats in this project may recall passages from the project's other chats. */
  recall: boolean
  /** Applied to a chat created inside the project; never changes existing chats. */
  defaults: ProjectDefaults
}

export interface ProjectFile {
  id: string
  name: string
  sourcePath: string
}

export interface ProjectDefaults {
  mode: ChatMode | null
  activeModelSlotId: string | null
  /** undefined = app default; null = all sources; [] = none; list = those sources. */
  memorySources?: string[] | null
}

export type ProjectColor = 'teal' | 'blue' | 'purple' | 'amber' | 'rose' | 'slate'

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
  /** Chain-of-thought block: collapsed (default), always expanded, or hidden. */
  reasoningDisplay: 'collapsed' | 'expanded' | 'hidden'
  /** Show tokens/sec and time-to-first-token under each reply. */
  showResponseStats: boolean
  /** v1.9.2: conversation rail collapsed to an icon strip (⌘B). */
  sidebarCollapsed: boolean
  /** v1.10: chat panel (right side) collapsed to an icon strip (⌘J). */
  rightPanelCollapsed: boolean
  /** v1.10: conversation groups shown in the rail. */
  projects: Project[]
  /**
   * What happens when a conversation outgrows the model's context window.
   * 'compact' summarizes the dropped span and carries it forward; 'trim'
   * silently drops it, which is what every version before 0.8.2 did.
   */
  contextManagement: 'compact' | 'trim'
  /** v0.9: a second role reviews replies on request (Settings → Models). */
  secondOpinion: SecondOpinionSettings
  /** v1.2: mechanical per-claim verification of unverified answers. */
  claimCheck: ClaimCheckSettings
  /** v1.4.6: revise an answer whose specifics the tools did not support. */
  grounding: { autoCorrect: boolean; playbooks: boolean; selfReview: boolean; workbenchChecks: boolean; ledger: boolean }
  /** v1.4: private shopping research. Tools ship off; this governs behavior. */
  shopping: ShoppingSettings
  /** v0.9: append-only encrypted session transcript (Settings → Privacy). */
  audit: AuditSettings
  /** v0.9: multi-step plan generation and execution. */
  plan: PlanSettings
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

// ---- v1.5 Reference library (main/ipc/library.ts) ------------------------------

export interface LibraryPackSummary {
  id: string
  name: string
  description: string
  version: string
  license: string
  kind: 'curated' | 'user'
  sourceNote?: string
  /** v1.7: the folder a user pack tracks; absent on curated and pre-v1.7 packs. */
  sourceFolder?: string
  installedAt: string
  docs: number
  chars: number
  chunks: number
  embeddedChunks: number
  embeddingModel: string | null
}

export interface LibraryPassage {
  packId: string
  packName: string
  docId: string
  docTitle: string
  section: string
  position: number
  text: string
  score: number
  source?: string
  license?: string
  date?: string
}

export interface LibraryLookupResult {
  ok: boolean
  passages: LibraryPassage[]
  mode: 'hybrid' | 'keyword'
  notes: string[]
  error?: string
  /** The model-facing rendering (same text the reference_lookup tool returns). */
  formatted?: string
}

export interface LibraryStats {
  packs: number
  docs: number
  chunks: number
  chars: number
  embeddedChunks: number
  scanned: boolean
}

export interface LibraryPackResult {
  ok: boolean
  pack?: LibraryPackSummary
  error?: string
  cancelled?: boolean
}

export interface LibraryEmbedResult {
  ok: boolean
  embedded: number
  total: number
  model: string | null
  error?: string
}

/** v1.7.1: a curated pack shipped inside the app, installable offline. */
export interface LibraryBundledPack {
  id: string
  name: string
  description: string
  version: string
  license: string
  docs: number
  installed: boolean
  installedVersion: string | null
}

/** v1.7: result of updating a user pack from its source folder. */
export interface LibraryUpdateResult {
  ok: boolean
  pack?: LibraryPackSummary
  /** Chunks whose vectors were carried over (their document's text is unchanged). */
  carriedChunks?: number
  /** Chunks that still need embedding after the update. */
  missingChunks?: number
  error?: string
}

/** v1.7: has a user pack's source folder drifted from the snapshot? */
export interface LibraryFreshness {
  supported: boolean
  fresh: boolean
  missingFolder: boolean
  added: number
  removed: number
  changed: number
  examples: string[]
}

/** v1.6: the Workbench's sandboxed Python runtime (main/ipc/workbench.ts). */
export interface WorkbenchStatus {
  available: boolean
  /** Pyodide version, when the runtime is present. */
  version: string | null
  /** Why it is unavailable, when it is. */
  reason?: string
  /**
   * The runtime is loaded and serving, so the next run skips the cold start.
   * False for the whole of a boot in progress — which is when a run needs to
   * be told what it is waiting on (components/RanCodeBlock.tsx).
   */
  warm: boolean
  /** Top-level packages bundled offline, e.g. numpy, pandas, matplotlib. */
  packages: string[]
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
  /** Text files: extracted content — the whole file, or its opening when `indexed`. */
  textContent?: string
  /** Set when only the opening of a text file is inlined. */
  truncated?: boolean
  /** v1.4.8: full length of the document when only its opening is inlined. */
  totalChars?: number
  /**
   * v1.4.8: the whole text is in the session's RAM index; every turn retrieves
   * the passages relevant to that turn's question (see attachmentContext).
   */
  indexed?: boolean
  /** v1.4.8: original path, so the index can be rebuilt after a restart. */
  sourcePath?: string
  /** v1.6: a spreadsheet/data file — no inline text; the Workbench reads it from /work. */
  dataFile?: boolean
  /** v1.6: a tabular text file — only its head is inlined; the whole file is at /work. */
  tabular?: boolean
}

/** v1.6: what the renderer hands main so tools can stage attached files under /work. */
export interface AttachmentFileRef {
  name: string
  sourcePath: string
}

/** v1.4.8: what the renderer hands main to retrieve from an attachment. */
export interface AttachmentRef {
  id: string
  name: string
  sourcePath?: string
}

export interface AttachmentPassage {
  attachmentId: string
  name: string
  text: string
  /** 0 (start) .. 1 (end) of the document. */
  position: number
  score: number
}

export interface AttachmentPassagesResult {
  ok: boolean
  passages: AttachmentPassage[]
  notes: string[]
}

/** v1.10: one passage recalled from a sibling chat in the same project. */
export interface ProjectRecallItem {
  conversationId: string
  title: string
  text: string
  position: number
  score: number
}

/** v1.10: where a pinned file stands — on disk, in this session's index. */
export interface ProjectFileStatus {
  exists: boolean
  indexed: boolean
  sizeBytes: number | null
}

export interface ProjectRecallOutcome {
  ok: boolean
  items: ProjectRecallItem[]
  consulted: number
  error?: string
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

/**
 * v1.3: what a reply asserted that its own tools did not support. Produced
 * mechanically by `checkToolGrounding`; see toolGrounding.ts for why.
 */
export interface GroundingReport {
  /** Money figures in the reply backed by no tool output or user statement. */
  figures: string[]
  /** Links in the reply that appear in no tool output. */
  links: string[]
  /** v1.9.2: quantities with units backed by no tool output or user statement. */
  quantities?: string[]
  /** Countries the reply names that the consulted sources never mention (v1.4.5). */
  origins?: string[]
  /** Phone numbers and email addresses backed by no tool output (v1.4.5). */
  contacts?: string[]
  /** v1.12.1: tools the reply says it used that never ran this turn. */
  toolClaims?: string[]
  /** v1.14: tools that DID run and the reply's own "Tools used" section omits. */
  toolDisclosure?: string[]
  /** v1.17: an argument the reply quotes as passed that the call never carried. */
  toolArgs?: string[]
  /** v1.6: the reply's Python failed when run in the sandbox. */
  code?: string[]
  /** Street addresses backed by no tool output (v1.4.5). */
  addresses?: string[]
  /** v1.13: bracketed citation markers naming a passage the library never returned. */
  citations?: string[]
  /** v1.14: spans presented as direct quotations that no tool output contains. */
  quotes?: string[]
  /** v1.14: `[n] (Document)` attributions naming a document that is not passage n's. */
  attributions?: string[]
  /** Tools whose output formed the corpus, named in the disclosure. */
  checkedAgainst: string[]
}

export type ChatMode = 'independent' | 'collaborative' | 'orchestrated'

/**
 * One image a tool asked to show in the chat. `dataUrl` (never a remote URL)
 * is displayed — the CSP allows data: images only, and the main process
 * fetches the bytes so the request goes through the SSRF guard, any configured
 * proxy, and the network activity log, carrying no cookies or referrer. The
 * host still sees the machine's IP unless a proxy is on; the confirmation
 * dialog says so. `pageUrl` is where a click leads.
 */
export interface ToolImage {
  title: string
  pageUrl: string
  dataUrl: string
}

export interface ToolCallRecord {
  id: string
  name: string
  args: Record<string, unknown>
  result?: string
  status: 'running' | 'done' | 'error'
  /** Images the tool returned for display (image_search), shown as a gallery. */
  images?: ToolImage[]
  /**
   * The model's one-sentence reason for the call (v1.3, Layer 1d), captured
   * from the round that produced it and rendered in the tool-call block.
   * Display-only — the wire history carries it as the assistant message's own
   * content, where the model expects its words to live.
   */
  preamble?: string
  /**
   * v1.12.2: the plan step whose sub-turn made this call. Set, the call renders
   * under that step in the plan block rather than in the message's own list —
   * twenty calls stay grouped by the step that made them instead of becoming a
   * wall under the answer.
   */
  planStepId?: string
  /**
   * v1.12.3: the app has already told the user this run verified nothing — a
   * recomputation fed by the model's own constants, say. Such a run must not
   * then be named in "Checked against", and its output supports no figure.
   */
  checksNothing?: boolean
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
  /**
   * A different role's review of this reply (v0.9 Second Opinion). Display-only —
   * never replayed to a model as part of the conversation.
   */
  secondOpinion?: SecondOpinionRecord
  /** v1.5.1: the think-harder pass that ran on this reply, if any. */
  deliberation?: DeliberationRecord
  /** v1.6: Workbench verification passes that ran on this reply (recompute / code check). */
  checks?: {
    /** v1.12.5: 'deadline' — the post-answer budget ran out, and this says what was lost. */
    kind: 'recompute' | 'code' | 'echo' | 'conflict' | 'deadline'
    ok: boolean
    summary: string
  }[]
  /**
   * The long-term memory chunks injected into the system prompt for this turn
   * (v0.9 visible recall). Display-only — never replayed to a model.
   */
  memoryContext?: MemoryContextItem[]
  /**
   * v1.4.8: passages retrieved from the conversation's indexed attachments for
   * this reply — shown like memory recall, so the user sees what the model was
   * given from their document.
   */
  attachmentContext?: MemoryContextItem[]
  /** v1.5: passages the app retrieved from the local reference library for this reply. */
  libraryContext?: MemoryContextItem[]
  /** v1.12.2: the library was consulted and none of what it returned is about the question. */
  libraryMiss?: boolean
  /** v1.10: passages recalled from the project's other chats for this reply (source = chat title). */
  projectContext?: MemoryContextItem[]
  /** v1.5: the turn ran while the app was offline (no web tools could work). */
  offline?: boolean
  /** v1.5: name of the playbook (method) the app injected for this reply. */
  playbook?: string
  /** v1.9: the conversation ledger disclosure line, when the ledger rode this turn. */
  ledger?: string
  /**
   * v1.1 grounding: a factual-looking question was answered without any web
   * source being consulted (auto-search disabled/failed and the model never
   * called one itself) — the confabulation signature. Display-only warning;
   * never replayed to a model.
   */
  unverified?: boolean
  /**
   * v1.4.6: the reply stopped because it hit the slot's max_tokens, so it ends
   * mid-thought. Read from `finish_reason`, which nothing parsed before — a
   * truncated reply was indistinguishable from a finished one, which is what
   * made a length cap unsafe to recommend. Display-only.
   */
  truncated?: boolean
  /**
   * v1.4.6: this reply was revised because the grounding check found specifics
   * the turn's tools did not support. `before` is what that first pass found,
   * kept so the UI can say the answer was corrected rather than silently
   * replacing it. Display-only.
   *
   * `after` is the re-check on the revision — kept because `before` alone
   * cannot tell the reader whether anything was actually fixed. A revision is
   * adopted whenever it *reduces* the findings, so findings routinely survive
   * into the answer on screen, and a line written from `before` alone claims a
   * resolution nobody verified. Optional only for messages persisted before
   * this existed; those fall back to `grounding`, which is the same report.
   */
  corrected?: { before: GroundingReport; after?: GroundingReport | null; at: number }
  /**
   * v1.3 tool grounding: figures or links in this reply that the turn's own
   * tool output does not support — the model overriding or inventing past what
   * was actually retrieved. Mechanical, no model call. Display-only; never
   * replayed to a model.
   */
  grounding?: GroundingReport
  /**
   * v1.4 routing: how the pre-flight router chose this reply's model slot
   * (e.g. "routed to Coder — fenced code detected"). Display-only — never
   * replayed to a model. Absent when the message went to the default slot.
   */
  routingNote?: string
  /**
   * v1.4 escalation (Layer 2d): the turn ended weak — unverified, a claim
   * contradicted, or the tool loop hit its cap — and a bigger slot is
   * available to re-run it on. Display-only — never replayed to a model.
   */
  escalation?: EscalationOffer
  /**
   * v1.2 claim check: the mechanical per-claim verification of this reply
   * (confirmed / contradicted / unverifiable, each with its source).
   * Display-only — never replayed to a model.
   */
  claimCheck?: ClaimCheckRecord
  /**
   * An in-chat divider rather than a model-visible message (v0.9: context
   * rollback, plan-mode notices). Filtered out of the wire history.
   */
  marker?: 'rollback' | 'notice'
  /** A multi-step plan executed on this message (v0.9 Plan mode). */
  plan?: ChatPlan
  /** v1.4 branching: the message this one was branched from, if any. */
  parentMessageId?: string
  /** v1.4 branching: set on the message a branch was taken from. */
  branchInfo?: { branchId: string; isBranch: boolean }
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
  /**
   * v1.10: estimated tokens the project contributed to this turn's prompt —
   * standing instructions, recalled sibling-chat passages, pinned-file
   * passages. Estimates (the same estimator the budget uses), so the details
   * panel can say how much of the window the project is spending.
   */
  projectTokens?: { instructions: number; recall: number; files: number }
  /**
   * Time to the first content or reasoning delta, measured from when the model
   * was asked — which is after `gatherMs`, not from the send.
   */
  ttftMs: number
  /**
   * First request to the last token — the stream, and only the stream. Stamped
   * on every streaming round, so it stops at the one that ended the answer.
   */
  totalMs: number
  /**
   * v1.12.6: the turn opening to the first request — everything the app did
   * before the model was asked anything. On a factual turn that is dominated by
   * the app's own web_search, which runs as a serial context provider
   * (lib/contextProviders): 8786 ms and 8891 ms in the two recorded TTU1 runs.
   * Measured as the distance between the turn's two origins, never estimated.
   * Absent on turns recorded before v1.12.6.
   */
  gatherMs?: number
  /**
   * v1.12.5: the turn opening to the composer being released — the wait the
   * reader actually sat through, gather and post-answer verification tail
   * included. v1.12.6 moved this origin back ahead of the gather, so the three
   * measured spans tile the whole turn: `gatherMs + totalMs + tail = turnMs`,
   * every one of them measured (lib/turnCost.ts). Absent on turns recorded
   * before v1.12.5, and on turns that ended before the tail ran.
   */
  turnMs?: number
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
  /**
   * v0.9: an ephemeral conversation lives only in RAM — never written to
   * `conversations/<id>.json`, gone on quit. The main process refuses to
   * persist it (structural, not just renderer habit).
   */
  ephemeral?: boolean
  /**
   * v0.9: which long-term memory sources this conversation may recall from.
   * `null`/absent = all sources (the pre-0.9 behavior); `[]` = none.
   */
  memorySources?: string[] | null
  /**
   * v1.4 branching: alternative paths explored from a given message. Each entry
   * points at the conversation holding that alternative — branches are separate
   * conversations, so nothing about persistence or ephemerality changes.
   */
  branches?: ConversationBranch[]
  /** The branch this conversation *is*, when it was created by branching. */
  activeBranchId?: string | null
  /** v1.10: the project this conversation is filed under; absent/null = unfiled. */
  projectId?: string | null
  createdAt: number
  updatedAt: number
}

export interface ConversationBranch {
  /** The message the branch was taken from. */
  messageId: string
  /** Conversation id holding the alternative path. */
  branchId: string
  title: string
}

export interface ConversationSummary {
  text: string
  /** The last message folded into this summary — everything up to and including it. */
  throughMessageId: string
  updatedAt: number
}

// ---- Tool execution (renderer ↔ main) ----------------------------------------

/** OpenAI-compatible function/tool schema, as sent to the chat completions API. */
export type { ToolSchema } from '../../shared/tools'

export interface ToolResult {
  ok: boolean
  /** Tool output fed back to the model when ok is true. */
  output?: string
  error?: string
  /** Images to render in the chat, when the tool produced any (image_search). */
  images?: ToolImage[]
}
