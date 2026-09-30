/**
 * Plan, then one step at a time (v4.0, A4 — an experiment, off by default).
 *
 * The checklist a task writes with todo_write is the plan. Two things follow
 * from it while the experiment is on:
 *
 *   - the plan stays in view: each round after the first ends with a short
 *     transient message naming the steps and the one in progress, so a small
 *     model twenty rounds in still knows where it is (scaffolding for one
 *     request, never history — the same rule as the closed-think prefill);
 *   - a finished step's output is set aside: when an item is marked completed,
 *     the tool results that came before that call are replaced by the same
 *     note context fitting uses, before the budget forces it, so the next
 *     step starts with the plan and the files, not the last step's noise.
 *
 * Pure: these read the checklist and the wire history.
 */
import type { ApiMessage } from '../../renderer/src/lib/agentLoop'
import type { TodoItem } from './types'
import { setAsideBefore } from './context'

export const PLAN_VIEW_PREFIX = 'Plan in view (not a new instruction):'

const mark = (t: TodoItem): string => (t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▶' : '☐')
/** The checklist as lines: ☑ done, ▶ in progress, ☐ to do. */
export const checklist = (todos: readonly TodoItem[]): string => todos.map((t) => `${mark(t)} ${t.content}`).join('\n')

/**
 * The transient plan message for a round, or null when there is no plan or
 * nothing is in progress. v4.2 (planRound): `evidence` adds the rule the
 * engine enforces, so the model hears it before a completion is refused.
 */
export function planInView(todos: readonly TodoItem[], evidence = false): string | null {
  if (todos.length === 0) return null
  const current = todos.find((t) => t.status === 'in_progress')
  if (!current) return null
  const rule = evidence ? ' Mark it completed only once a tool result shows it done — a passing check, or a read of the change.' : ''
  return `${PLAN_VIEW_PREFIX}\n${checklist(todos)}\nYou are on: ${current.content}. Finish it, mark it completed, then start the next.${rule}`
}

/*
 * v4.2 (A4, the `planRound` experiment): the plan as a round of its own.
 *
 * 4.0's A4 was a reminder; this is the roadmap's version. Before the first
 * call, one structured-output request asks for the steps (grammar-constrained
 * where the server allows, parsed tolerantly where it does not, as the chat's
 * plan mode does). Three steps or more become the checklist; fewer mean the
 * task is small and runs as before. Then: a step is closed only with evidence,
 * and after a failed check (or a stuck note) the plan is revised, once.
 * Everything here is pure; the requests are the engine's.
 */

/** Below this many steps a plan is not worth holding the model to. */
export const PLAN_MIN_STEPS = 3
export const PLAN_MAX_STEPS = 8
/** A plan is a short JSON list; a model that needs more than this for it is thinking, not planning. */
export const PLAN_ROUND_MAX_TOKENS = 4_096

/** The response_format grammar. Strings, not objects: the smallest shape a 9B fills reliably. */
export const PLAN_SCHEMA = {
  name: 'task_plan',
  schema: {
    type: 'object',
    properties: { steps: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: PLAN_MAX_STEPS } },
    required: ['steps'],
    additionalProperties: false
  }
} as const

export const PLAN_ROUND_ASK =
  'Before you call any tool, plan this task. Reply with JSON only, in this shape: {"steps": ["…", "…"]} — ' +
  'the steps in order, each one action in a few words whose result a tool can show (a file read, an edit, a command that passes). ' +
  `A task of one or two actions gets one or two steps; do not pad it. At most ${PLAN_MAX_STEPS}.`

/** The replan request: the plan so far, and why it is being revised. */
export function replanAsk(todos: readonly TodoItem[], reason: string): string {
  return (
    `${reason}. Revise the plan before going on. The plan so far:\n${checklist(todos)}\n` +
    'Reply with JSON only, in this shape: {"steps": ["…"]} — the steps still to do, in order, starting from what the last results show. ' +
    `Do not repeat steps already done (☑). At most ${PLAN_MAX_STEPS}.`
  )
}

/** The first balanced JSON object or array in a reply, parsed; null when there is none. */
function firstJson(text: string): unknown {
  const t = text.trim()
  try {
    return JSON.parse(t)
  } catch {
    // Prose around it, a fence, a trailing sentence: scan.
  }
  for (let i = 0; i < t.length; i++) {
    const open = t[i]
    if (open !== '{' && open !== '[') continue
    const close = open === '{' ? '}' : ']'
    let depth = 0
    let inString = false
    for (let j = i; j < t.length; j++) {
      const ch = t[j]
      if (inString) {
        if (ch === '\\') j++
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === open) depth++
      else if (ch === close && --depth === 0) {
        try {
          return JSON.parse(t.slice(i, j + 1))
        } catch {
          break
        }
      }
    }
  }
  return null
}

