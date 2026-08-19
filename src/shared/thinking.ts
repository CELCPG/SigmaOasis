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
