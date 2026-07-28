import { useCallback, useRef } from 'react'
import { useAppStore } from '../stores/appStore'
import { speak, stopSpeaking } from '../lib/voice'
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
  let systemPrompt = specialist.systemPrompt
  try {
    const memory = useAppStore.getState().settings?.memory
    if (memory?.autoContext) {
      const { ok, results } = await window.api.memorySearch(task, memory.topK)
      if (ok && results.length > 0) {
        systemPrompt +=
          '\n\nRelevant information from long-term local memory:\n' +
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
      const result = await window.api.executeTool(tc.function.name, args)
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
            `\n\nRelevant information from your long-term local memory (use it when it helps; ignore it when it does not):\n${block}`
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
      }
    )
    if (signal.aborted || toolCalls.length === 0) return

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
        result = await window.api.executeTool(tc.function.name, args)
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
  }

  // Voice mode: read the finished reply aloud.
  const voice = useAppStore.getState().settings?.voice
  if (!signal.aborted && voice?.autoRead && assistantMsg.content.trim()) {
    speak(assistantMsg.content, voice.voiceURI, voice.rate)
  }
}

export function useLMStudio(): {
  sendMessage: (text: string, attachments?: Attachment[]) => Promise<void>
  stopStreaming: () => void
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

      store.appendMessage(convo.id, {
        id: uid(),
        role: 'user',
        content: text,
        attachments: attachments.length > 0 ? attachments : undefined,
        createdAt: Date.now()
      })

      // Give placeholder conversations a real title from the first message.
      if (convo.title === 'New conversation') {
        const retitled = { ...convo, title }
        store.upsertConversation(retitled)
        convo = retitled
      }

      // Routing: @mention wins, then the conversation's mode decides.
      const mention = mentionTarget(settings, text)
      let targets: ModelConfig[]
      let delegation: DelegationContext | undefined

      if (mention) {
        targets = [mention]
      } else if (convo.mode === 'collaborative') {
        targets = settings.pipeline
          .map((id) => settings.models.find((m) => m.id === id))
          .filter((m): m is ModelConfig => Boolean(m?.enabled))
      } else if (convo.mode === 'orchestrated') {
        const orchestrator =
          settings.models.find((m) => m.id === convo!.orchestratorSlotId && m.enabled) ??
          settings.models.find((m) => m.enabled)
        targets = orchestrator ? [orchestrator] : []
        if (orchestrator) {
          // Every other enabled, model-selected slot becomes consultable.
          delegation = {
            specialists: settings.models.filter(
              (m) => m.enabled && m.modelId && m.id !== orchestrator.id
            )
          }
        }
      } else {
        const active =
          settings.models.find((m) => m.id === convo!.activeModelSlotId && m.enabled) ??
          settings.models.find((m) => m.enabled)
        targets = active ? [active] : []
      }
      targets = targets.filter((t) => t.modelId)

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
      const controller = new AbortController()
      abortRef.current = controller
      store.setStreaming(true)
      const convoId = convo.id

      try {
        for (const slot of targets) {
          if (controller.signal.aborted) break
          // In pipeline mode each model sees the previous replies, because
          // every turn appends its assistant message to the conversation.
          // In orchestrated mode the single target is the orchestrator and
          // `delegation` carries its consultable specialists.
          await runTurn(convoId, slot, settings.baseUrl, tools, controller.signal, delegation)
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

  return { sendMessage, stopStreaming }
}