/**
 * The steps of a plan reply, read tolerantly: `{"steps": [...]}` (strings, or
 * objects with a title/step/content), a bare array, or — when the server
 * ignored the grammar and the model wrote a list — its numbered or bulleted
 * lines. Trimmed, deduplicated, capped. Empty when nothing reads as a plan.
 */
export function parsePlanSteps(text: string): string[] {
  const json = firstJson(text)
  const raw: unknown[] = Array.isArray(json)
    ? json
    : json && typeof json === 'object' && Array.isArray((json as { steps?: unknown }).steps)
      ? (json as { steps: unknown[] }).steps
      : text
          .split('\n')
          .map((l) => /^\s*(?:\d+[.)]|[-*•])\s+(.+)$/.exec(l)?.[1])
          .filter((l): l is string => Boolean(l))
  const steps: string[] = []
  for (const s of raw) {
    const o = s as Record<string, unknown> | null
    const value = typeof s === 'string' ? s : o && typeof o === 'object' ? (o.title ?? o.step ?? o.content ?? o.description) : null
    const step = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
    if (step && !steps.some((x) => x.toLowerCase() === step.toLowerCase())) steps.push(step)
  }
  return steps.slice(0, PLAN_MAX_STEPS)
}

/** A plan's steps as the checklist: the first in progress. */
export function planTodos(steps: readonly string[]): TodoItem[] {
  return steps.map((content, i) => ({ content, status: i === 0 ? 'in_progress' : 'pending' }))
}

/** The checklist after a replan: what is done stays done, the new steps follow. Null when the reply adds nothing. */
export function revisedTodos(todos: readonly TodoItem[], steps: readonly string[]): TodoItem[] | null {
  const done = todos.filter((t) => t.status === 'completed')
  const next = steps.filter((s) => !done.some((d) => d.content.toLowerCase() === s.toLowerCase()))
  return next.length > 0 ? [...done, ...planTodos(next)] : null
}

/** One call made while a step was in progress. */
export interface StepEvent {
  name: string
  ok: boolean
}

/**
 * Does anything since the step began show it done? After a change, only a
 * passing command or a read that followed it does — the edit's own "Edited"
 * line is the claim, not the check. A step that changed nothing needs any
 * successful call (a read, a search, a helper's report).
 */
export function stepEvidence(log: readonly StepEvent[], changeTools: ReadonlySet<string>, readTools: ReadonlySet<string>): boolean {
  let lastChange = -1
  log.forEach((e, i) => {
    if (e.ok && changeTools.has(e.name)) lastChange = i
  })
  if (lastChange < 0) return log.some((e) => e.ok)
  return log.slice(lastChange + 1).some((e) => e.ok && (e.name === 'run_command' || readTools.has(e.name)))
}

/**
 * A completion the log does not back is taken back: the first newly completed
 * step returns to in progress, anything after it to pending. Refused once per
 * step — a small model told twice is not being checked, it is being looped,
 * and the stuck detector would then stop the task on its own checklist.
 * Returns the step withheld, or null when the list stands as written.
 */
export function withholdCompletion(before: readonly TodoItem[], after: readonly TodoItem[], evidence: boolean, refused: ReadonlySet<string>): { todos: TodoItem[]; withheld: string } | null {
  const wasDone = new Set(before.filter((t) => t.status === 'completed').map((t) => t.content))
  const index = after.findIndex((t) => t.status === 'completed' && !wasDone.has(t.content))
  if (index < 0 || evidence || refused.has(after[index]!.content)) return null
  const todos = after.map((t, i): TodoItem =>
    i === index ? { ...t, status: 'in_progress' } : i > index && t.status !== 'pending' && !wasDone.has(t.content) ? { ...t, status: 'pending' } : t
  )
  return { todos, withheld: after[index]!.content }
}

export function withheldNote(step: string): string {
  return (
    `\n\nNot marked completed: "${step}" — no tool result since it began shows it done. ` +
    'After an edit, run the check or read the changed lines; otherwise do the step with a tool. Then mark it completed.'
  )
}

/** Did the checklist just gain a completed item? */
export function stepCompleted(before: readonly TodoItem[], after: readonly TodoItem[]): boolean {
  const done = (list: readonly TodoItem[]): number => list.filter((t) => t.status === 'completed').length
  return done(after) > done(before)
}

/**
 * Set aside every tool result before the round that completed a step — the
 * round is the last assistant message in the history. Returns how many.
 */
export function setAsideFinishedStep(messages: ApiMessage[]): number {
  let last = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') {
      last = i
      break
    }
  }
  return last <= 0 ? 0 : setAsideBefore(messages, last)
}
