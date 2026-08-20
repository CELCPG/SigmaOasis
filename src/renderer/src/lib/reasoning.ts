/**
 * Separating a reasoning model's chain-of-thought from its answer, as the
 * tokens arrive.
 *
 * Reasoning arrives in two families of spellings:
 *
 *   - Qwen3, the DeepSeek-R1 distills, gpt-oss, Magistral and friends wrap it
 *     in XML-style tags: <think>…</think> and close variants.
 *   - Gemma 4 uses native control tokens instead: <|think|>, or the structured
 *     channel <|channel>thought … <channel|>. LM Studio has no gemma4 parser
 *     registered, and the 12B QAT GGUF mistypes these tokens as user-defined,
 *     so on exactly the builds where they matter most they leak into
 *     delta.content verbatim. Nothing upstream strips them; we do.
 *
 * Appending any of that straight into the message bubble is wrong three ways
 * at once: the thinking renders as unlabeled prose, voice mode reads it aloud,
 * and it is replayed to the model on every following turn.
 *
 * This module is deliberately free of React and the DOM so the parsing — which
 * is where all the edge cases live — can be tested directly.
 *
 * Note the sibling path: some LM Studio builds return thinking out-of-band in
 * `delta.reasoning_content` instead. That needs no parsing at all and is
 * handled in useLMStudio.ts; this splitter is only for the inline case.
 * Gemma 4's native tool-call markup is a separate concern again: it is passed
 * through here as answer text and collected by lib/nativeToolCall.ts.
 */

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

interface TagPair {
  open: string
  close: string
}

/** Reasoning wrappers, in every spelling observed in the wild. */
const REASONING_PAIRS: TagPair[] = [
  { open: '<think>', close: '</think>' },
  { open: '<thinking>', close: '</thinking>' },
  { open: '<reason>', close: '</reason>' },
  { open: '<reasoning>', close: '</reasoning>' },
  // Gemma 4 native control tokens.
  { open: '<|think|>', close: '<|/think|>' },
  { open: '<|thinking|>', close: '<|/thinking|>' },
  { open: '<|reason|>', close: '<|/reason|>' },
  { open: '<|reasoning|>', close: '<|/reasoning|>' },
  // Gemma 4's structured thinking channel: <|channel>thought\n…<channel|>
  { open: '<|channel>thought', close: '<channel|>' },
  // The e4b-agentic ("geminicli") fine-tune family opens its thought with
  // <|thought> and closes it with whichever delimiter its template happens to
  // carry — observed: </thought>, <|response>, and <response> (measured on
  // gemma-4-e4b-agentic-sol-fable and google/gemma-4-12b-qat, 2026-08-03).
  // The closes all land in REASONING_END_TOKENS, so any of them ends the
  // block; a lone close in the answer path is stripped as a stray token.
  { open: '<|thought>', close: '</thought>' },
  { open: '<|thought>', close: '<|response>' },
  { open: '<|thought>', close: '<response>' }
]

/**
 * Native tool-call openers. A model that thinks and then calls a tool emits
 * one of these right after its reasoning with no closing think tag at all
 * (Gemma 4 never closes the block in that case), so they terminate a
 * reasoning block as surely as a close tag. The token itself is passed on as
 * answer text so the native tool-call extractor downstream can collect it.
 */
const TOOL_OPEN_TOKENS = ['<|tool_call>', '<|tool>']

const OPEN_TAGS = REASONING_PAIRS.map((p) => p.open)
const CLOSE_TAGS = REASONING_PAIRS.map((p) => p.close)
/** Tokens that end a reasoning block: real closes and tool-call openers. */
const REASONING_END_TOKENS = [...CLOSE_TAGS, ...TOOL_OPEN_TOKENS]

/**
 * Model families whose chain-of-thought this splitter already handles: the
 * XML think-tag family (Qwen3, DeepSeek-R1 distills, gpt-oss, Magistral) and
 * Gemma 4's native control tokens. Used to gate features that would produce
 * *doubled* thinking on these models — e.g. the tool-call preamble (strategy
 * Layer 1d) asks a model to state its reason in the answer body, which is
 * redundant noise when the model already emits CoT that lands here.
 *
 * It is a name heuristic, not a guarantee: an unknown new reasoning model
 * reads as false. That failure direction is safe — the preamble is additive,
 * never load-bearing.
 */
const REASONING_MODEL_PATTERNS = [
  /qwen3/i,
  /deepseek[-_]?r1/i,
  /r1[-_]?distill/i,
  /gpt[-_]?oss/i,
  /magistral/i,
  /gemma[-_]?4/i,
  /reasoning/i
]

/** True when the model id names a family whose CoT the splitter strips. */
export function isLikelyReasoningModel(modelId: string): boolean {
  return REASONING_MODEL_PATTERNS.some((p) => p.test(modelId))
}

/**
 * Length of the longest suffix of `text` that could still grow into one of
 * `tags`. This is what makes chunk boundaries safe: a delta ending in `<thi`
 * or `<|to` must not be emitted yet, because the next delta may complete it
 * into a tag. Returns 0 when no suffix is a viable tag prefix.
 */
export function heldBackSuffixLength(text: string, tags: readonly string[]): number {
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

/**
 * Case-insensitive index of the earliest tag from `tags`, or null. Ties go to
 * the longest tag, so a shorter tag that prefixes a longer one cannot win.
 */
export function findTag(
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
  /**
   * An opener was just consumed and the conventional newline after it should
   * be eaten. A flag rather than an inline slice, because the opener and its
   * newline can arrive in different chunks — found by the boundary-exhaustive
   * property test, which caught a chunking cut between `<|channel>thought`
   * and `\n` leaking the newline into the reasoning text.
   */
  let eatNewlineInReasoning = false

  function consume(text: string, atEnd: boolean): SplitDelta {
    let answer = ''
    let reasoning = ''
    let rest = text

    for (;;) {
      if (inReasoning) {
        if (eatNewlineInReasoning && rest.length > 0) {
          if (rest.startsWith('\n')) rest = rest.slice(1)
          eatNewlineInReasoning = false
        }
        const end = findTag(rest, REASONING_END_TOKENS)
        if (!end) {
          // Hold back a possible partial close/tool tag unless the stream is over.
          const held = atEnd ? 0 : heldBackSuffixLength(rest, REASONING_END_TOKENS)
          reasoning += rest.slice(0, rest.length - held)
          pending = rest.slice(rest.length - held)
          return { answer, reasoning }
        }
        reasoning += rest.slice(0, end.index)
        if (TOOL_OPEN_TOKENS.includes(end.tag)) {
          // Gemma 4 goes straight from thinking to calling: end the block but
          // leave the tool token in the stream for the answer path.
          inReasoning = false
          rest = rest.slice(end.index)
          continue
        }
        rest = rest.slice(end.index + end.tag.length)
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
      // The conventional newline after the opener is eaten inside the
      // reasoning branch (see eatNewlineInReasoning) so a chunk boundary
      // between the two cannot change the output.
      eatNewlineInReasoning = true
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
