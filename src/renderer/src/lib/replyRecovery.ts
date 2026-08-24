import type { ChatMessage } from '../types'

/**
 * What a finished assistant bubble offers the user (MessageBubble.tsx).
 *
 * Kept free of React so the decision is testable in plain Node
 * (test/llmTimeouts.test.ts). Through v1.12.1 the whole action row was gated on
 * `message.content`, which meant the one reply that most needs ↻ Regenerate —
 * the empty one, produced by a stream that failed — was the only reply that
 * never got it.
 */
export interface ReplyAffordances {
  /** The turn produced nothing at all: no text, no tools, no plan, no thinking. */
  empty: boolean
  /** Render the action row. */
  actions: boolean
  /** Copy, Listen, 2nd opinion, Think harder — all of them need text to work on. */
  onText: boolean
}

export function replyAffordances(
  message: Pick<ChatMessage, 'content' | 'toolCalls' | 'plan' | 'reasoning'>,
  isLast: boolean,
  isStreaming: boolean
): ReplyAffordances {
  const empty =
    !message.content.trim() &&
    (message.toolCalls?.length ?? 0) === 0 &&
    !message.plan &&
    !message.reasoning?.trim()
  const onText = !isStreaming && message.content.trim() !== ''
  // The row shows for an empty last reply too, carrying Regenerate and the
  // branch menu alone: a failed turn has to end somewhere the user can act.
  return { empty, actions: !isStreaming && (onText || isLast), onText }
}
