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
 * A second surface form appears in some agentic fine-tunes (measured on
 * gemma-4-e4b-agentic 2026-08-03): literal XML-ish markup with plain JSON
 * arguments instead of the control-token grammar —
 *
 *   <call>web_search{"query":"paris weather"}</call>
 *
 * And a third, same model: the call as a bare JSON object in content —
 * {"tool_calls": [{"function": name, "args": {...}}]} or the singular
 * {"tool_call": name, "args": {...}}. All three parse to the same
 * NativeToolCall. A JSON-looking span that is not one of the two blob
 * signatures is emitted as visible text untouched, and a bare argument
 * object with no tool name ({"path": …}) is never treated as a call.
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
 *
 * A fourth surface form, measured on gemma-4-e4b-agentic-sol-fable
 * ("geminicli" fine-tune, 2026-08-03): the call with no wrapper at all — a
 * tool name followed directly by its argument object, whose keys may be
 * unquoted:
 *
 *   memory_search{query: "hardware recommendations for 35B LLMs"}
 *
 * Because that form is plain text plus a brace, it is only honored when the
 * name is one of the tools actually offered this turn: the caller passes the
 * enabled tool names to createNativeToolExtractor, and anything else stays
 * prose. That gate is what keeps a model *explaining* its syntax ("I would
 * call remember{...}") from executing, in the same spirit as the JSON blobs:
 * only a real, offered tool name can open a bare call.
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

const OPEN_TOKENS = ['<|tool_call>', '<|tool>', '<call>']
const CLOSE_TOKENS = ['<tool_call|>', '<tool|>', '</call>']
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
  '<|/reasoning|>',
  // The e4b-agentic fine-tune's thought/response delimiters. The reasoning
  // splitter consumes them at the start of a turn; if they show up mid-answer
  // they still never render.
  '<|thought>',
  '</thought>',
  '<|response>',
  '<response>'
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
 * The `<call>name{json}</call>` variant: the name runs up to the first brace
 * and everything between the outermost braces is one JSON object. Anything
 * that is not a JSON object (arrays, scalars, broken JSON) returns null —
 * malformed arguments must never execute, in this grammar exactly as in the
 * control-token one.
 */
function parseJsonToolCall(span: string): NativeToolCall | null {
  const head = /^([\w.-]+)\s*(\{[\s\S]*\})\s*$/.exec(span)
  if (!head) return null
  try {
    const args: unknown = JSON.parse(head[2])
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return null
    return { name: head[1], arguments: JSON.stringify(args) }
  } catch {
    return null
  }
}

/**
 * Parse the inside of a call span into the OpenAI shape. Returns null on
 * anything malformed — the caller drops malformed calls silently, because
 * half-parsed arguments must never execute.
 *
 * Two accepted grammars: the Gemma control-token form (`call:name{key:
 * <|"|>value<|"|>}`) and the `<call>name{json}</call>` fine-tune variant,
 * whose arguments are a plain JSON object.
 */
export function parseNativeToolCall(span: string): NativeToolCall | null {
  if (!span.startsWith('call:')) return parseJsonToolCall(span)
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

// ---- JSON blobs (fine-tune content-formats, measured 2026-08-03) ----------------

/**
 * Some agentic fine-tunes emit their call as a JSON object *in content*
 * rather than in any markup. Two shapes measured on gemma-4-e4b-agentic:
 *
 *   {"tool_calls": [{"function": "list_directory", "args": {"path": "~/Downloads"}}]}
 *   {"tool_call": "memory_save", "args": {"title": "favorite band", "text": "Phish"}}
 *
 * OpenAI-ish entries (`function: {name, arguments}`, an `arguments` key, or
 * arguments as a JSON string) are accepted too — the formats collapse into
 * one another across fine-tunes, and everything still lands in the same
 * NativeToolCall shape. Anything that does not parse to a call returns null,
 * and a bare argument object with no tool name ({"path": …}) never even
 * reaches this function: guessing a tool from argument shape is how the wrong
 * thing executes.
 */
export function parseJsonCallBlob(json: string): NativeToolCall[] | null {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>

  const argsOf = (raw: unknown): string | null => {
    let args: unknown = raw ?? {}
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {
        return null
      }
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return null
    return JSON.stringify(args)
  }

  if (typeof obj.tool_call === 'string') {
    const args = argsOf(obj.args ?? obj.arguments)
    return args === null ? null : [{ name: obj.tool_call, arguments: args }]
  }

  if (Array.isArray(obj.tool_calls)) {
    const calls: NativeToolCall[] = []
    for (const entry of obj.tool_calls) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
      const e = entry as Record<string, unknown>
      let name: string | undefined
      let rawArgs: unknown = e.args ?? e.arguments
      const fn = e.function
      if (typeof fn === 'string') {
        name = fn
      } else if (fn !== null && typeof fn === 'object' && !Array.isArray(fn)) {
        const f = fn as Record<string, unknown>
        if (typeof f.name === 'string') name = f.name
        if (rawArgs === undefined) rawArgs = f.arguments
      }
      if (!name && typeof e.name === 'string') name = e.name
      if (!name) return null
      const args = argsOf(rawArgs)
      if (args === null) return null
      calls.push({ name, arguments: args })
    }
    return calls.length > 0 ? calls : null
  }

  return null
}

/**
 * Does `s` (from a `{`) begin one of the two blob signatures? 'maybe' means
 * the chunk ended before the signature could be proven — the same
 * chunk-boundary discipline as heldBackSuffixLength for control tokens.
 */
function jsonHeadState(s: string): 'no' | 'maybe' | 'yes' {
  const compact = s.replace(/\s+/g, '')
  const SINGULAR = '{"tool_call":'
  const PLURAL = '{"tool_calls":'
  if (compact.startsWith(PLURAL) || compact.startsWith(SINGULAR)) return 'yes'
  if (SINGULAR.startsWith(compact) || PLURAL.startsWith(compact)) return 'maybe'
  return 'no'
}

/**
 * Consume one balanced JSON span from text starting at `{`, strings and
 * escapes respected. Returns [span, nextIndex], or null when the text ends
 * before the span closes.
 */
function takeJsonSpan(text: string): [string, number] | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return [text.slice(0, i + 1), i + 1]
    }
  }
  return null
}

