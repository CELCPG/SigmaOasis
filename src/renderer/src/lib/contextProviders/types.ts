import type { MemoryOrigin } from '../../../../shared/memoryOrigin'
import type {
  AppSettings,
  AttachmentFileRef,
  AttachmentPassagesResult,
  AttachmentRef,
  ChatMessage,
  Conversation,
  LibraryLookupResult,
  MemorySearchResult,
  ModelConfig,
  Project,
  ProjectRecallOutcome,
  ToolResult,
  ToolSchema
} from '../../types'
import type { TurnWait } from '../turnPhase'

/**
 * Turn-context providers (STRATEGY-harness-adoptions, Tier 1.1).
 *
 * Each pre-flight context source — the app-run web search, library passages,
 * playbook, ledger, price check, memory/project/attachment recall, tabular
 * profile — is one provider in a fixed-order registry instead of an inline
 * block in runTurn. The contract:
 *
 * - `enabled()` is the cheap gate; a false skips the provider entirely.
 * - `gather()` does the work and returns blocks for the turn notes. A throw
 *   or rejection degrades to absence — a failing provider never breaks the
 *   turn (the runner catches; providers still catch internally where the old
 *   inline blocks did, to keep partial results).
 * - Everything a provider may touch arrives through TurnInput (read-only turn
 *   facts) and ProviderIO (injected effects). No store, no window — providers
 *   are node-testable with a stubbed IO.
 * - Block placement is ALWAYS registry order, whatever the phase: the final
 *   turn-notes order is pinned by test, because it is prompt surface.
 */

/** Read-only facts of the turn, computed once in runTurn and shared. */
export interface TurnInput {
  convo: Conversation
  /** Every conversation in the store — sibling lookup for project recall. */
  conversations: Conversation[]
  slot: ModelConfig
  /**
   * The slot's per-role allowlist intersected with the globally-enabled list —
   * the security set every provider gates on, never the global list and never
   * the embedder's per-turn subset.
   */
  slotTools: ToolSchema[]
  lastUserContent: string | undefined
  /** The user message before the last — anchors context-dependent follow-ups. */
  previousUserContent: string | undefined
  offline: boolean
  factualTurn: boolean
  referenceTurn: boolean
  shoppingTurn: boolean
  project: Project | null
  /** The in-flight assistant message; the ledger must exclude it. */
  assistantMsgId: string
  signal: AbortSignal
}

/** The context handed to tools:execute for app-initiated calls. */
export interface ToolExecuteContext {
  modelId?: string
  attachments?: AttachmentFileRef[]
  conversationId?: string
  /**
   * v2.6: set by lib/taint.ts once a tool has returned content from outside
   * the machine this turn; carried to main on every later call. One object
   * per turn, shared by the providers and the agent loop, so the flag is
   * seen by both.
   */
  tainted?: boolean
}

/**
 * The window.api subset providers may reach, stated structurally (this module
 * compiles for node:test too, where the preload's Window typing is absent).
 * Signatures mirror src/preload/index.ts; makeProviderIO binds the real ones,
 * so a drift fails to compile there.
 */
export interface ProviderApi {
  memorySearch(
    query: string,
    topK?: number,
    minScore?: number,
    sources?: string[] | null,
    origins?: readonly MemoryOrigin[] | null
  ): Promise<{ ok: boolean; results: MemorySearchResult[]; error?: string }>
  libraryLookup(query: string, packId?: string | null, topK?: number): Promise<LibraryLookupResult>
  attachmentPassages(
    refs: AttachmentRef[],
    query: string,
    topK: number
  ): Promise<AttachmentPassagesResult>
  projectRecall(
    conversationIds: string[],
    query: string,
    topK: number
  ): Promise<ProjectRecallOutcome>
}

/** Injected effects — every side channel the old inline blocks used, and nothing else. */
export interface ProviderIO {
  /**
   * Run an app-initiated tool with the same bookkeeping every tool call gets:
   * a ToolCallRecord pushed to the turn's shared list and patched onto the
   * reply, execution via tools:execute with the turn's tool context, status
   * and result recorded, and an audit entry. Never throws — failures come
   * back as `{ok:false}`. Refuses names outside the slot allowlist, making
   * the per-slot boundary structural instead of a per-provider convention.
   */
  runTool(name: string, args: Record<string, unknown>): Promise<ToolResult>
  /**
   * Record a call the app performed through a non-tool IPC path (the library
   * lookup): same record, patch and audit bookkeeping, no dispatch.
   */
  recordSyntheticCall(name: string, args: Record<string, unknown>, output: string): void
  api: ProviderApi
  /** Disclosure fields on the assistant message (memoryContext, playbook, ledger…). */
  patch(p: Partial<ChatMessage>): void
  /** Live settings read, matching the old per-block useAppStore.getState() reads. */
  settings(): AppSettings | null
}

export interface ProviderResult {
  /** Joined into the turn notes in registry order. */
  blocks?: string[]
  /** Token accounting the details panel shows (project recall / pinned files). */
  projectTokens?: { recall?: number; files?: number }
}

export interface ContextProvider {
  id: string
  /**
   * 'prefetch': gather() starts at turn open, so embedding-bound work overlaps
   * the serial providers' network waits (the deliberate v1.5 behavior).
   * 'serial': gather() is awaited strictly at the provider's registry
   * position, with an abort check after it.
   */
  phase: 'prefetch' | 'serial'
  /**
   * What to call this wait while it runs. Every serial provider that can hold
   * the turn open on network or disk declares one — the reader watches an
   * empty bubble for that whole window, and an unnamed wait is the only kind
   * that feels like a hang. Prefetch work overlaps the serial waits, so it
   * has nothing to name.
   */
  wait?: TurnWait
  enabled(input: TurnInput, io: ProviderIO): boolean
  gather(input: TurnInput, io: ProviderIO): Promise<ProviderResult | null>
}
