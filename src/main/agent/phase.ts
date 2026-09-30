/**
 * Think when it matters (v4.0, A3 — an experiment, off by default).
 *
 * Qwen3-class models think before every tool call, and most of 3.0's thirteen
 * minutes was that. Some rounds need thought — the plan, a step after a check
 * failed, the report — and the rounds between mostly need a call. The lever is
 * the one 3.1's S3 measured for small talk: on a `<think>` family the round
 * begins with the thinking block already closed (shared/thinking.ts).
 *
 * v4.2: this file says only what the coming round is (`roundPhase`); whether
 * that phase thinks is the model family's prior (lib/modelProfiles.ts
 * `agentThinkingProfile`), not one fixed rule. 4.0's rule was "think first and
 * after a failure, never after a success"; the Qwen3 prior now also thinks
 * before the likely report.
 *
 * Pure: it reads the wire history.
 */
import type { ApiMessage } from '../../renderer/src/lib/agentLoop'
import type { AgentRoundPhase } from '../../renderer/src/lib/modelProfiles'
import { PLAN_VIEW_PREFIX } from './plan'
import { CHANGE_TOOLS, READ_TOOLS } from './tools'

export type { AgentRoundPhase }

function text(m: ApiMessage): string {
  return typeof m.content === 'string' ? m.content : ''
}

/** A result the model should stop and think about: an error, or a command that exited non-zero. */
export function failedResult(content: string): boolean {
  return content.startsWith('Error:') || /\(exit code [1-9]\d*/.test(content)
}

/**
 * The coming round's phase. The last round's results decide: any failure
 * among them is `failure` (a stuck note rides a failed result, so it is one
 * too); otherwise the last call's kind. A transient plan message is skipped —
 * it is scaffolding, not the user speaking (4.0 read it as the user, so with
 * planFocus on every round thought).
 */
export function roundPhase(iteration: number, messages: readonly ApiMessage[]): AgentRoundPhase {
  if (iteration === 0) return 'first'
  let end = messages.length
  while (end > 0 && messages[end - 1]!.role === 'user' && text(messages[end - 1]!).startsWith(PLAN_VIEW_PREFIX)) end--
  const last = messages[end - 1]
  if (!last || last.role !== 'tool') return 'user' // a steer, a note, or a reply without a call: think about it
  let start = end - 1
  while (start > 0 && messages[start - 1]!.role === 'tool') start--
  const results = messages.slice(start, end)
  if (results.some((m) => failedResult(text(m)))) return 'failure'
  const calls = messages[start - 1]?.tool_calls ?? []
  const call = calls.find((c) => c.id === last.tool_call_id) ?? calls.at(-1)
  const name = call?.function.name ?? ''
  if (READ_TOOLS.has(name)) return 'read'
  if (CHANGE_TOOLS.has(name)) return 'edit'
  if (name === 'run_command') {
    // A passing check after a change is usually the last thing before the report.
    const changed = messages.slice(0, start).some((m) => (m.tool_calls ?? []).some((c) => CHANGE_TOOLS.has(c.function.name)))
    return changed ? 'report' : 'other'
  }
  if (name === 'todo_write') {
    try {
      const todos = (JSON.parse(call!.function.arguments) as { todos?: { status?: string }[] }).todos ?? []
      if (todos.length > 0 && todos.every((t) => t.status === 'completed')) return 'report'
    } catch {
      // Unreadable arguments were answered with an error, and that is a failure above.
    }
  }
  return 'other'
}