// ---- bare calls (gated by the offered tool list) -------------------------------

/**
 * Quote the bare object keys of lenient JSON — `{query: "x"}` → `{"query":
 * "x"}` — without touching string literals. Only a key position (right after
 * `{` or `,`, skipping whitespace) whose identifier is followed by `:` is
 * rewritten, so array elements and already-quoted keys pass through.
 */
function quoteBareKeys(json: string): string {
  let out = ''
  let inString = false
  let escaped = false
  let expectKey = false
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '{' || ch === ',') {
      expectKey = true
      out += ch
      continue
    }
    if (expectKey && /\s/.test(ch)) {
      out += ch
      continue
    }
    if (expectKey) {
      expectKey = false
      const key = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(json.slice(i))
      if (key) {
        let j = i + key[0].length
        while (j < json.length && /\s/.test(json[j])) j++
        if (json[j] === ':') {
          out += `"${key[0]}"`
          i += key[0].length - 1
          continue
        }
      }
    }
    out += ch
  }
  return out
}

/**
 * Parse a bare call's argument span (outer braces included), strict JSON
 * first, then the lenient unquoted-key form this fine-tune family emits.
 * Anything that does not parse to an object is not a call's arguments.
 */
export function parseBareArgs(span: string): Record<string, unknown> | null {
  for (const candidate of [span, quoteBareKeys(span)]) {
    try {
      const value: unknown = JSON.parse(candidate)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>
      }
    } catch {
      // Try the next spelling.
    }
  }
  return null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Length of the longest suffix of `text` that could grow into one of the
 * offered tool names. Same chunk-boundary discipline as heldBackSuffixLength:
 * a delta ending in `memory_sea` must wait for the next chunk to prove or
 * disprove `memory_search{`.
 */
