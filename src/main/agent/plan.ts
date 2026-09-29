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

/** The transient plan message for a round, or null when there is no plan or nothing is in progress. */
export function planInView(todos: readonly TodoItem[]): string | null {
  if (todos.length === 0) return null
  const current = todos.find((t) => t.status === 'in_progress')
  if (!current) return null
  const mark = (t: TodoItem): string => (t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▶' : '☐')
  const lines = todos.map((t) => `${mark(t)} ${t.content}`)
  return `${PLAN_VIEW_PREFIX}\n${lines.join('\n')}\nYou are on: ${current.content}. Finish it, mark it completed, then start the next.`
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
