/**
 * One streaming core for `/chat/completions` (v2.4).
 *
 * Two clients read LM Studio's SSE stream until now — `main/ipc/llm.ts` for the
 * app's own completions (plans, summaries, deliberation) and
 * `hooks/chatTransport.ts` for the chat — and they had drifted: one split the
 * byte stream on blank lines and took the first `data:` line of each event,
 * the other took every `data:` line as a frame; one knew about tool calls,
 * usage, `finish_reason` and error frames, the other only about text. Both
 * were right for the frames they had seen. This is the parser they share, and
 * the contract it keeps is written down here rather than in two loops:
 *
 *   - A frame is one `data:` line. The SSE spec lets an event's data span
 *     several `data:` lines joined at a blank line; no OpenAI-compatible server
 *     does that, both clients here always read line by line, and joining is
 *     how one malformed line would swallow the good one after it. Blank lines
 *     and `event:` / `id:` / comment lines are skipped.
 *   - `[DONE]` ends the stream. Nothing after it is read — a late frame after
 *     the terminator is a server bug, not a delta.
 *   - Tool-call arguments stay the raw JSON string the server sent, joined
 *     fragment by fragment, never parsed here: the loop's repair and schema
 *     layers are the only place that reads them.
 *   - A `finish_reason` of `length` means the reply hit its token budget. A
 *     tool call still open when that happens is cut off mid-arguments, and
 *     running a call whose JSON the model never finished is worse than running
 *     none: such calls are dropped and the truncation is reported instead.
 *   - Usage rides a final chunk whose `choices` is empty; it is kept whenever
 *     it arrives.
 *   - A malformed payload is skipped, never fatal: through v1.12.1 one client
 *     diagnosed the error frame from inside its JSON catch, so the one
 *     failure that diagnosis existed for — a request over the loaded context
 *     — was swallowed as a "partial chunk". Errors are read on parsed frames
 *     only, outside any catch.
 *
 * Pure: no fetch, no timers, no store. Both processes import it.
 */

export interface SseUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

export interface SseToolCallFragment {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

/** One parsed `/chat/completions` stream frame, as LM Studio sends it. */
export interface ChatFrame {
  choices?: {
    delta?: { content?: string; reasoning_content?: string; tool_calls?: SseToolCallFragment[] }
    /** A non-streaming shape some servers use for the last chunk. */
    message?: { content?: string; reasoning_content?: string }
    finish_reason?: string | null
  }[]
  usage?: SseUsage
  error?: { message?: string; type?: string; code?: number } | string
}

/**
 * Turns bytes-as-text into complete `data:` payloads. Feed it every decoded
 * chunk; it returns the payloads that completed, keeps the remainder, and
 * `flush()` yields whatever a stream that ended without a trailing newline
 * still held. `[DONE]` closes it: later pushes return nothing.
 */
export function createSseFrameReader(): {
  push: (text: string) => string[]
  flush: () => string[]
  readonly done: boolean
} {
  let rest = ''
  let done = false

  const takeLine = (line: string, out: string[]): void => {
    if (done) return
    const trimmed = line.replace(/\r$/, '')
    if (!trimmed.startsWith('data:')) return // blank lines, comments, `event:`, `id:` — nothing we use
    const payload = trimmed.slice(5).trim()
    if (payload === '') return
    if (payload === '[DONE]') {
      done = true
      return
    }
    out.push(payload)
  }

  return {
    push(text: string): string[] {
      const out: string[] = []
      if (done) return out
      rest += text
      let nl = rest.indexOf('\n')
      while (nl !== -1) {
        takeLine(rest.slice(0, nl), out)
        rest = rest.slice(nl + 1)
        nl = rest.indexOf('\n')
      }
      return out
    },
    flush(): string[] {
      const out: string[] = []
      if (done) return out
      if (rest !== '') {
        takeLine(rest, out)
        rest = ''
      }
      return out
    },
    get done() {
      return done
    }
  }
}

/** Parse one payload into a frame, or null for a payload that is not JSON. */
export function parseChatFrame(payload: string): ChatFrame | null {
  try {
    const parsed = JSON.parse(payload) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as ChatFrame) : null
  } catch {
    return null
  }
}

/** The error text a frame carries, if it is an error frame. */
export function frameError(frame: ChatFrame): string | null {
  if (!frame.error) return null
  if (typeof frame.error === 'string') return frame.error
  return frame.error.message ?? JSON.stringify(frame.error)
}

/** What a frame contributes to the reply: text, out-of-band reasoning, both possibly empty. */
export function frameText(frame: ChatFrame): { content: string; reasoning: string } {
  const choice = frame.choices?.[0]
  return {
    content: choice?.delta?.content ?? choice?.message?.content ?? '',
    reasoning: choice?.delta?.reasoning_content ?? choice?.message?.reasoning_content ?? ''
  }
}

export interface AssembledToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/**
 * Accumulates tool-call fragments by index across frames. `finish(reason)`
 * returns the calls, or none when the reply was cut off at its token budget —
 * see the contract above.
 */
export function createToolCallAssembler(newId: () => string): {
  push: (fragments: SseToolCallFragment[] | undefined) => void
  finish: (finishReason: string | null | undefined) => { calls: AssembledToolCall[]; droppedAsTruncated: number }
} {
  const pending = new Map<number, AssembledToolCall>()
  return {
    push(fragments) {
      for (const tc of fragments ?? []) {
        const idx = tc.index ?? 0
        const existing = pending.get(idx) ?? {
          id: tc.id ?? newId(),
          type: 'function' as const,
          function: { name: '', arguments: '' }
        }
        if (tc.id) existing.id = tc.id
        if (tc.function?.name) existing.function.name += tc.function.name
        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
        pending.set(idx, existing)
      }
    },
    finish(finishReason) {
      const calls = [...pending.values()]
      if (finishReason === 'length' && calls.length > 0) {
        pending.clear()
        return { calls: [], droppedAsTruncated: calls.length }
      }
      return { calls, droppedAsTruncated: 0 }
    }
  }
}