function heldBackToolNameLength(text: string, names: readonly string[]): number {
  if (names.length === 0) return 0
  const maxName = Math.max(...names.map((n) => n.length))
  const start = Math.max(0, text.length - (maxName - 1))
  for (let i = start; i < text.length; i++) {
    const suffix = text.slice(i)
    if (names.some((n) => n.length > suffix.length && n.startsWith(suffix))) {
      return text.length - i
    }
  }
  return 0
}

// ---- prose paren-calls (post-round recovery, v1.7.1) ----------------------------

/**
 * A fifth surface form, measured on qwythos-9b (2026-08-17, library eval case
 * 07): the model's entire reply was `web_search("hypothermia what to do while
 * waiting for help nhs")` — a tool call written as function-call prose, with
 * perfect retrieval already in hand. The turn scored zero.
 *
 * Paren syntax is far more dangerous to recognize than `name{json}`: prose
 * and code are full of `f("x")`. So this form is not handled in the stream
 * extractor at all — it is recognized only when the *whole finished reply* is
 * exactly one such call (backticks or a bare fence allowed), the name is an
 * offered tool, and the tool's schema has an unambiguous single string
 * parameter to bind the argument to. Anything less stays prose.
 */
export function detectProseParenCall(
  content: string,
  tools: readonly { type: 'function'; function: { name: string; parameters: Record<string, unknown> } }[]
): { name: string; args: Record<string, unknown> } | null {
  let text = content.trim()
  // Unwrap one layer of backticks or a bare ``` fence around the whole reply.
  const fence = /^```[a-z]*\n?([\s\S]*?)\n?```$/.exec(text)
  if (fence) text = fence[1].trim()
  const ticks = /^`([^`]+)`$/.exec(text)
  if (ticks) text = ticks[1].trim()

  const m = /^([A-Za-z_][A-Za-z0-9_-]*)\(\s*(?:"([\s\S]*?)"|'([\s\S]*?)'|([^()'"]{1,300}?))\s*\)$/.exec(text)
  if (!m) return null
  const [, name] = m
  const value = (m[2] ?? m[3] ?? m[4] ?? '').trim()
  if (!value) return null

  const tool = tools.find((t) => t.function.name === name)
  if (!tool) return null
  const params = tool.function.parameters as { properties?: Record<string, { type?: string }>; required?: string[] }
  const props = Object.entries(params.properties ?? {})
  const required = (params.required ?? []).filter((r) => props.some(([k]) => k === r))
  // Unambiguous binding only: exactly one required string property, or —
  // with nothing required — exactly one property at all, and it is a string.
  const target =
    required.length === 1 && props.find(([k]) => k === required[0])?.[1]?.type === 'string'
      ? required[0]
      : required.length === 0 && props.length === 1 && props[0][1]?.type === 'string'
        ? props[0][0]
        : null
  if (!target) return null
  return { name, args: { [target]: value } }
}

// ---- the stream extractor -------------------------------------------------------

/**
 * A stateful extractor over one assistant turn's answer text. Same
 * chunk-boundary discipline as the reasoning splitter: a trailing `<|to` is
 * held back until the next delta proves or disproves the token.
 *
 * `toolNames` is the list of tools offered this turn. It gates the bare
 * `name{args}` call form: without it, that form cannot be told apart from
 * prose, so bare calls are only recognized when the caller says which names
 * are real.
 */
export function createNativeToolExtractor(toolNames: readonly string[] = []): NativeToolExtractor {
  let pending = ''
  let inCall = false
  /** Raw span text of the call in progress (without its open/close tokens). */
  let span = ''
  /** JSON blob in progress (the {"tool_call… content-formats). */
  let inJson = false
  let jsonSpan = ''

  /**
   * Matches a bare call: an offered tool name, not preceded by a word
   * character / `.` / `-` / `:` (so `call:web_search{` and `xweb_search{`
   * cannot false-start one), followed by its argument brace. Null when no
   * tool names were supplied — without the gate this form is indistinguishable
   * from prose and must stay prose.
   */
  const bareCallRe =
    toolNames.length > 0
      ? new RegExp(`(?:^|[^\\w.:-])(${toolNames.map(escapeRegExp).join('|')})\\s*\\{`)
      : null

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

      if (inJson) {
        const taken = takeJsonSpan(rest)
        if (!taken) {
          // A truncated blob at end of stream is dropped like a truncated
          // markup span: half an argument set is not a call.
          if (atEnd) {
            inJson = false
            jsonSpan = ''
            return { text: out, calls }
          }
          jsonSpan += rest
          return { text: out, calls }
        }
        jsonSpan += taken[0]
        const blob = parseJsonCallBlob(jsonSpan)
        if (blob) calls.push(...blob)
        else out += jsonSpan // not a call blob after all — visible text, no execution
        jsonSpan = ''
        inJson = false
        rest = rest.slice(taken[1])
        continue
      }

      const token = findTag(rest, OUTSIDE_TOKENS)
      const brace = rest.indexOf('{')
      const bare = bareCallRe?.exec(rest) ?? null
      // The name starts after the boundary character the regex may have eaten.
      const bareStart = bare ? bare.index + (bare[0].startsWith(bare[1]) ? 0 : 1) : -1
      const bareBrace = bare ? bare.index + bare[0].length - 1 : -1

      if (bare && (!token || bareStart < token.index) && (brace === -1 || bareStart < brace)) {
        // A gated bare call — memory_search{query: "…"} — is the earliest
        // construct in the stream.
        out += rest.slice(0, bareStart)
        const taken = takeJsonSpan(rest.slice(bareBrace))
        if (!taken) {
          // Unterminated: hold it across chunks, drop it at end of stream —
          // the same discipline as a truncated markup call.
          if (atEnd) return { text: out, calls }
          pending = rest.slice(bareStart)
          return { text: out, calls }
        }
        const args = parseBareArgs(taken[0])
        if (args) {
          calls.push({ name: bare[1], arguments: JSON.stringify(args) })
        } else {
          // The name was a coincidence or the arguments are broken beyond
          // both grammars: visible text, no execution.
          out += rest.slice(bareStart, bareBrace + taken[1])
        }
        rest = rest.slice(bareBrace + taken[1])
        continue
      }

      if (brace !== -1 && (!token || brace < token.index)) {
        const head = jsonHeadState(rest.slice(brace))
        if (head === 'yes') {
          out += rest.slice(0, brace)
          inJson = true
          jsonSpan = ''
          rest = rest.slice(brace)
          continue
        }
        if (head === 'maybe' && !atEnd) {
          // The blob signature is cut by the chunk boundary: hold from the
          // brace until the next delta proves or disproves it.
          out += rest.slice(0, brace)
          pending = rest.slice(brace)
          return { text: out, calls }
        }
        // An ordinary brace — prose, a code block, a bare argument object.
        // Emit it and keep scanning.
        out += rest.slice(0, brace + 1)
        rest = rest.slice(brace + 1)
        continue
      }

      if (!token) {
        const held = atEnd
          ? 0
          : Math.max(
              heldBackSuffixLength(rest, OUTSIDE_TOKENS),
              heldBackToolNameLength(rest, toolNames)
            )
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
      inJson = false
      jsonSpan = ''
      if (!pending) return { text: '', calls: [] }
      const text = pending
      pending = ''
      return consume(text, true)
    }
  }
}
