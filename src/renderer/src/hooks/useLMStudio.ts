import { useCallback, useRef } from 'react'
import { useAppStore } from '../stores/appStore'
import { stopSpeaking, enqueueSpeech, extractCompleteSentences } from '../lib/voice'
import type {
  AppSettings,
  Attachment,
  ChatMessage,
  Conversation,
  ModelConfig,
  ToolCallRecord,
  ToolSchema
} from '../types'

/**
 * The engine: streams chat completions from LM Studio's OpenAI-compatible
 * API, runs the agentic tool-call loop, and routes messages — @mention to a
 * specific role, the active model in independent mode, or the whole chain in
 * collaborative pipeline mode. User messages may carry image and text-file
 * attachments, sent as multimodal content parts.
 */

const MAX_TOOL_ITERATIONS = 8
/** Hard cap on how many past messages are replayed to the model each turn. */
const MAX_HISTORY_MESSAGES = 40
/** …and a character budget on top, since a few huge messages beat many small ones. */
const MAX_HISTORY_CHARS = 48_000
/** Hard cap on consult_model calls in a single orchestrator turn. */
const MAX_DELEGATIONS_PER_TURN = 5
/** Specialist replies fed back to the orchestrator are capped to protect context. */
const MAX_CONSULT_REPLY_CHARS = 3000

// ---- OpenAI wire types --------------------------------------------------------

interface ApiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type ApiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface ApiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ApiContentPart[] | null
  tool_calls?: ApiToolCall[]
  tool_call_id?: string
}

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

/**
 * Build the wire content for a history message. Text-file attachments are
 * inlined as fenced blocks; images become image_url parts (multimodal array).
 *
 * `withImages` is set only for the turn being answered. Re-sending every
 * base64 image on every subsequent turn is what exhausts the context window
 * first in an image-heavy conversation; older images degrade to a text note.
 */
function toApiContent(m: ChatMessage, withImages: boolean): string | ApiContentPart[] {
  const attachments = m.attachments ?? []
  const files = attachments.filter((a) => a.kind === 'file')
  const images = attachments.filter((a) => a.kind === 'image' && a.dataUrl)

  const textParts: string[] = []
  if (m.content) textParts.push(m.content)
  for (const f of files) {
    textParts.push(
      `[Attached file: ${f.name}${f.truncated ? ' — truncated' : ''}]\n\`\`\`\n${f.textContent ?? ''}\n\`\`\``
    )
  }
  if (!withImages) {
    for (const img of images) textParts.push(`[Image attached earlier: ${img.name}]`)
  }
  const text = textParts.join('\n\n')

  if (!withImages || images.length === 0) return text
  const parts: ApiContentPart[] = []
  if (text) parts.push({ type: 'text', text })
  for (const img of images) {
    parts.push({ type: 'image_url', image_url: { url: img.dataUrl! } })
  }
  return parts
}

/**
 * Keep the most recent slice of a conversation that fits the budget, oldest
 * dropped first. The newest message is always kept, however large it is.
 */
function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  const kept: ChatMessage[] = []
  let chars = 0
  for (let i = messages.length - 1; i >= 0 && kept.length < MAX_HISTORY_MESSAGES; i--) {
    const m = messages[i]
    const size =
      m.content.length +
      (m.attachments ?? []).reduce((n, a) => n + (a.textContent?.length ?? 0), 0)
    if (kept.length > 0 && chars + size > MAX_HISTORY_CHARS) break
    kept.unshift(m)
    chars += size
  }
  return kept
}

/** `@RoleName` (spaces removed, case-insensitive) anywhere in the text routes the message. */
function mentionTarget(settings: AppSettings, text: string): ModelConfig | null {
  const lower = text.toLowerCase()
  for (const m of settings.models) {
    if (!m.enabled || !m.roleName.trim()) continue
    const handle = `@${m.roleName.replace(/\s+/g, '').toLowerCase()}`
    if (lower.includes(handle)) return m
  }
  return null
}

/**
 * Decide which model slots answer a user message: @mention wins, then the
 * conversation's mode decides (active slot / pipeline chain / orchestrator).
 */
