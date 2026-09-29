/**
 * Think when it matters (v4.0, A3 — an experiment, off by default).
 *
 * Qwen3-class models think before every tool call, and most of 3.0's thirteen
 * minutes was that. Two phases need thought — the plan, and a step after a
 * check failed — and the rounds between mostly need a call. The lever is the
 * one 3.1's S3 measured for small talk: on a `<think>` family the round begins
 * with the thinking block already closed (shared/thinking.ts). This decides,
 * per round, whether to close it:
 *
 *   - the first round thinks (the plan);
 *   - a round after a tool result that was an error thinks (the fix);
 *   - a round after a successful read, listing, search or edit does not.
 *
 * Pure: it reads the wire history and returns a boolean.
 */
import type { ApiMessage } from '../../renderer/src/lib/agentLoop'

/** Is this round one whose thinking block should start closed? */
export function skipThinking(iteration: number, messages: readonly ApiMessage[]): boolean {
  if (iteration === 0) return false
  // The last tool result decides: none means the model spoke without calling, so let it think.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'tool') {
      const text = typeof m.content === 'string' ? m.content : ''
      return !text.startsWith('Error:') && !/\(exit code [1-9]\d*/.test(text)
    }
    if (m.role === 'user') return false // a steer or a question: think about it
  }
  return false
}
