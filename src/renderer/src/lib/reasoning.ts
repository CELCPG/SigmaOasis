/**
 * Separating a reasoning model's chain-of-thought from its answer, as the
 * tokens arrive.
 *
 * Most of the models people actually run in LM Studio now — Qwen3, the
 * DeepSeek-R1 distills, gpt-oss, Magistral, EXAONE-Deep — emit their thinking
 * inline, wrapped in `<think>…</think>`, in the same `delta.content` stream as
 * the answer. Appending that straight into the message bubble is how v0.8.1
 * behaved, and it was wrong three ways at once: the thinking rendered as
 * unlabeled prose (markdown sanitization drops the unknown tag but keeps its
 * text), voice mode read it aloud, and it was replayed to the model on every
 * following turn.
 *
 * This module is deliberately free of React and the DOM so the parsing — which
 * is where all the edge cases live — can be tested directly.
 *
 * Note the sibling path: some LM Studio builds return thinking out-of-band in
 * `delta.reasoning_content` instead. That needs no parsing at all and is
 * handled in useLMStudio.ts; this splitter is only for the inline-tag case.
 */

/** Tag names treated as reasoning wrappers, lowercase, without brackets. */
const REASONING_TAGS = ['think', 'thinking', 'reason', 'reasoning'] as const

/** One chunk of stream, split into the two destinations. */
export interface SplitDelta {
  answer: string
  reasoning: string
}

export interface ReasoningSplitter {
  /** Feed one stream delta; returns the parts resolved by this chunk. */
  push(delta: string): SplitDelta
  /** End of stream: emit whatever is still held back. */
  flush(): SplitDelta
}

const EMPTY: SplitDelta = { answer: '', reasoning: '' }

const OPEN_TAGS = REASONING_TAGS.map((t) => `<${t}>`)
const CLOSE_TAGS = REASONING_TAGS.map((t) => `</${t}>`)

/**
 * Length of the longest suffix of `text` that could still grow into one of
 * `tags`. This is what makes chunk boundaries safe: a delta ending in `<thi`
 * must not be emitted as answer text, because the next delta may complete it
 * into `<think>`. Returns 0 when no suffix is a viable tag prefix.
 */
function heldBackSuffixLength(text: string, tags: readonly string[]): number {
  if (tags.length === 0) return 0
  const maxTag = Math.max(...tags.map((t) => t.length))
  const start = Math.max(0, text.length - (maxTag - 1))
  for (let i = start; i < text.length; i++) {
    const suffix = text.slice(i)
    if (tags.some((tag) => tag.length > suffix.length && tag.startsWith(suffix))) {
      return text.length - i
    }
  }
  return 0
}

/** Case-insensitive index of the earliest tag from `tags`, or -1. */
function findTag(
  haystack: string,
  tags: readonly string[]
): { index: number; tag: string } | null {
  const lower = haystack.toLowerCase()
  let best: { index: number; tag: string } | null = null
  for (const tag of tags) {
    const index = lower.indexOf(tag)
    if (index === -1) continue
    if (!best || index < best.index || (index === best.index && tag.length > best.tag.length)) {
      best = { index, tag }
    }
  }
  return best
}

/**
 * A stateful splitter over one assistant turn.
 *
 * The one judgement call worth stating: an opening tag is only honored while
 * the answer is still empty (whitespace aside). Reasoning models put their
 * thinking first, always — so a `<think>` appearing *after* the model has
 * started answering is far more likely to be the model writing about the tag,
 * in a code block or an explanation, than a second thought block. Treating it
 * as reasoning there would silently swallow the rest of a legitimate answer,
 * which is a much worse failure than showing one stray tag.
 */
export function createReasoningSplitter(): ReasoningSplitter {
  /** Text carried over because it might be the start of a tag. */
  let pending = ''
  /** Inside a reasoning block right now. */
  let inReasoning = false
  /** Any non-whitespace answer text has been emitted. */
  let answerStarted = false

  function consume(text: string, atEnd: boolean): SplitDelta {
    let answer = ''
    let reasoning = ''
    let rest = text

    for (;;) {
      if (inReasoning) {
        const close = findTag(rest, CLOSE_TAGS)
        if (!close) {
          // Hold back a possible partial `</thin…` unless the stream is over.
          const held = atEnd ? 0 : heldBackSuffixLength(rest, CLOSE_TAGS)
          reasoning += rest.slice(0, rest.length - held)
          pending = rest.slice(rest.length - held)
          return { answer, reasoning }
        }
        reasoning += rest.slice(0, close.index)
        rest = rest.slice(close.index + close.tag.length)
        inReasoning = false
        continue
      }

      // Outside a block. Once the answer has started, tags are just text.
      const open = answerStarted ? null : findTag(rest, OPEN_TAGS)
      if (!open) {
        // Once the answer has started nothing needs holding back; before that,
        // a trailing `<thi` might yet become an opening tag.
        const held = atEnd || answerStarted ? 0 : heldBackSuffixLength(rest, OPEN_TAGS)
        const emitted = rest.slice(0, rest.length - held)
        answer += emitted
        if (emitted.trim()) answerStarted = true
        pending = rest.slice(rest.length - held)
        return { answer, reasoning }
      }

      // Text before the opening tag is answer text — and if it is more than
      // whitespace, the answer has started and this tag is not a wrapper.
      const before = rest.slice(0, open.index)
      if (before.trim()) {
        answer += before
        answerStarted = true
        rest = rest.slice(open.index)
        continue
      }
      answer += before
      rest = rest.slice(open.index + open.tag.length)
      inReasoning = true
    }
  }

  return {
    push(delta: string): SplitDelta {
      if (!delta) return EMPTY
      const text = pending + delta
      pending = ''
      return consume(text, false)
    },
    flush(): SplitDelta {
      if (!pending) return EMPTY
      const text = pending
      pending = ''
      return consume(text, true)
    }
  }
}