function routeTargets(
  settings: AppSettings,
  convo: Conversation,
  text: string
): { targets: ModelConfig[]; delegation?: DelegationContext } {
  const mention = mentionTarget(settings, text)
  if (mention) return { targets: [mention] }

  if (convo.mode === 'collaborative') {
    return {
      targets: settings.pipeline
        .map((id) => settings.models.find((m) => m.id === id))
        .filter((m): m is ModelConfig => Boolean(m?.enabled && m.modelId))
    }
  }

  if (convo.mode === 'orchestrated') {
    const orchestrator =
      settings.models.find((m) => m.id === convo.orchestratorSlotId && m.enabled) ??
      settings.models.find((m) => m.enabled)
    if (!orchestrator) return { targets: [] }
    return {
      targets: [orchestrator],
      delegation: {
        specialists: settings.models.filter(
          (m) => m.enabled && m.modelId && m.id !== orchestrator.id
        )
      }
    }
  }

  const active =
    settings.models.find((m) => m.id === convo.activeModelSlotId && m.enabled) ??
    settings.models.find((m) => m.enabled)
  return { targets: active ? [active] : [] }
}

/**
 * Stream one chat completion. Calls `onContent` for each text delta and
 * returns any accumulated tool calls once the stream ends.
 */
async function streamChat(
  baseUrl: string,
  modelId: string,
  messages: ApiMessage[],
  tools: ToolSchema[],
  signal: AbortSignal,
  onContent: (chunk: string) => void
): Promise<{ toolCalls: ApiToolCall[] }> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      messages,
      stream: true,
      ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {})
    }),
    signal
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`LM Studio returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
  }
  if (!res.body) throw new Error('LM Studio returned an empty response body.')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const pending = new Map<number, ApiToolCall>()

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // SSE events are separated by blank lines.
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''
    for (const event of events) {
      const line = event.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const json = JSON.parse(payload) as {
          choices?: { delta?: {
            content?: string
            tool_calls?: {
              index?: number
              id?: string
              function?: { name?: string; arguments?: string }
            }[]
          } }[]
        }
        const delta = json.choices?.[0]?.delta
        if (delta?.content) onContent(delta.content)
        for (const tc of delta?.tool_calls ?? []) {
          const idx = tc.index ?? 0
          const existing = pending.get(idx) ?? {
            id: tc.id ?? `call_${uid()}`,
            type: 'function' as const,
            function: { name: '', arguments: '' }
          }
          if (tc.id) existing.id = tc.id
          if (tc.function?.name) existing.function.name += tc.function.name
          if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
          pending.set(idx, existing)
        }
      } catch {
        // Partial JSON chunk — the next SSE event completes it.
      }
    }
  }

  return { toolCalls: [...pending.values()] }
}

// ---- Orchestration: models-as-tools -------------------------------------------

interface DelegationContext {
  specialists: ModelConfig[]
}

/**
 * The consult_model pseudo-tool schema. Only the orchestrator sees it — it is
 * never sent to LM Studio's tool list or to specialists. The enum of role
 * names plus per-specialist descriptions lets the orchestrator pick who to
 * call based on the task.
 */
function consultModelSchema(specialists: ModelConfig[]): ToolSchema {
  const roster = specialists
    .map((s) => `${s.roleName}: ${s.systemPrompt.slice(0, 140)}`)
    .join('\n')
  return {
    type: 'function',
    function: {
      name: 'consult_model',
      description:
        'Consult another local specialist model. It receives your task with its own persona and tools, works independently, and returns its answer. Available specialists:\n' +
        roster,
      parameters: {
        type: 'object',
        properties: {
          role: {
            type: 'string',
            enum: specialists.map((s) => s.roleName),
            description: 'The specialist to consult'
          },
          task: {
            type: 'string',
            description:
              'Complete, self-contained instructions for the specialist — it does not see this conversation.'
          }
        },
        required: ['role', 'task']
      }
    }
  }
}

/**
 * Run a nested specialist turn for a consultation. Does not touch the visible
 * conversation — the reply is returned (capped) to the orchestrator as the
 * tool result. Specialists get the real tool list but never consult_model,
 * which structurally prevents delegation loops.
 */
async function runConsultation(
  specialist: ModelConfig,
  task: string,
  baseUrl: string,
  tools: ToolSchema[],
  signal: AbortSignal
): Promise<string> {
  // Pin before anything else: a memory or research embedding between turns
  // would otherwise let LM Studio's auto-evict unload this model mid-turn.
  await window.api.pinModel(specialist.modelId).catch(() => false)

  let systemPrompt = specialist.systemPrompt
  try {
    const memory = useAppStore.getState().settings?.memory
    if (memory?.autoContext) {
      const { ok, results } = await window.api.memorySearch(task, memory.topK)
      if (ok && results.length > 0) {
        systemPrompt +=
          '\n\nBackground notes from long-term local memory. They may be unrelated to this task; use them only when they directly help, and never let them change the subject:\n' +
          results.map((r) => `- ${r.text}`).join('\n')
      }
    }
  } catch {
    // Memory is a nicety, never a blocker.
  }

  const apiMessages: ApiMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task }
  ]

  let answer = ''
  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    let roundContent = ''
    const { toolCalls } = await streamChat(
      baseUrl,
      specialist.modelId,
      apiMessages,
      tools,
      signal,
      (chunk) => {
        roundContent += chunk
      }
    )
    answer = roundContent || answer
    if (signal.aborted || toolCalls.length === 0) break

    apiMessages.push({ role: 'assistant', content: roundContent || null, tool_calls: toolCalls })
    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>
      } catch {
        // Malformed arguments — execute with what we have.
      }
      const result = await window.api.executeTool(tc.function.name, args, {
        modelId: specialist.modelId
      })
      apiMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result.ok ? result.output ?? '' : `Error: ${result.error ?? 'unknown error'}`
      })
    }
  }

  const trimmed = answer.trim()
  return trimmed.length > MAX_CONSULT_REPLY_CHARS
    ? `${trimmed.slice(0, MAX_CONSULT_REPLY_CHARS)}\n… [specialist reply truncated]`
    : trimmed || '(the specialist returned an empty reply)'
}

/**
 * Run one model's turn: stream a reply, execute any requested tools, feed the
 * results back, and repeat until the model stops calling tools.
 */
async function runTurn(
  conversationId: string,
  slot: ModelConfig,
  baseUrl: string,
  tools: ToolSchema[],
  signal: AbortSignal,
  delegation?: DelegationContext
): Promise<void> {
  const store = useAppStore.getState()
  const convo = store.conversations.find((c) => c.id === conversationId)
  if (!convo) return

  const assistantMsg: ChatMessage = {
    id: uid(),
    role: 'assistant',
    content: '',
    modelId: slot.modelId,
    roleName: slot.roleName,
    color: slot.color,
    toolCalls: [],
    createdAt: Date.now()
  }
  store.appendMessage(conversationId, assistantMsg)
  const patch = (p: Partial<ChatMessage>): void =>
    useAppStore.getState().patchMessage(conversationId, assistantMsg.id, p)

  // Pin before the memory RAG below: its embedding call JIT-loads the
  // embedding model, and LM Studio's default auto-evict would unload this
  // slot's model in response — an eject/reload cycle on every turn. After the
  // append so the ripple covers a cold model load, which a first-turn pin
  // waits for.
  await window.api.pinModel(slot.modelId).catch(() => false)

  // RAG: pull relevant long-term memory into the system prompt (best effort).
  let systemPrompt = slot.systemPrompt
  const memorySettings = useAppStore.getState().settings?.memory
  if (memorySettings?.autoContext) {
    try {
      const lastUser = [...convo.messages].reverse().find((m) => m.role === 'user')
      if (lastUser?.content) {
        const { ok, results } = await window.api.memorySearch(
          lastUser.content,
          memorySettings.topK
        )
        if (ok && results.length > 0) {
          const block = results
            .map((r) => `- [${r.source}] ${r.text}`)
            .join('\n')
          systemPrompt +=
            `\n\nBackground notes from your long-term local memory. They may be unrelated to the current request; use them only when they directly help answer the user, and never let them change the subject:\n${block}`
        }
      }
    } catch {
      // Memory is a nicety, never a blocker.
    }
  }

  // The wire history is maintained locally across tool-loop iterations;
  // the visible conversation only keeps final text + tool-call records.
  const history = trimHistory(convo.messages)
  const currentTurn = history.map((m) => m.role).lastIndexOf('user')
  if (currentTurn === -1) {
    // Refuse a system-prompt-only request: with no user turn the model just
    // free-associates off the system prompt, which is exactly how the
    // first-turn message wipe presented (a "random" reply to nothing).
    patch({
      content:
        '⚠️ There is no message in this conversation to answer — its history may have been lost. Please send your message again.'
    })
    return
  }
  const apiMessages: ApiMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history.map((m, i) => ({ role: m.role, content: toApiContent(m, i === currentTurn) }))
  ]

  // Orchestrated mode: expose the specialists as a pseudo-tool.
  const wireTools: ToolSchema[] =
    delegation && delegation.specialists.length > 0
      ? [...tools, consultModelSchema(delegation.specialists)]
      : tools

  const allRecords: ToolCallRecord[] = []
  let delegationCount = 0

  // Voice mode: read the reply aloud sentence-by-sentence as it streams.
  const voice = useAppStore.getState().settings?.voice
  let spokenUpTo = 0
  const speakNewSentences = (flush: boolean): void => {
    if (!voice?.autoRead || signal.aborted) return
    const full = assistantMsg.content
    const unspoken = full.slice(spokenUpTo)
    // Don't read half a code block — wait for the closing fence.
    if ((unspoken.match(/```/g) ?? []).length % 2 === 1) return
    const { complete, rest } = flush
      ? { complete: unspoken, rest: '' }
      : extractCompleteSentences(unspoken)
    if (complete.trim()) enqueueSpeech(complete, voice.voiceURI, voice.rate)
    spokenUpTo = full.length - rest.length
  }

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    let content = ''
    const { toolCalls } = await streamChat(
      baseUrl,
      slot.modelId,
      apiMessages,
      wireTools,
      signal,
      (chunk) => {
        content += chunk
        patch({ content: (assistantMsg.content += chunk) })
        speakNewSentences(false)
      }
    )
    if (signal.aborted) return
    if (toolCalls.length === 0) {
      // Normal completion — read whatever tail fragment is left unspoken.
      speakNewSentences(true)
      return
    }

    // Record the calls on the visible message, then execute them in order.
    apiMessages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls })

    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>
      } catch {
        // Malformed arguments from the model — execute with what we have.
      }
      const record: ToolCallRecord = { id: tc.id, name: tc.function.name, args, status: 'running' }
      allRecords.push(record)
      patch({ toolCalls: [...allRecords] })

      let result: { ok: boolean; output?: string; error?: string }

      if (tc.function.name === 'consult_model' && delegation) {
        // Pseudo-tool: run a nested specialist turn instead of an IPC tool.
        delegationCount += 1
        if (delegationCount > MAX_DELEGATIONS_PER_TURN) {
          result = {
            ok: false,
            error: `Delegation limit reached (${MAX_DELEGATIONS_PER_TURN} consultations per turn) — synthesize an answer from what you have.`
          }
        } else {
          const role = String(args.role ?? '')
          const task = String(args.task ?? '')
          const specialist =
            delegation.specialists.find((s) => s.roleName === role) ??
            delegation.specialists.find(
              (s) => s.roleName.replace(/\s+/g, '').toLowerCase() === role.replace(/\s+/g, '').toLowerCase()
            )
          if (!specialist) {
            result = {
              ok: false,
              error: `No specialist named "${role}". Available: ${delegation.specialists.map((s) => s.roleName).join(', ')}.`
            }
          } else if (!task.trim()) {
            result = { ok: false, error: 'The "task" argument is required and must be self-contained.' }
          } else {
            try {
              const reply = await runConsultation(specialist, task, baseUrl, tools, signal)
              result = { ok: true, output: reply }
            } catch (err) {
              result = { ok: false, error: err instanceof Error ? err.message : String(err) }
            }
          }
        }
      } else {
        // The caller's model id goes along so main-process tools that need to
        // reason (deep_research) plan with the model the user is talking to.
        result = await window.api.executeTool(tc.function.name, args, {
          modelId: slot.modelId
        })
      }

      if (result.ok) {
        record.status = 'done'
        record.result = result.output ?? ''
      } else {
        record.status = 'error'
        record.result = result.error ?? 'Unknown tool error'
      }
      patch({ toolCalls: [...allRecords] })

      apiMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result.ok ? result.output ?? '' : `Error: ${result.error ?? 'unknown error'}`
      })
    }
  }

  if (!signal.aborted) {
    patch({
      content:
        (assistantMsg.content ? `${assistantMsg.content}\n\n` : '') +
        `⚠️ Stopped after ${MAX_TOOL_ITERATIONS} consecutive tool-call rounds.`
    })
    // Read whatever is left unspoken (including the warning above).
    speakNewSentences(true)
  }
}

