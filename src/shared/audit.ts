/**
 * The session audit's vocabulary — the kinds of thing a line can be, and the
 * shape of a line — in one module because it is read from three.
 *
 * Through v2.4 this shape was declared twice: once in `main/ipc/audit.ts`,
 * which writes it, and once in `renderer/src/types.ts`, which types the
 * preload call that sends it. The two were kept in step by hand. `evals.md`
 * already names that arrangement as a defect where it happens to
 * `GroundingReport`: *"Two declarations of one shape is the drift this codebase
 * keeps extracting helpers to prevent."* This round had to add fields to it, so
 * it is the round that stops having two.
 *
 * The kind list is a `const` tuple and the type is read off it, so the runtime
 * guard in `recordAuditEntry` and the compile-time type cannot disagree. That
 * guard used to be a second, hand-written copy of the same four names — an
 * enumeration narrower than the class it guards is this project's most
 * frequently rediscovered defect, and here it would have silently dropped every
 * new entry kind on the floor while typechecking clean.
 */

/**
 * Every kind of line the log can hold, in the order a session produces them.
 *
 * The first four are v0.9's: what was said, and nothing in between. The last
 * four are v2.5's, and they are there for the same reason the first four are.
 * The audit's contract is a transcript of what was actually said, so that a
 * user can verify a session — and a plan turn violated it. A plan's steps each
 * run their own sub-turn and each produce text the user reads in the block, and
 * *none of it* reached the log. A three-step plan that called no tools left a
 * record of `session_start`, `user_input`, `assistant_output`: three lines, in
 * which nothing whatsoever happened between the question and the answer.
 *
 * What is recorded is exactly what the block puts on screen — the checklist as
 * it was offered for approval, each step beginning, each step's status and
 * result, and how the plan ended. Not the step's constructed prompt, not the
 * prior-step results spliced into it: those are layers in between, and the log
 * has never carried those.
 */
export const AUDIT_ENTRY_KINDS = [
  'session_start',
  'user_input',
  'assistant_output',
  'tool_call',
  /** The checklist as the reader was shown it, before anything ran. */
  'plan_start',
  /** One step beginning. The tool calls it makes follow, until its end. */
  'plan_step_start',
  /** One step reaching a terminal status, with the result the block shows. */
  'plan_step_end',
  /** The plan reaching its outcome. Steps that never ran have no lines at all. */
  'plan_end'
] as const

export type AuditEntryKind = (typeof AUDIT_ENTRY_KINDS)[number]

/** Kinds the renderer may write. `session_start` is the log's own, written by main. */
export type RecordableAuditKind = Exclude<AuditEntryKind, 'session_start'>

/**
 * The plan lines, taken off the naming convention rather than listed again — a
 * `plan_*` kind added above joins this set without anyone remembering to.
 */
export type PlanAuditKind = Extract<AuditEntryKind, `plan_${string}`>

export function isAuditEntryKind(kind: unknown): kind is AuditEntryKind {
  return typeof kind === 'string' && (AUDIT_ENTRY_KINDS as readonly string[]).includes(kind)
}

/**
 * The plan fields, named apart from the entry so the reconstruction below and
 * the writer in `hooks/planMode.ts` are talking about the same four things.
 *
 * Every one is optional and every one is omitted — not written as `undefined` —
 * on an entry that is not about a plan. That is load-bearing for backward
 * compatibility: the hash chain covers `JSON.stringify(entry)`, so a
 * `user_input` written by this build has to serialize byte-identically to one
 * written by the last, or every existing log stops verifying. See
 * `main/ipc/audit.ts` for where that is enforced.
 */
export interface AuditPlanFields {
  /** 1-based, on the two step kinds. */
  planStepIndex?: number
  /** How many steps the plan had, on every plan kind — the header's denominator. */
  planStepCount?: number
  /** The terminal status the block shows for this step, on `plan_step_end`. */
  planStepStatus?: string
  /** How the plan ended, on `plan_end`. */
  planOutcome?: string
}

export interface AuditEntryInput extends AuditPlanFields {
  conversationId: string
  kind: AuditEntryKind
  roleName?: string
  modelId?: string
  toolName?: string
  ok?: boolean
  text: string
  /** Renderer-side flag; entries for ephemeral conversations are refused. */
  ephemeral?: boolean
}

/** One decrypted line of the log, and one line of a decrypted export. */
export interface AuditEntry extends AuditPlanFields {
  at: string
  kind: AuditEntryKind
  conversationId: string
  roleName?: string
  modelId?: string
  toolName?: string
  ok?: boolean
  text: string
  prevHash: string
}
