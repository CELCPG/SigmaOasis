import { findTag, heldBackSuffixLength } from './reasoning'

/**
 * Gemma 4's native tool-call markup, parsed out of the content stream.
 *
 * Gemma 4 does not use the OpenAI tool_calls channel natively; it emits
 *
 *   <|tool_call>call:write_file{file_path:<|"|>a.txt<|"|>,retries:3}<tool_call|>
 *
 * and relies on the serving layer to parse that back into structured calls.
 * vLLM and llama-server have a gemma4 parser; LM Studio does not (and the 12B
 * QAT GGUF mistypes the control tokens as user-defined), so the markup
 * arrives inside delta.content as literal text. Models quantize imperfectly,
 * so the sloppy variant <|tool>call:… is accepted too.
 *
 * This extractor removes the markup from the visible answer and returns the
 * calls parsed into the same shape the OpenAI channel would have produced, so
 * they execute through the normal tool loop. A hallucinated name simply
 * reaches executeTool and comes back as an error the model can recover from,
 * which is exactly how a malformed OpenAI tool call behaves.
 *
 * A truncated call (stream ended mid-block) is dropped rather than executed
 * or shown: half an argument set is not a call, and rendering raw markup is
 * the bug this module exists to fix.
 */

export interface NativeToolCall {
  name: string
  /** JSON-stringified arguments, matching the OpenAI tool_calls shape. */
  arguments: string
}

export interface ToolExtraction {
  /** Answer text with tool markup and stray control tokens removed. */
  text: string
  /** Calls completed by this chunk. */
  calls: NativeToolCall[]
}

export interface NativeToolExtractor {
  push(chunk: string): ToolExtraction
  flush(): ToolExtraction
}

const OPEN_TOKENS = ['<|tool_call>', '<|tool>']
const CLOSE_TOKENS = ['<tool_call|>', '<tool|>']
const QUOTE = '<|"|>'

/**
 * Control tokens that carry no meaning outside their own structure. The
 * reasoning splitter handles think/channel wrappers before the answer starts;
 * if they appear mid-answer the tokens themselves still never render. `<|"|>`
 * only means anything inside tool arguments.
 */
const STRAY_TOKENS = [
  '<|"|>',
  '<|turn>',
  '<turn|>',
  '<|channel>thought',
  '<|channel|>',
  '<channel|>',
  '<|think|>',
  '<|/think|>',
  '<|thinking|>',
  '<|/thinking|>',
  '<|reason|>',
  '<|/reason|>',
  '<|reasoning|>',
  '<|/reasoning|>'
]

/** Every token the scanner reacts to outside a tool block. */
const OUTSIDE_TOKENS = [...OPEN_TOKENS, ...STRAY_TOKENS]

// ---- argument parsing ---------------------------------------------------------

const PARSE_FAIL = Symbol('parse-fail')

/**
 * Parse one argument value at `text[i]`: a `<|"|>…<|"|>` string, a list, a
 * boolean, or a bare number. Returns [value, nextIndex] or PARSE_FAIL.
 */
function parseValue(text: string, i: number): [unknown, number] | typeof PARSE_FAIL {
  if (text.startsWith(QUOTE, i)) {
    const end = text.indexOf(QUOTE, i + QUOTE.length)
    if (end === -1) return PARSE_FAIL
    return [text.slice(i + QUOTE.length, end), end + QUOTE.length]
  }
  if (text[i] === '[') {
    const list: unknown[] = []
    let j = i + 1
    for (;;) {
      while (j < text.length && /[\s]/.test(text[j])) j++
      if (text[j] === ']') return [list, j + 1]
      const item = parseValue(text, j)
      if (item === PARSE_FAIL) return PARSE_FAIL
      list.push(item[0])
      j = item[1]
      while (j < text.length && /[\s]/.test(text[j])) j++
      if (text[j] === ',') {
        j++
        continue
      }
      if (text[j] === ']') return [list, j + 1]
      return PARSE_FAIL
    }
  }
  const bool = /^(true|false)\b/.exec(text.slice(i))
  if (bool) return [bool[1] === 'true', i + bool[1].length]
  const num = /^-?\d+(\.\d+)?/.exec(text.slice(i))
  if (num) return [Number(num[0]), i + num[0].length]
  return PARSE_FAIL
}

