/**
 * The closed thinking block, and who it works on.
 *
 * Shared for the same reason `measurements.ts` is: two processes now depend on
 * this exact string doing this exact thing, and a second copy would drift.
 *
 * What it is for: some reasoning models open a `<think>` block and never close
 * it, and a server that splits reasoning from content then classifies the
 * *entire* reply — answer included — as reasoning. Handing the model an
 * already-closed block as the start of its turn is what actually stops that;
 * every documented parameter for the same job (`enable_thinking`,
 * `reasoning_effort`, `/no_think`) was measured inert on LM Studio.
 */

/** An assistant turn that begins with thinking already finished. */
export const CLOSED_THINK_PREFILL = '<think>\n\n</think>\n\n'

/**
 * Families whose chain-of-thought is delimited by `<think>` tags, so a closed
 * block is a valid thing to hand them. Gemma 4 is deliberately absent: it
 * marks thinking with its own control tokens, and feeding it another family's
 * delimiters is noise it has to ignore rather than a hint it can use.
 */
export const THINK_TAG_MODELS = /qwen[-_]?3|deepseek[-_]?r1|r1[-_]?distill|magistral/i

/**
 * v4.1 (S4): a role's thinking, set per slot (Settings → Roles).
 *
 * - `auto` (absent — the default): the answer thinks, except a greeting
 *   (lib/quickReply.ts); the app's own checks on the slot — claim extraction
 *   and judging, the critic, the recompute program — do not.
 * - `on`: everything this slot runs thinks, greetings and checks included —
 *   the pre-4.1 behaviour of the checks.
 * - `off`: every round starts with the closed block, answer included.
 *
 * Only the THINK_TAG_MODELS families are touched in any mode: the closed block
 * is the one lever measured to work, and only on them.
 */
export type ThinkingMode = 'auto' | 'on' | 'off'

/** A stored value read back, anything unknown as `auto`. */
export function thinkingMode(value: unknown): ThinkingMode {
  return value === 'on' || value === 'off' ? value : 'auto'
}

/**
 * v4.1 (S4): the messages of one of the app's own checks, with the model's
 * thinking closed where the slot allows it.
 *
 * Measured on the main process's utility calls since v1.9.2 (ipc/llm.ts
 * `applyThinking`): a check that thinks first spends 2–10 s per call on a
 * reasoning model, and a claim check makes one extraction and up to five
 * judgments. The renderer's checks never had it. A verdict is read off the
 * reply's text; the thinking before it was never shown and never read.
 */
export function withUtilityThinking<M extends { role: string }>(
  messages: M[],
  modelId: string,
  mode: ThinkingMode | undefined
): (M | { role: 'assistant'; content: string })[] {
  if (thinkingMode(mode) === 'on' || !THINK_TAG_MODELS.test(modelId)) return messages
  return [...messages, { role: 'assistant', content: CLOSED_THINK_PREFILL }]
}
