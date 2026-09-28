import type { ToolCallRecord, ToolResult, ToolSchema } from '../../renderer/src/types'
import type { PatchStats } from '../../shared/patch'

/**
 * The agent engine's vocabulary (v3.0).
 *
 * Everything under src/main/agent is plain Node — fs, child_process, fetch —
 * and never imports Electron, because two programs run it: the app, where a
 * task runs in the main process and survives the window switching chats, and
 * the `sigma` CLI, where it runs in a terminal. What differs between them is
 * the host: how a request reaches LM Studio, who is asked before a file
 * changes or a command runs, and where events go. test/agentEngine.test.ts
 * fails the build if a file here reaches for Electron.
 */

export type { ToolCallRecord, ToolResult, ToolSchema }

/**
 * How much the agent may do without asking, per task.
 * - `ask`: every edit is shown as a diff and every command in a dialog.
 * - `acceptEdits`: edits inside the workspace land without asking (the diff
 *   still rides the record, and a checkpoint is taken first); commands ask.
 * - `readOnly`: no tool that writes or runs is offered at all.
 */
export type PermissionMode = 'ask' | 'acceptEdits' | 'readOnly'

export const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'acceptEdits', 'readOnly']

/** A focused helper the agent can hand work to (the `task` tool). */
export type SubagentType = 'explore' | 'review' | 'general'

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type AgentStatus = 'running' | 'done' | 'stopped' | 'paused' | 'error'

/**
 * What a running task reports, in order. The app turns these into the
 * message on screen; the CLI prints them. Tool records use the chat's own
 * shape, so the app draws an agent's calls with the blocks it already has.
 */
export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_start'; record: ToolCallRecord }
  | { type: 'tool_end'; record: ToolCallRecord }
  | { type: 'todos'; todos: TodoItem[] }
  | { type: 'round'; round: number }
  | { type: 'usage'; promptTokens?: number; completionTokens: number }
  | { type: 'steer_delivered'; id: string; round: number }
  | { type: 'files_changed'; paths: string[] }
  | { type: 'context_elided'; toolResults: number; chars: number }
  | { type: 'status'; status: AgentStatus; detail?: string }

/** One streamed request's worth of bytes, however they travel. */
export interface ChunkTransportInit {
  body: string
  signal: AbortSignal
  onChunk: (chunk: Uint8Array) => void
  /** Silence between chunks that counts as a dead stream. */
  stallMs: number
}

/**
 * POST to `/chat/completions` and feed the response body to `onChunk`.
 * Resolves when the body ends. The app's is the audited transport (egress
 * allowlist, activity log); the CLI's is plain loopback fetch.
 */
export type ChunkTransport = (
  url: string,
  init: ChunkTransportInit
) => Promise<{ ok: boolean; status: number; errorText?: string }>

export interface EditReview {
  callId: string
  path: string
  isNew: boolean
  diff: string
  stats: PatchStats
}

export type CommandApproval = 'once' | 'granted' | 'declined'

/** Tools the host adds beyond the workspace's own (the app's web and library tools). */
export interface ExtraTools {
  schemas: ToolSchema[]
  execute: (name: string, args: Record<string, unknown>, callId: string) => Promise<ToolResult>
}

/** Everything outside the engine, supplied by the app or the CLI. */
export interface AgentHost {
  transport: ChunkTransport
  /** Show a proposed change and wait for Apply or Discard. */
  reviewEdit: (review: EditReview) => Promise<boolean>
  /** Ask before a command runs. `warning` is set for a destructive shape. */
  approveCommand: (req: { command: string; cwd: string; warning: string | null }) => Promise<CommandApproval>
  extraTools?: ExtraTools
  emit: (event: AgentEvent) => void
  /** The platform's shell for run_command; resolved once by the host. */
  shell?: ShellSpec
}

export interface ShellSpec {
  /** Executable to spawn. */
  file: string
  /** Arguments before the command string, e.g. ['-lc'] or ['/d', '/s', '/c']. */
  args: string[]
  /** What the prompt calls it, so the model writes the right syntax. */
  name: string
}

/** One task, as the host starts it. */
export interface AgentTaskSpec {
  baseUrl: string
  model: string
  /** The folder the task may read and change; null for a task with no files. */
  workspace: string | null
  permission: PermissionMode
  /** What the user asked for, this turn. */
  prompt: string
  /**
   * The wire history of this task's earlier turns in the same conversation,
   * when the host kept it; the engine appends this turn and returns it.
   */
  history?: import('../../renderer/src/lib/agentLoop').ApiMessage[]
  /** Sampling fields for the request body (temperature, top_p, …). */
  sampling?: Record<string, unknown>
  /** The loaded context window, in tokens, when the host knows it. */
  contextTokens?: number
  maxRounds?: number
  /** Command time limit, seconds. */
  commandTimeoutSec?: number
  signal: AbortSignal
  /** Messages typed while the task runs, drained at each round boundary. */
  takeSteers?: () => { id: string; text: string }[]
  /** The slot's standing rules (v2.7), which ride every turn. */
  rules?: string
  now?: Date
}

export interface AgentTaskResult {
  status: Exclude<AgentStatus, 'running'>
  /** The reply's final text — what the user reads as the answer. */
  finalText: string
  /** The wire history, for the next turn of the same conversation. */
  history: import('../../renderer/src/lib/agentLoop').ApiMessage[]
  todos: TodoItem[]
  /** Workspace-relative paths this task changed. */
  changedFiles: string[]
  /** Pre-task contents of every changed file, for Undo. */
  checkpoints: Checkpoint[]
  detail?: string
}

/** A file as it was before the task first changed it (content null: did not exist). */
export interface Checkpoint {
  path: string
  before: string | null
  /** What the task last wrote, so Undo can tell a later hand-edit apart. */
  after: string | null
}
