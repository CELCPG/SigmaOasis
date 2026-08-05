import { ipcMain } from 'electron'
import { chatComplete, resolveChatModel } from './llm'

/**
 * Rolling conversation compaction.
 *
 * When a conversation outgrows the model's context window, something has to
 * go. Through v0.8.1 the oldest messages were simply deleted from the wire
 * history, so the model lost the beginning of the conversation with no signal
 * to anyone — the user's first failed follow-up was the notification.
 *
 * Instead, the span about to be dropped is summarized here and carried
 * forward as a compact note prepended to the system prompt. Each compaction
 * folds the previous summary in with the newly dropped messages, so the note
 * stays one bounded block however long the conversation runs rather than
 * growing without limit.
 *
 * This runs in the main process for the same reason deep research does: it is
 * a non-streaming completion whose output the user never reads token by token,
 * and `chatComplete` already handles pinning, allowlisting and logging.
 */

const SYSTEM_PROMPT = `You compress conversation history so it can be carried forward in limited context.

Write a factual summary of the conversation so far. Preserve:
- what the user asked for and any constraints or preferences they stated
- decisions reached and conclusions drawn
- concrete facts established: names, paths, numbers, versions, identifiers
- anything left unresolved or promised

Rules:
- Write plain prose or terse bullets. No preamble, no "the user asked", no meta-commentary.
- Do not invent anything not present in the material. If something is ambiguous, leave it out.
- Be brief. This is a memory aid, not a transcript.`

/** Hard cap on the note, so compaction cannot itself become the context problem. */
const MAX_SUMMARY_TOKENS = 400
/** Cap on the material handed to the summarizer in one call. */
const MAX_INPUT_CHARS = 24_000

export interface SummarizeRequest {
  /** The summary carried from previous compactions, if any. */
  previousSummary?: string
  /** Messages about to be dropped, oldest first, already flattened to text. */
  droppedText: string
  /** Model to summarize with — the one the user is talking to. */
  modelId?: string
}

export async function summarizeConversation(
  request: SummarizeRequest
): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  const dropped = request.droppedText.trim()
  if (!dropped) return { ok: false, error: 'Nothing to summarize.' }

  const model = await resolveChatModel(request.modelId)
  if (!model) return { ok: false, error: 'No chat model available to summarize with.' }

  const previous = request.previousSummary?.trim()
  // Keep the tail: when the material is too big for one pass, the most recent
  // messages are the ones most likely to matter to the next turn.
  const material = dropped.length > MAX_INPUT_CHARS ? dropped.slice(-MAX_INPUT_CHARS) : dropped

  const user = previous
    ? `Summary of the conversation up to this point:\n${previous}\n\nNewer messages to fold in:\n${material}\n\nWrite a single combined summary covering both.`
    : `Conversation to summarize:\n${material}`

  try {
    const summary = await chatComplete({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user }
      ],
      temperature: 0.2,
      maxTokens: MAX_SUMMARY_TOKENS,
      // Compression is transcription, not reasoning. Thinking here spent the
      // 400-token cap before the summary started, which sent every compaction
      // down the local-digest fallback path.
      thinking: false
    })
    const trimmed = summary.trim()
    if (!trimmed) return { ok: false, error: 'The model returned an empty summary.' }
    return { ok: true, summary: trimmed }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerSummarizeHandlers(): void {
  ipcMain.handle('chat:summarize', async (_e, request: SummarizeRequest) =>
    summarizeConversation({
      previousSummary:
        typeof request?.previousSummary === 'string' ? request.previousSummary : undefined,
      droppedText: String(request?.droppedText ?? ''),
      modelId: typeof request?.modelId === 'string' ? request.modelId : undefined
    })
  )
}