export function useLMStudio(): {
  sendMessage: (text: string, attachments?: Attachment[]) => Promise<void>
  stopStreaming: () => void
  regenerate: () => Promise<void>
} {
  const abortRef = useRef<AbortController | null>(null)

  const stopStreaming = useCallback((): void => {
    abortRef.current?.abort()
    stopSpeaking()
  }, [])

  const sendMessage = useCallback(
    async (rawText: string, attachments: Attachment[] = []): Promise<void> => {
      const text = rawText.trim()
      const store = useAppStore.getState()
      const settings = store.settings
      if ((!text && attachments.length === 0) || !settings || store.streaming) return

      // Title fallback: first words of the message, or the first file's name.
      const titleBasis =
        text || (attachments.length > 0 ? `📎 ${attachments[0].name}` : 'Conversation')
      const title = titleBasis.length > 48 ? `${titleBasis.slice(0, 48)}…` : titleBasis

      // Ensure there is a conversation to append to.
      let convo =
        store.conversations.find((c) => c.id === store.activeConversationId) ?? null
      if (!convo) {
        convo = {
          id: uid(),
          title,
          mode: 'independent',
          activeModelSlotId: settings.models.find((m) => m.enabled)?.id,
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        } satisfies Conversation
        store.upsertConversation(convo)
        store.setActiveConversationId(convo.id)
      }

      // Append and, for placeholder conversations, retitle atomically. Doing
      // this as two separate store calls with a stale snapshot in between
      // silently dropped the first message of every new conversation.
      store.appendMessage(
        convo.id,
        {
          id: uid(),
          role: 'user',
          content: text,
          attachments: attachments.length > 0 ? attachments : undefined,
          createdAt: Date.now()
        },
        { retitle: title }
      )

      // Routing: @mention wins, then the conversation's mode decides.
      const routed = routeTargets(settings, convo, text)
      const targets = routed.targets.filter((t) => t.modelId)
      const delegation = routed.delegation

      if (targets.length === 0) {
        store.appendMessage(convo.id, {
          id: uid(),
          role: 'assistant',
          content:
            '⚠️ No routable model. Enable a slot and pick a model under Settings → Models' +
            (convo.mode === 'collaborative' ? ', then add it to the chain under Settings → Pipeline.' : '.'),
          createdAt: Date.now()
        })
        return
      }

      const tools = await window.api.listTools().catch(() => [] as ToolSchema[])
      await executeTargets(convo.id, settings.baseUrl, targets, delegation, tools)
    },
    []
  )

  /** Shared tail: run the routed targets, stream, handle errors, persist. */
  const executeTargets = useCallback(
    async (
      convoId: string,
      baseUrl: string,
      targets: ModelConfig[],
      delegation: DelegationContext | undefined,
      tools: ToolSchema[]
    ): Promise<void> => {
      const store = useAppStore.getState()
      const controller = new AbortController()
      abortRef.current = controller
      store.setStreaming(true)

      try {
        for (const slot of targets) {
          if (controller.signal.aborted) break
          // In pipeline mode each model sees the previous replies, because
          // every turn appends its assistant message to the conversation.
          // In orchestrated mode the single target is the orchestrator and
          // `delegation` carries its consultable specialists.
          await runTurn(convoId, slot, baseUrl, tools, controller.signal, delegation)
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          store.appendMessage(convoId, {
            id: uid(),
            role: 'assistant',
            content: `⚠️ ${err instanceof Error ? err.message : String(err)}`,
            createdAt: Date.now()
          })
        }
      } finally {
        useAppStore.getState().setStreaming(false)
        abortRef.current = null
        const final = useAppStore.getState().conversations.find((c) => c.id === convoId)
        if (final) void window.api.saveConversation(final)
      }
    },
    []
  )

  /**
   * Re-answer the most recent user message: drops everything after it and
   * runs the routing again, so a different answer (or a different active
   * model) can take its place.
   */
  const regenerate = useCallback(async (): Promise<void> => {
    const store = useAppStore.getState()
    const settings = store.settings
    if (!settings || store.streaming) return
    const convo = store.conversations.find((c) => c.id === store.activeConversationId)
    if (!convo) return
    const lastUserIdx = convo.messages.map((m) => m.role).lastIndexOf('user')
    if (lastUserIdx === -1) return

    const lastUser = convo.messages[lastUserIdx]
    const truncated: Conversation = { ...convo, messages: convo.messages.slice(0, lastUserIdx + 1) }
    store.upsertConversation(truncated)

    const routed = routeTargets(settings, truncated, lastUser.content)
    const targets = routed.targets.filter((t) => t.modelId)
    if (targets.length === 0) {
      store.appendMessage(convo.id, {
        id: uid(),
        role: 'assistant',
        content: '⚠️ No routable model. Enable a slot and pick a model under Settings → Models.',
        createdAt: Date.now()
      })
      return
    }

    const tools = await window.api.listTools().catch(() => [] as ToolSchema[])
    await executeTargets(convo.id, settings.baseUrl, targets, routed.delegation, tools)
  }, [executeTargets])

  return { sendMessage, stopStreaming, regenerate }
}
