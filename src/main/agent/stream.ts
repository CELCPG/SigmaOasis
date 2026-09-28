import { randomUUID } from 'crypto'
import { createSseFrameReader, createToolCallAssembler, frameError, frameText, parseChatFrame } from '../../shared/sse'
import { createReasoningSplitter } from '../../renderer/src/lib/reasoning'
import { createNativeToolExtractor, type NativeToolCall } from '../../renderer/src/lib/nativeToolCall'
import type { ApiMessage, ApiToolCall } from '../../renderer/src/lib/agentLoop'
import type { ChunkTransport, ToolSchema } from './types'

/**
 * One streamed chat completion for the agent (v3.0): the chat transport's
 * reading of LM Studio's stream (hooks/chatTransport.ts `streamChat`) minus
 * the parts that are the chat window's — the response cache, the witness the
 * bubble reads, the paced tail. The parsing is the same shared core, so a
 * frame means the same thing to the agent as to the chat:
 *
 * - frames from src/shared/sse.ts, tool-call fragments assembled there, and a
 *   call cut off by max_tokens dropped rather than run half-written;
 * - chain-of-thought from `reasoning_content`, or split out of inline
 *   `<think>` tags by the same splitter the chat uses;
 * - Gemma 4's native tool-call markup lifted out of the text and run as a
 *   real call, as the chat does.
 */

export interface StreamRoundOptions {
  baseUrl: string
  model: string
  messages: ApiMessage[]
  tools: ToolSchema[]
  sampling?: Record<string, unknown>
  signal: AbortSignal
  transport: ChunkTransport
  onContent?: (chunk: string) => void
  onReasoning?: (chunk: string) => void
  /** Silence between chunks that counts as a dead stream. */
  stallMs?: number
}

export interface StreamRoundResult {
  content: string
  reasoning: string
  toolCalls: ApiToolCall[]
  usage: { prompt_tokens?: number; completion_tokens?: number } | null
  /** The reply hit its token budget. */
  truncated: boolean
}

/**
 * The model may take minutes to load cold and then think before its first
 * visible token; a stream that has started and then goes silent this long is
 * dead. Same order of magnitude as the chat's STREAM_STALL_MS, a little
 * longer because an agent's rounds carry more context to process.
 */
export const AGENT_STREAM_STALL_MS = 90_000

export async function streamRound(o: StreamRoundOptions): Promise<StreamRoundResult> {
  const body = JSON.stringify({
    model: o.model,
    messages: o.messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(o.sampling ?? {}),
    ...(o.tools.length > 0 ? { tools: o.tools, tool_choice: 'auto' } : {})
  })

  const frames = createSseFrameReader()
  const assembler = createToolCallAssembler(() => `call_${randomUUID().slice(0, 12)}`)
  const splitter = createReasoningSplitter()
  const nativeTools = createNativeToolExtractor(o.tools.map((t) => t.function.name))
  const nativeCalls: NativeToolCall[] = []
  const decoder = new TextDecoder()
  let content = ''
  let reasoning = ''
  let usage: StreamRoundResult['usage'] = null
  let finishReason: string | null = null
  let truncated = false
  let streamError: Error | null = null

  const emitText = (text: string): void => {
    if (!text) return
    const out = nativeTools.push(text)
    if (out.text) {
      content += out.text
      o.onContent?.(out.text)
    }
    nativeCalls.push(...out.calls)
  }
  const emit = (delta: { answer: string; reasoning: string }): void => {
    emitText(delta.answer)
    if (delta.reasoning) {
      reasoning += delta.reasoning
      o.onReasoning?.(delta.reasoning)
    }
  }
  const handleFrame = (payload: string): void => {
    if (streamError) return
    const json = parseChatFrame(payload)
    if (!json) return
    const error = frameError(json)
    if (error !== null) {
      // LM Studio's own words, quoted as its words (the chat's v1.17.2 rule).
      streamError = new Error(`LM Studio refused the request: ${error}`)
      return
    }
    if (json.usage) usage = json.usage
    const choice = json.choices?.[0]
    if (choice?.finish_reason) finishReason = choice.finish_reason
    if (choice?.finish_reason === 'length') truncated = true
    const text = frameText(json)
    if (text.reasoning) emit({ answer: '', reasoning: text.reasoning })
    if (text.content) emit(splitter.push(text.content))
    assembler.push(choice?.delta?.tool_calls)
  }

  const res = await o.transport(`${o.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    body,
    signal: o.signal,
    stallMs: o.stallMs ?? AGENT_STREAM_STALL_MS,
    onChunk: (chunk) => {
      for (const payload of frames.push(decoder.decode(chunk, { stream: true }))) handleFrame(payload)
    }
  })
  if (!res.ok) {
    throw new Error(`LM Studio returned HTTP ${res.status}${res.errorText ? `: ${res.errorText.slice(0, 300)}` : ''}`)
  }
  for (const payload of frames.flush()) handleFrame(payload)
  if (streamError) throw streamError

  // A stream that ended mid-`<think>` still has text held back by the splitter.
  emit(splitter.flush())
  const tail = nativeTools.flush()
  if (tail.text) {
    content += tail.text
    o.onContent?.(tail.text)
  }
  nativeCalls.push(...tail.calls)

  const { calls: assembled, droppedAsTruncated } = assembler.finish(finishReason)
  if (droppedAsTruncated > 0) truncated = true
  const toolCalls: ApiToolCall[] = [...assembled]
  for (const call of nativeCalls) {
    toolCalls.push({
      id: `call_native_${randomUUID().slice(0, 12)}`,
      type: 'function',
      function: { name: call.name, arguments: call.arguments }
    })
  }
  return { content, reasoning, toolCalls, usage, truncated }
}

/**
 * The CLI's transport: loopback fetch, the body read chunk by chunk, a stall
 * watchdog of its own. (The app's goes through the audited transport instead;
 * see src/main/ipc/agent.ts.)
 */
export const fetchTransport: ChunkTransport = async (url, init) => {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  init.signal.addEventListener('abort', onAbort, { once: true })
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  let stalled = false
  const arm = (): void => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => {
      stalled = true
      controller.abort()
    }, init.stallMs)
  }
  try {
    // The first byte gets the same allowance a stall does, several times
    // over: a cold model load happens before it.
    stallTimer = setTimeout(() => {
      stalled = true
      controller.abort()
    }, init.stallMs * 4)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: init.body,
      signal: controller.signal
    })
    if (!res.ok) {
      const errorText = await res.text().catch(() => '')
      return { ok: false, status: res.status, errorText }
    }
    if (!res.body) return { ok: false, status: res.status, errorText: 'empty response body' }
    arm()
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      arm()
      if (value) init.onChunk(value)
    }
    return { ok: true, status: res.status }
  } catch (err) {
    if (stalled) throw new Error(`LM Studio went silent for ${Math.round(init.stallMs / 1000)} s and the request was cut.`)
    throw err
  } finally {
    if (stallTimer) clearTimeout(stallTimer)
    init.signal.removeEventListener('abort', onAbort)
  }
}
