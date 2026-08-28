import type { ChatMessage } from '../types'
import { answerSettled, type TurnPhase } from './turnPhase'
import { approxTokens, explainEmptyReply, type Failure } from '../../../shared/failure'
import type { ContextUsage } from './contextBudget'

/**
 * What a finished assistant bubble offers the user (MessageBubble.tsx).
 *
 * Kept free of React so the decision is testable in plain Node
 * (test/llmTimeouts.test.ts). Two v1.12.1 gaps meet here, and they pull in
 * opposite directions:
 *
 *   - The whole action row was gated on `message.content`, so the one reply
 *     that most needs ↻ Regenerate — the empty one, produced by a stream that
 *     failed — was the only reply that never got it.
 *   - The row was also gated on the turn being over, and `streaming` stays
 *     true through the verification tail, so a complete answer sat on screen
 *     uncopyable for seconds.
 *
 * So the row has two independent reasons to open: there is text the reader may
 * act on, or the turn ended with nothing and has to end somewhere the reader
 * can act. Both rest on `answerSettled` (lib/turnPhase.ts), which is also what
 * `actionsReady` rests on — one rule about when an answer is final, asked here
 * about a reply that may have no text at all.
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
  isStreaming: boolean,
  phaseHere: TurnPhase | null = null
): ReplyAffordances {
  const empty =
    !message.content.trim() &&
    (message.toolCalls?.length ?? 0) === 0 &&
    !message.plan &&
    !message.reasoning?.trim()
  // The answer text is final once the turn is over, and also while it is only
  // being verified: a revision may replace the text, but it never un-finishes it.
  const settled = answerSettled(isStreaming, phaseHere)
  const onText = settled && message.content.trim() !== ''
  // The row shows for an empty last reply too, carrying Regenerate and the
  // branch menu alone: a failed turn has to end somewhere the user can act.
  return { empty, actions: settled && (onText || isLast), onText }
}

/**
 * What an empty bubble says, and to whom it says it.
 *
 * v1.17.3. This line was a constant for five versions:
 *
 *     ⚠️ Empty reply — nothing came back from the model. Use ↻ Regenerate to ask again.
 *
 * and a round-9 critic caught it standing over a transport stall: *"the
 * post-stop message then blames the model for what the fixture record shows was
 * a transport stall"*. It was also the sentence on a server that hung up
 * without writing, and on a model that genuinely said nothing — three events,
 * one subject, and the subject was wrong in two of them.
 *
 * The reading is made in shared/failure.ts, from what the transport recorded
 * (`ChatMessage.ending`). This function is only the fallback: a message stored
 * before v1.17.3, or one whose turn crashed before the transport ran, has no
 * observation, and inventing one to get a nicer sentence is the guess the
 * failure boundary's rule 3 exists to forbid.
 */
export function emptyReplyFailure(message: Pick<ChatMessage, 'ending'>): Failure {
  if (message.ending) return explainEmptyReply(message.ending)
  return {
    headline: 'ended with nothing, and the app did not record why',
    sentence:
      'This turn ended without producing anything, and the app has no record of how it ended — ' +
      'so it cannot say whether the model, the server or you stopped it.',
    remedy: { text: 'Ask again.' },
    detail: null,
    recognised: false
  }
}

/**
 * Why ↻ Regenerate cannot work here — or null, when it can.
 *
 * Round 9, on the context-overflow screen: *"the one control that is offered
 * would replay the same oversized conversation into the same 8192-token
 * window."* A retry that cannot succeed is worse than no retry: it costs a
 * wait, produces the same failure, and teaches the reader that the button is
 * broken rather than that the request is.
 *
 * Three options were on the table — remove it, disable it, or replace it with
 * something that changes the input. Removing it is wrong because the reader
 * then has no way to tell a missing control from a forgotten one, and because
 * the button becomes correct again the moment they shrink something. Disabling
 * it with the reason, beside the control that changes the input, is the one
 * that stays true as the settings change: this is re-evaluated on every render
 * from live settings, so turning a tool off re-enables the button by itself.
 *
 * Note the symmetry with round 8's rule for offering a control: a control is
 * RENDERED where the app has proved the remedy is right, and a control is
 * DISABLED where the app has proved the action is futile. Both need the proof;
 * neither guesses. Two things therefore do NOT block it:
 *
 * - No measurement (`usage` null — LM Studio never reported a window size).
 *   "We cannot measure it" is not evidence that it would fail.
 * - A conversation merely bigger than the window. The turn compacts before it
 *   sends, so that request fits; blocking on it would be the same false
 *   accusation this round is about, one control further along. `overflows`
 *   asks the hard question instead — see lib/contextBudget.ts.
 */
export function regenerateBlocked(usage: ContextUsage | null): string | null {
  if (!usage || !usage.overflows) return null
  return (
    `Asking again would send the same request, and it cannot fit: by the app’s own count it ` +
    `costs about ${approxTokens(usage.planned)} tokens against a ${approxTokens(usage.total)} ` +
    `window even after the older messages are summarized away. The largest part is ` +
    `${usage.largest.label}, at about ${approxTokens(usage.largest.tokens)}. Shrink it, or load ` +
    `the model with a larger context in LM Studio.`
  )
}
