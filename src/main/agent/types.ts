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
  /** v4.0 (A6): ask_user posed a question; the task pauses and the answer is the next turn. */
  | { type: 'question'; question: string; choices: string[] }
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
  /**
   * Ask before a command runs. `warning` is set for a destructive shape;
   * `network` (v4.1) for one that obviously reaches the network outside the
   * audited transport — the host says so, and the app logs that it ran.
   */
  approveCommand: (req: { command: string; cwd: string; warning: string | null; network?: string | null }) => Promise<CommandApproval>
  extraTools?: ExtraTools
  emit: (event: AgentEvent) => void
  /** The platform's shell for run_command; resolved once by the host. */
  shell?: ShellSpec
  /** v4.0 (C1): the host's PDF extractor, for read_document; the CLI has none. */
  readPdf?: (bytes: Buffer) => Promise<string>
  /** v4.0 (C2): send a file to the system trash; without it, delete_file moves the file to .sigma/trash/. */
  trash?: (absolutePath: string) => Promise<void>
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
  /**
   * v4.2 (A3): one round's output limit, thinking included, when the slot's
   * sampling sets none (Settings → Agent; engine.ts DEFAULT_ROUND_MAX_TOKENS).
   */
  roundMaxTokens?: number
  /** Command time limit, seconds. */
  commandTimeoutSec?: number
  signal: AbortSignal
  /** Messages typed while the task runs, drained at each round boundary. */
  takeSteers?: () => { id: string; text: string }[]
  /** The slot's standing rules (v2.7), which ride every turn. */
  rules?: string
  now?: Date
  /** v4.0: the experiments switched on under Settings → Agent; absent means none. */
  experiments?: Partial<AgentExperiments>
  /** v4.0 (A9): the worktree an earlier turn of this task used, to carry on in. */
  worktree?: { path: string; branch: string }
  /** v4.0 (C3): the recipe the host matched to this task — its method rides the prompt after the project's instructions. */
  recipe?: { name: string; text: string }
}

/** v4.0: the agent's experiments (mirrors renderer/src/types.ts AgentExperiments); each off until measured. */
export interface AgentExperiments {
  lowWaterMark: boolean
  multiRead: boolean
  digests: boolean
  thinkByPhase: boolean
  planFocus: boolean
  verifyRound: boolean
  askUser: boolean
  reviewer: boolean
  hooks: boolean
  worktrees: boolean
  notes: boolean
  /** C1: read_document and write_document — .docx, .xlsx, .pptx, .pdf, .csv, .md, .txt. */
  documents: boolean
  /** C2: move_file, copy_file, make_directory, delete_file — folder chores, checkpointed, to the trash never gone. */
  chores: boolean
  /** C3: recipes — a skill's agent.md, and the four the app ships, as the method for a task. */
  recipes: boolean
  /** C4: browse(url, instruction) — the headless renderer for pages that are applications; read-only. */
  browse: boolean
  /** C5: a read-only agent task as a job kind. */
  agentJobs: boolean
  /** C6: files dropped on an agent chat land in .sigma/inbox/. */
  inbox: boolean
  /** C7: slash commands from .sigma/commands/*.md, in the composer and the CLI. */
  commands: boolean
  /** C8: MCP servers that are on join the agent's tools under their own approval. */
  mcpTools: boolean
  /** v4.1 (A5): tools offered by phase — edit tools after a read; documents, chores and MCP tools when the task points at them. */
  toolsByPhase: boolean
  /** v4.2 (A4): a structured plan round first; steps closed only with evidence; one replan after a failed check or a stuck note. */
  planRound: boolean
}

export const EXPERIMENT_KEYS: readonly (keyof AgentExperiments)[] = [
  'lowWaterMark',
  'multiRead',
  'digests',
  'thinkByPhase',
  'planFocus',
  'verifyRound',
  'askUser',
  'reviewer',
  'hooks',
  'worktrees',
  'notes',
  'documents',
  'chores',
  'recipes',
  'browse',
  'agentJobs',
  'inbox',
  'commands',
  'mcpTools',
  'toolsByPhase',
  'planRound'
]

/**
 * v4.2 (A3): the round output caps Settings → Agent offers. 16K is 4.0's
 * measured ceiling; the roadmap asks whether 8K or 4K costs any solved task
 * (a call cut at the cap is repaired since 4.0.2, so a smaller cap trades a
 * repair round for a shorter runaway).
 */
export const ROUND_MAX_TOKENS_OPTIONS: readonly number[] = [16_384, 8_192, 4_096]

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
  /** v4.0: the folder the task actually worked in — the worktree (A9) when one was made, else the workspace. */
  workspace: string | null
  /** v4.0 (A9): the worktree and branch this task worked on, for the next turn and the user. */
  worktree?: { path: string; branch: string }
  detail?: string
}

/** A file as it was before the task first changed it (content null: did not exist). */
export interface Checkpoint {
  path: string
  before: string | null
  /** What the task last wrote, so Undo can tell a later hand-edit apart. */
  after: string | null
  /** v4.0: set when `before` and `after` hold the file's bytes as base64 — a document or a moved file, not text. */
  encoding?: 'base64'
}