/**
 * Parse the inside of a `call:name{…}` span into the OpenAI shape. Returns
 * null on anything malformed — the caller drops malformed calls silently,
 * because half-parsed arguments must never execute.
 */
export function parseNativeToolCall(span: string): NativeToolCall | null {
  const head = /^call:\s*([\w.-]+)\s*\{/.exec(span)
  if (!head) return null
  const name = head[1]

  let body = span.slice(head[0].length)
  if (body.endsWith('}')) body = body.slice(0, -1)

  const args: Record<string, unknown> = {}
  let i = 0
  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i])) i++
    if (i >= body.length) break
    const key = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(i))
    if (!key) return null
    i += key[0].length
    while (i < body.length && /\s/.test(body[i])) i++
    if (body[i] !== ':') return null
    i++
    while (i < body.length && /\s/.test(body[i])) i++
    const parsed = parseValue(body, i)
    if (parsed === PARSE_FAIL) return null
    args[key[0]] = parsed[0]
    i = parsed[1]
    while (i < body.length && /\s/.test(body[i])) i++
    if (i < body.length) {
      if (body[i] !== ',') return null
      i++
    }
  }
  return { name, arguments: JSON.stringify(args) }
}

// ---- the stream extractor -------------------------------------------------------

/**
 * A stateful extractor over one assistant turn's answer text. Same
 * chunk-boundary discipline as the reasoning splitter: a trailing `<|to` is
 * held back until the next delta proves or disproves the token.
 */
export function createNativeToolExtractor(): NativeToolExtractor {
  let pending = ''
  let inCall = false
  /** Raw span text of the call in progress (without its open/close tokens). */
  let span = ''

  function consume(text: string, atEnd: boolean): ToolExtraction {
    let out = ''
    const calls: NativeToolCall[] = []
    let rest = text

    for (;;) {
      if (inCall) {
        const close = findTag(rest, CLOSE_TOKENS)
        if (!close) {
          const held = atEnd ? 0 : heldBackSuffixLength(rest, CLOSE_TOKENS)
          span += rest.slice(0, rest.length - held)
          pending = rest.slice(rest.length - held)
          return { text: out, calls }
        }
        span += rest.slice(0, close.index)
        const call = parseNativeToolCall(span)
        if (call) calls.push(call)
        span = ''
        inCall = false
        rest = rest.slice(close.index + close.tag.length)
        continue
      }

      const token = findTag(rest, OUTSIDE_TOKENS)
      if (!token) {
        const held = atEnd ? 0 : heldBackSuffixLength(rest, OUTSIDE_TOKENS)
        out += rest.slice(0, rest.length - held)
        pending = rest.slice(rest.length - held)
        return { text: out, calls }
      }

      out += rest.slice(0, token.index)
      if (OPEN_TOKENS.includes(token.tag)) {
        inCall = true
        span = ''
      }
      // Stray control tokens are dropped; open tokens start a span. Neither
      // reaches the output.
      rest = rest.slice(token.index + token.tag.length)
    }
  }

  return {
    push(chunk: string): ToolExtraction {
      if (!chunk) return { text: '', calls: [] }
      const text = pending + chunk
      pending = ''
      return consume(text, false)
    },
    flush(): ToolExtraction {
      // A stream that ended mid-call drops the partial span: half an argument
      // set is not a call, and showing the markup is the bug being fixed.
      span = ''
      inCall = false
      if (!pending) return { text: '', calls: [] }
      const text = pending
      pending = ''
      return consume(text, true)
    }
  }
}
