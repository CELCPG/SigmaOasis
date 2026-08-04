import { useCallback, useRef } from 'react'
import { useAppStore } from '../stores/appStore'
import { stopSpeaking, enqueueSpeech, extractCompleteSentences } from '../lib/voice'
import { createReasoningSplitter } from '../lib/reasoning'
import { createNativeToolExtractor, type NativeToolCall } from '../lib/nativeToolCall'
import {
  estimateTokens,
  historyBudget,
  planHistory,
  planHistoryFallback
} from '../lib/contextBudget'
import { budgetContextLength, formatContextLength } from '../lib/modelInfo'
import { toolsForSlot, selectTurnTools, TURN_TOOL_CAP } from '../lib/toolSelection'
import { buildCriticMessages, pickCritic } from '../lib/secondOpinion'
import {
  buildSearchContext,
  buildSearchQuery,
  consultedSources,
  looksFactual,
  withGrounding,
  withToolCallPreamble
} from '../lib/grounding'
import {
  buildExtractionMessages,
  buildJudgeMessages,
  firstResultUrl,
  parseClaims,
  parseVerdict
} from '../lib/claimCheck'
import {
  consultModelSchema,
  runAgentLoop,
  toolCallPreamble,
  MAX_TOOL_ITERATIONS,
  type ApiContentPart,
  type ApiMessage,
  type ApiToolCall,
  type ApiUsage,
  type SpecialistProfile
} from '../lib/agentLoop'
import {
  routeTargets,
  escalationCandidate,
  escalationReason,
  ESCALATION_REASON_TEXT
} from '../lib/routing'
import type {
  AppSettings,
  Attachment,
  ChatMessage,
  ChatPlan,
  CheckedClaim,
  ClaimCheckRecord,
  Conversation,
  ModelConfig,
  PlanStep,
  ResponseStats,
  SamplingSettings,
  SecondOpinionRecord,
  ToolCallRecord,
  ToolResult,
  ToolSchema
} from '../types'

/**
 * The engine: streams chat completions from LM Studio's OpenAI-compatible
 * API, runs the agentic tool-call loop, and routes messages — @mention to a
 * specific role, the active model in independent mode, or the whole chain in
 * collaborative pipeline mode. User messages may carry image and text-file
 * attachments, sent as multimodal content parts.
 */

/** Specialist replies fed back to the orchestrator are capped to protect context. */
const MAX_CONSULT_REPLY_CHARS = 3000

/**
 * Fire-and-forget audit log entry (v0.9). Checked here AND in the main
 * process: skipped when the log is disabled, and ephemeral conversations
 * never produce entries. Audit failures must never break a chat turn.
 */
function audit(
  convo: Conversation,
  input: {
    kind: 'user_input' | 'assistant_output' | 'tool_call'
    roleName?: string
    modelId?: string
    toolName?: string
    ok?: boolean
    text: string
  }
): void {
  if (!useAppStore.getState().settings?.audit.enabled) return
  void window.api
    .auditRecord({ ...input, conversationId: convo.id, ephemeral: convo.ephemeral === true })
    .catch(() => undefined)
}

// ---- OpenAI wire types --------------------------------------------------------
// ApiMessage / ApiToolCall / ApiContentPart / ApiUsage live in lib/agentLoop.ts,
// which owns the wire history across tool-loop iterations.

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

/** Flatten a dropped span into the text handed to the summarizer. */
function toSummaryText(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const who = m.role === 'user' ? 'User' : m.roleName || 'Assistant'
      const attachments = (m.attachments ?? []).map((a) => `[attached: ${a.name}]`).join(' ')
      return `${who}: ${[m.content, attachments].filter(Boolean).join(' ')}`.trim()
    })
    .filter((line) => line.length > 3)
    .join('\n\n')
}

/**
 * Decide what history to send, and compact whatever does not fit.
 *
 * Budgeting against the model's real context window needs the model catalog;
 * when the server does not report a context length, this falls back to the
 * pre-0.8.2 message/character rule so an older LM Studio behaves exactly as
 * it did before.
 *
 * Compaction is best effort in the strongest sense: any failure — no
 * summarizer model, a timeout, an empty reply — falls through to plain
 * dropping. Losing the beginning of a conversation is bad; refusing to answer
 * the current message because the summarizer had a bad day is worse.
 */
async function planAndCompact(
  convo: Conversation,
  slot: ModelConfig,
  systemPromptTokens: number,
  toolSchemaTokens: number
): Promise<{ history: ChatMessage[]; summaryText: string | null }> {
  const store = useAppStore.getState()
  const catalogEntry = store.availableModels.find((m) => m.id === slot.modelId)
  const budget = historyBudget({
    contextLength: budgetContextLength(slot, catalogEntry),
    systemPromptTokens,
    toolSchemaTokens,
    maxTokens: slot.sampling.maxTokens
  })

  const plan =
    budget === undefined ? planHistoryFallback(convo.messages) : planHistory(convo.messages, budget)

  const existing = convo.summary
  if (plan.drop.length === 0) {
    return { history: plan.keep, summaryText: existing?.text ?? null }
  }

  // 'trim' means stop *making* summaries. A summary the conversation already
  // has is still accurate for the span it covers, and throwing it away would
  // lose context for nothing.
  if (store.settings?.contextManagement === 'trim') {
    return { history: plan.keep, summaryText: existing?.text ?? null }
  }

  // Only summarize what this compaction newly drops — anything up to
  // `throughMessageId` is already folded into the existing summary.
  const alreadyFolded = existing
    ? plan.drop.findIndex((m) => m.id === existing.throughMessageId) + 1
    : 0
  const fresh = plan.drop.slice(alreadyFolded)
  if (fresh.length === 0) {
    return { history: plan.keep, summaryText: existing?.text ?? null }
  }

  useAppStore.getState().setCompacting(true)
  try {
    const result = await window.api.summarizeConversation({
      previousSummary: existing?.text,
      droppedText: toSummaryText(fresh),
      modelId: slot.modelId
    })
    if (!result.ok) return { history: plan.keep, summaryText: existing?.text ?? null }

    const summary = {
      text: result.summary,
      throughMessageId: plan.drop[plan.drop.length - 1].id,
      updatedAt: Date.now()
    }
    const current = useAppStore.getState().conversations.find((c) => c.id === convo.id)
    if (current) {
      const next = { ...current, summary }
      useAppStore.getState().upsertConversation(next)
      // Ephemeral conversations are never persisted — RAM only, by design.
      if (!next.ephemeral) void window.api.saveConversation(next)
    }
    return { history: plan.keep, summaryText: summary.text }
  } catch {
    return { history: plan.keep, summaryText: existing?.text ?? null }
  } finally {
    useAppStore.getState().setCompacting(false)
  }
}

/**
 * Stream one chat completion. Calls `onContent` for each answer delta,
 * `onReasoning` for each chain-of-thought delta, and returns any accumulated
 * tool calls once the stream ends.
 *
 * Reasoning arrives one of two ways depending on the model and the LM Studio
 * build: out-of-band in `delta.reasoning_content`, or inline in the content
 * stream wrapped in `<think>` tags. Both are handled — the inline case through
 * the splitter in lib/reasoning.ts, which is where the chunk-boundary and
 * false-positive edge cases live.
 */
async function streamChat(
  baseUrl: string,
  modelId: string,
  messages: ApiMessage[],
  tools: ToolSchema[],
  signal: AbortSignal,
  onContent: (chunk: string) => void,
  onReasoning?: (chunk: string) => void,
  sampling?: SamplingSettings
): Promise<{ toolCalls: ApiToolCall[]; usage: ApiUsage | null; ttftMs: number | null }> {
  const startedAt = Date.now()
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      messages,
      stream: true,
      // Ask for token counts. Servers that do not know the option ignore it,
      // and the stats readout falls back to timing alone.
      stream_options: { include_usage: true },
      ...(sampling
        ? {
            temperature: sampling.temperature,
            top_p: sampling.topP,
            ...(sampling.maxTokens > 0 ? { max_tokens: sampling.maxTokens } : {}),
            ...(sampling.seed !== null ? { seed: sampling.seed } : {})
          }
        : {}),
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
  const splitter = createReasoningSplitter()
  // Gemma 4's native tool-call markup arrives inside the content stream on
  // servers without a gemma4 parser (LM Studio today). The extractor strips
  // it from the visible answer and returns the calls in OpenAI shape, so they
  // execute through the same loop as real tool_calls.
  const nativeTools = createNativeToolExtractor(tools.map((t) => t.function.name))
  const nativeCalls: NativeToolCall[] = []
  let usage: ApiUsage | null = null
  let ttftMs: number | null = null

  const emitText = (text: string): void => {
    if (!text) return
    const out = nativeTools.push(text)
    if (out.text) onContent(out.text)
    nativeCalls.push(...out.calls)
  }

  const emit = (delta: { answer: string; reasoning: string }): void => {
    if ((delta.answer || delta.reasoning) && ttftMs === null) ttftMs = Date.now() - startedAt
    emitText(delta.answer)
    if (delta.reasoning) onReasoning?.(delta.reasoning)
  }

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
            /** LM Studio's out-of-band reasoning channel; needs no parsing. */
            reasoning_content?: string
            tool_calls?: {
              index?: number
              id?: string
              function?: { name?: string; arguments?: string }
            }[]
          } }[]
          usage?: ApiUsage
        }
        // The usage block rides a final chunk whose `choices` is empty.
        if (json.usage) usage = json.usage
        const delta = json.choices?.[0]?.delta
        if (delta?.reasoning_content) emit({ answer: '', reasoning: delta.reasoning_content })
        if (delta?.content) emit(splitter.push(delta.content))
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

  // A stream that ended mid-`<think>` (max_tokens, abort) still has text held
  // back by the splitter — surface it as reasoning rather than losing it.
  emit(splitter.flush())
  const tail = nativeTools.flush()
  if (tail.text) onContent(tail.text)
  nativeCalls.push(...tail.calls)

  const toolCalls = [...pending.values()]
  for (const call of nativeCalls) {
    toolCalls.push({
      id: `call_native_${uid()}`,
      type: 'function',
      function: { name: call.name, arguments: call.arguments }
    })
  }
  return { toolCalls, usage, ttftMs }
}

// ---- Orchestration: models-as-tools -------------------------------------------

interface DelegationContext {
  specialists: ModelConfig[]
}

/**
 * Vision check for the pre-flight router (Layer 2b), answered from the model
 * catalog LM Studio reported — never guessed from the model id.
 */
function visionCapable(modelId: string): boolean {
  return useAppStore
    .getState()
    .availableModels.some((m) => m.id === modelId && m.vision === true)
}

/**
 * v1.3: per-turn tool subsetting (Layer 1b). Always-on tools plus the top
 * embedding matches against the user's text, capped at TURN_TOOL_CAP. Any
 * ranking failure — no embedding model, an endpoint error — falls back to
 * the full per-role allowlist: an optimization, never a gate.
 */
async function subsetForTurn(
  tools: ToolSchema[],
  query: string | undefined
): Promise<ToolSchema[]> {
  if (!query?.trim() || tools.length <= TURN_TOOL_CAP) return tools
  try {
    const res = await window.api.rankTools(
      query,
      tools.map((t) => ({ name: t.function.name, description: t.function.description }))
    )
    if (!res.ok || !res.scores) return tools
    return selectTurnTools(tools, res.scores)
  } catch {
    return tools
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

  let systemPrompt = withToolCallPreamble(withGrounding(specialist.systemPrompt), specialist.modelId)
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
  await runAgentLoop({
    messages: apiMessages,
    // The specialist's own allowlist — not the orchestrator's — decides what
    // it holds (v1.3). This is also the security boundary: a Finance Coach
    // without run_terminal_command in its allowlist cannot be talked into a
    // shell by an orchestrator's task text. Subset to the task at hand.
    tools: await subsetForTurn(toolsForSlot(specialist, tools), task),
    // A specialist's tool calls are not visible to the user; the orchestrator
    // sees only the final reply, so the records list is discarded.
    records: [],
    signal,
    deps: {
      streamRound: async (messages, roundTools) => {
        let roundContent = ''
        // No onReasoning handler: a specialist's thinking is discarded rather than
        // returned to the orchestrator, which asked for an answer and pays context
        // for everything it gets back.
        const { toolCalls } = await streamChat(
          baseUrl,
          specialist.modelId,
          messages,
          roundTools,
          signal,
          (chunk) => {
            roundContent += chunk
          },
          undefined,
          specialist.sampling
        )
        answer = roundContent || answer
        return { content: roundContent, toolCalls }
      },
      executeTool: (name, args) =>
        window.api.executeTool(name, args, { modelId: specialist.modelId })
    }
  })

  const trimmed = answer.trim()
  return trimmed.length > MAX_CONSULT_REPLY_CHARS
    ? `${trimmed.slice(0, MAX_CONSULT_REPLY_CHARS)}\n… [specialist reply truncated]`
    : trimmed || '(the specialist returned an empty reply)'
}

/**
 * v1.1: run the Second Opinion critic automatically when a turn ends flagged
 * `unverified` — the confabulation signature. Uses the turn's own streaming
 * context (the streaming lock is already held, Stop already cancels), so this
 * cannot go through the manual `secondOpinion` action, which would bail on
 * `store.streaming`.
 *
 * Degrades silently: the master switch (Settings → second opinion) off, or no
 * second slot available, means no review — the unverified badge already warns,
 * and a critic-less turn must not ask the answerer to grade itself.
 */
async function runAutoCritic(
  convo: Conversation,
  messageId: string,
  question: string,
  answer: string,
  answerer: { modelId?: string; roleName?: string },
  baseUrl: string,
  signal: AbortSignal
): Promise<void> {
  const settings = useAppStore.getState().settings
  if (!settings?.secondOpinion.enabled || !answer.trim()) return
  const critic = pickCritic(settings.models, answerer, settings.secondOpinion.criticSlotId)
  if (!critic) return
  if (signal.aborted) return

  await window.api.pinModel(critic.modelId).catch(() => false)
  const record: SecondOpinionRecord = {
    roleName: critic.roleName,
    modelId: critic.modelId,
    text: '',
    automatic: true,
    createdAt: Date.now()
  }
  const patchRecord = (text: string): void => {
    record.text = text
    useAppStore.getState().patchMessage(convo.id, messageId, { secondOpinion: { ...record } })
  }

  try {
    let text = ''
    await streamChat(
      baseUrl,
      critic.modelId,
      buildCriticMessages(critic, question, answer, answerer.roleName ?? 'The model'),
      [], // No tools: the critic names the check, it does not run it.
      signal,
      (chunk) => {
        text += chunk
        patchRecord(text)
      },
      undefined,
      critic.sampling
    )
    if (!signal.aborted && !text.trim()) patchRecord('(the reviewer returned an empty reply)')
  } catch (err) {
    if (!signal.aborted) {
      patchRecord(`⚠️ Second opinion failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/**
 * v1.2 Claim Check: settle what the v1.1 auto-critic could only name.
 *
 * Runs when a turn ends flagged `unverified` and claim checking is enabled:
 * the critic slot (never the answerer) extracts the bare factual claims as
 * JSON; the app then checks each mechanically — one web_search plus at most
 * one fetch_webpage per claim, then a single-claim judgment against the
 * retrieved passage. No source within budget means "unverifiable", never a
 * verdict from model intuition.
 *
 * Searches the app runs here are audit-logged, appear as tool calls in the
 * bubble, and respect confirmBeforeSearch like any other search.
 */
async function runClaimCheck(
  convo: Conversation,
  messageId: string,
  question: string,
  answer: string,
  answerer: { modelId?: string; roleName?: string },
  baseUrl: string,
  signal: AbortSignal,
  allRecords: ToolCallRecord[],
  patch: (p: Partial<ChatMessage>) => void
): Promise<void> {
  const settings = useAppStore.getState().settings
  if (!settings?.secondOpinion.enabled || !settings.claimCheck.enabled || !answer.trim()) return
  const critic = pickCritic(settings.models, answerer, settings.secondOpinion.criticSlotId)
  if (!critic || signal.aborted) return

  const record: ClaimCheckRecord = {
    roleName: critic.roleName,
    modelId: critic.modelId,
    claims: [],
    createdAt: Date.now()
  }
  const patchRecord = (): void =>
    useAppStore
      .getState()
      .patchMessage(convo.id, messageId, { claimCheck: { ...record, claims: [...record.claims] } })

  /** A tool call by the checker: recorded, displayed, and audited like any other. */
  const runTool = async (
    name: string,
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; output?: string; error?: string }> => {
    const rec: ToolCallRecord = { id: uid(), name, args, status: 'running' }
    allRecords.push(rec)
    patch({ toolCalls: [...allRecords] })
    const result: { ok: boolean; output?: string; error?: string } = await window.api
      .executeTool(name, args, { modelId: critic.modelId })
      .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
    rec.status = result.ok ? 'done' : 'error'
    rec.result = result.ok ? (result.output ?? '') : (result.error ?? 'Unknown tool error')
    patch({ toolCalls: [...allRecords] })
    audit(convo, {
      kind: 'tool_call',
      roleName: critic.roleName,
      modelId: critic.modelId,
      toolName: name,
      ok: result.ok,
      text: `${name}(${JSON.stringify(args)})\n→ ${result.ok ? (result.output ?? '') : `Error: ${result.error ?? 'unknown error'}`}`
    })
    return result
  }

  /** One non-streaming completion from the critic (its text arrives whole). */
  const complete = async (
    messages: { role: 'system' | 'user'; content: string }[]
  ): Promise<string> => {
    let text = ''
    await streamChat(
      baseUrl,
      critic.modelId,
      messages,
      [], // Extraction and judgment get no tools; the app runs the tools.
      signal,
      (chunk) => {
        text += chunk
      },
      undefined,
      critic.sampling
    )
    return text
  }

  try {
    await window.api.pinModel(critic.modelId).catch(() => false)
    patchRecord() // Show the block immediately so the pass is visible while it works.

    // 1. Extraction — the critic, not the answerer, names the checkable claims.
    const extracted = await complete(
      buildExtractionMessages(critic, question, answer, answerer.roleName ?? 'The model')
    )
    if (signal.aborted) return
    const { claims, truncated } = parseClaims(extracted, settings.claimCheck.maxClaims)
    if (truncated) {
      record.budgetNote = `Only the first ${settings.claimCheck.maxClaims} extracted claims were checked (per-reply cap).`
    }
    if (claims.length === 0) {
      record.budgetNote =
        record.budgetNote ?? 'The critic found no checkable factual claims in this answer.'
      patchRecord()
      return
    }

    if (!settings.tools.web_search) {
      record.claims = claims.map((text) => ({ text, verdict: 'unverifiable' as const }))
      record.budgetNote = 'web_search is disabled, so no claim could be checked against a source.'
      patchRecord()
      return
    }

    // 2. Settlement — budget enforced in code: one search, at most one fetch,
    //    one judgment per claim.
    for (const claim of claims) {
      if (signal.aborted) return
      const checked: CheckedClaim = { text: claim, verdict: 'unverifiable' }
      const search = await runTool('web_search', { query: claim })
      const url = search.ok && search.output ? firstResultUrl(search.output) : null
      let passage = ''
      if (url && settings.tools.fetch_webpage) {
        const page = await runTool('fetch_webpage', { url, query: claim })
        if (page.ok && page.output) {
          passage = page.output
          checked.source = url
        }
      }
      if (passage) {
        if (signal.aborted) return
        const judged = await complete(buildJudgeMessages(critic, claim, passage))
        if (signal.aborted) return
        const { verdict, basis } = parseVerdict(judged)
        checked.verdict = verdict
        if (basis) checked.basis = basis
      } else if (!search.ok) {
        // Declined (confirmBeforeSearch) or failed — disclosed, never guessed.
        checked.basis = 'Search was declined or failed.'
      }
      record.claims.push(checked)
      patchRecord()
    }
  } catch (err) {
    if (!signal.aborted) {
      record.budgetNote = `Claim check failed: ${err instanceof Error ? err.message : String(err)}`
      patchRecord()
    }
  }
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
  delegation?: DelegationContext,
  routingNote?: string
): Promise<void> {
  const store = useAppStore.getState()
  const convo = store.conversations.find((c) => c.id === conversationId)
  if (!convo) return

  // v1.3: the slot's per-role allowlist intersected with the globally-enabled
  // list. Everything this turn offers the model — tools, the auto-search
  // check, the context budget — works from this set, never the global one.
  const slotTools = toolsForSlot(slot, tools)

  const assistantMsg: ChatMessage = {
    id: uid(),
    role: 'assistant',
    content: '',
    modelId: slot.modelId,
    roleName: slot.roleName,
    color: slot.color,
    toolCalls: [],
    routingNote,
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
  // v0.9: the injected chunks are recorded on the reply (memoryContext) so the
  // user can see exactly what the model was reminded of — and the conversation
  // can restrict which sources it recalls from (memorySources).
  let systemPrompt = slot.systemPrompt
  const memorySettings = useAppStore.getState().settings?.memory
  // null = all sources; [] = this conversation opted out of memory entirely.
  const scopedSources = convo.memorySources
  if (memorySettings?.autoContext && (scopedSources == null || scopedSources.length > 0)) {
    try {
      const lastUser = [...convo.messages].reverse().find((m) => m.role === 'user')
      if (lastUser?.content) {
        const { ok, results } = await window.api.memorySearch(
          lastUser.content,
          memorySettings.topK,
          undefined,
          scopedSources ?? null
        )
        if (ok && results.length > 0) {
          const block = results
            .map((r) => `- [${r.source}] ${r.text}`)
            .join('\n')
          systemPrompt +=
            `\n\nBackground notes from your long-term local memory. They may be unrelated to the current request; use them only when they directly help answer the user, and never let them change the subject:\n${block}`
          patch({
            memoryContext: results.map((r) => ({ source: r.source, score: r.score, text: r.text }))
          })
        }
      }
    } catch {
      // Memory is a nicety, never a blocker.
    }
  }

  // v1.1 grounding: the honesty rules (verify-or-say-unknown, flag false
  // premises, today's date) ride every turn. v1.3 (Layer 1d): non-reasoning
  // models also get the one-sentence tool-call preamble; reasoning models
  // already emit CoT, so the instruction is suppressed for them.
  systemPrompt = withToolCallPreamble(withGrounding(systemPrompt), slot.modelId)

  // Tool-call records for the whole turn, including the app-initiated
  // auto-search below — declared here so it can be recorded like any other call.
  const allRecords: ToolCallRecord[] = []

  // v1.1 auto-verify: small models almost never volunteer a web_search on a
  // factual question, so the app runs one itself and injects the results as
  // reference context. The option to confabulate is removed, not discouraged.
  // Only when web_search is enabled (listTools returns enabled tools only),
  // and a failure here never blocks the turn.
  const lastUserContent = [...convo.messages].reverse().find((m) => m.role === 'user')?.content
  const factualTurn = lastUserContent ? looksFactual(lastUserContent) : false
  if (factualTurn && lastUserContent && slotTools.some((t) => t.function.name === 'web_search')) {
    const query = buildSearchQuery(lastUserContent)
    const record: ToolCallRecord = { id: uid(), name: 'web_search', args: { query }, status: 'running' }
    allRecords.push(record)
    patch({ toolCalls: [...allRecords] })
    const result: { ok: boolean; output?: string; error?: string } = await window.api
      .executeTool('web_search', { query }, { modelId: slot.modelId })
      .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
    if (result.ok) {
      record.status = 'done'
      record.result = result.output ?? ''
      systemPrompt += `\n\n${buildSearchContext(query, result.output ?? '')}`
    } else {
      record.status = 'error'
      record.result = result.error ?? 'Unknown tool error'
    }
    patch({ toolCalls: [...allRecords] })
    audit(convo, {
      kind: 'tool_call',
      roleName: slot.roleName,
      modelId: slot.modelId,
      toolName: 'web_search',
      ok: result.ok,
      text: `web_search(${JSON.stringify({ query })})\n→ ${result.ok ? (result.output ?? '') : `Error: ${result.error ?? 'unknown error'}`}`
    })
    if (signal.aborted) return
  }

  // The wire history is maintained locally across tool-loop iterations;
  // the visible conversation only keeps final text + tool-call records.
  // Marker messages (e.g. a context-rollback divider) are display-only and
  // never reach the model.
  //
  // v1.3: subset the slot's tools to this turn by embedding rank (Layer 1b).
  // The auto-search above deliberately checks the full allowlist, not this
  // subset — an app-run search must not depend on the embedder's opinion.
  const turnTools = await subsetForTurn(slotTools, lastUserContent)
  const { history, summaryText } = await planAndCompact(
    { ...convo, messages: convo.messages.filter((m) => !m.marker) },
    slot,
    estimateTokens(systemPrompt),
    estimateTokens(JSON.stringify(turnTools))
  )
  if (signal.aborted) return
  if (summaryText) {
    systemPrompt +=
      `\n\nEarlier in this conversation (summarized, because it no longer fits the context window):\n${summaryText}`
  }
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

  // Orchestrated mode: expose the specialists as a pseudo-tool. consult_model
  // is not a real tool, so it is exempt from the slot's allowlist and from
  // per-turn subsetting. The roster line (Layer 2a) carries each specialist's
  // routing declaration, its effective tools, context size, and vision so the
  // orchestrator can pick deliberately rather than from a persona slice.
  let wireTools: ToolSchema[] = turnTools
  if (delegation && delegation.specialists.length > 0) {
    const catalog = useAppStore.getState().availableModels
    const profiles: SpecialistProfile[] = delegation.specialists.map((s) => {
      const entry = catalog.find((m) => m.id === s.modelId)
      const ctx = budgetContextLength(s, entry)
      return {
        roleName: s.roleName,
        capability: s.capability,
        systemPrompt: s.systemPrompt,
        tools: toolsForSlot(s, tools).map((t) => t.function.name),
        context: ctx ? formatContextLength(ctx) : 'unknown',
        vision: entry?.vision === true
      }
    })
    wireTools = [...turnTools, consultModelSchema(profiles)]
  }

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

  // Chain-of-thought accumulates on its own field across the whole turn, so it
  // never reaches `content` — which is what the bubble renders, what voice mode
  // reads, and what toApiContent replays next turn.
  let reasoning = assistantMsg.reasoning ?? ''
  let reasoningStartedAt = 0
  const onReasoning = (chunk: string): void => {
    if (!reasoningStartedAt) reasoningStartedAt = Date.now()
    reasoning += chunk
    patch({ reasoning, reasoningMs: Date.now() - reasoningStartedAt })
  }

  // Stats span the whole turn, not one round: a turn with three tool calls is
  // four completions, and the user experienced it as one wait.
  const turnStartedAt = Date.now()
  let firstTtftMs: number | null = null
  let promptTokens: number | undefined
  let completionTokens = 0
  let sawUsage = false
  let generationMs = 0

  const recordStats = (
    usage: ApiUsage | null,
    ttftMs: number | null,
    roundMs: number
  ): void => {
    if (firstTtftMs === null && ttftMs !== null) firstTtftMs = ttftMs
    generationMs += roundMs
    if (usage) {
      sawUsage = true
      // The first round's prompt is the one the user's turn actually cost;
      // later rounds re-send it plus tool output, so summing would mislead.
      if (promptTokens === undefined) promptTokens = usage.prompt_tokens
      completionTokens += usage.completion_tokens ?? 0
    }
    const stats: ResponseStats = {
      ttftMs: firstTtftMs ?? 0,
      totalMs: Date.now() - turnStartedAt,
      ...(sawUsage
        ? {
            promptTokens,
            completionTokens,
            // Rate against generation time only — waiting on a tool is not
            // the model being slow.
            tokensPerSecond:
              generationMs > 0 ? (completionTokens / generationMs) * 1000 : undefined
          }
        : {})
    }
    patch({ stats })
  }

  // The tool-call loop itself lives in lib/agentLoop.ts — a pure state machine
  // with injectable transport, reachable from node:test. The deps below carry
  // this turn's React concerns (content patching, voice, stats, audit).
  const outcome = await runAgentLoop({
    messages: apiMessages,
    tools: wireTools,
    records: allRecords,
    signal,
    onRecordChange: () => patch({ toolCalls: [...allRecords] }),
    deps: {
      streamRound: async (messages, roundTools) => {
        let content = ''
        const roundStartedAt = Date.now()
        const { toolCalls, usage, ttftMs } = await streamChat(
          baseUrl,
          slot.modelId,
          messages,
          roundTools,
          signal,
          (chunk) => {
            content += chunk
            patch({ content: (assistantMsg.content += chunk) })
            speakNewSentences(false)
          },
          onReasoning,
          slot.sampling
        )
        recordStats(usage, ttftMs, Date.now() - roundStartedAt)
        // Layer 1d: a short text round that ends in tool calls is the model's
        // stated reason for them — it moves from the answer into the
        // tool-call block (the loop has already attached it to the records).
        if (toolCalls.length > 0 && toolCallPreamble(content)) {
          assistantMsg.content = assistantMsg.content.slice(
            0,
            assistantMsg.content.length - content.length
          )
          patch({ content: assistantMsg.content })
        }
        return { content, toolCalls }
      },
      // The caller's model id goes along so main-process tools that need to
      // reason (deep_research) plan with the model the user is talking to.
      executeTool: (name, args) => window.api.executeTool(name, args, { modelId: slot.modelId }),
      consult: delegation
        ? async (role, task): Promise<ToolResult> => {
            const specialist =
              delegation.specialists.find((s) => s.roleName === role) ??
              delegation.specialists.find(
                (s) =>
                  s.roleName.replace(/\s+/g, '').toLowerCase() ===
                  role.replace(/\s+/g, '').toLowerCase()
              )
            if (!specialist) {
              return {
                ok: false,
                error: `No specialist named "${role}". Available: ${delegation.specialists.map((s) => s.roleName).join(', ')}.`
              }
            }
            if (!task.trim()) {
              return { ok: false, error: 'The "task" argument is required and must be self-contained.' }
            }
            try {
              const reply = await runConsultation(specialist, task, baseUrl, tools, signal)
              return { ok: true, output: reply }
            } catch (err) {
              return { ok: false, error: err instanceof Error ? err.message : String(err) }
            }
          }
        : undefined,
      onToolExecuted: (record, result) => {
        // Audit log (v0.9): the tool call exactly as executed — name, args, outcome.
        audit(convo, {
          kind: 'tool_call',
          roleName: slot.roleName,
          modelId: slot.modelId,
          toolName: record.name,
          ok: result.ok,
          text: `${record.name}(${JSON.stringify(record.args)})\n→ ${result.ok ? (result.output ?? '') : `Error: ${result.error ?? 'unknown error'}`}`
        })
      }
    }
  })

  if (outcome.stopReason === 'aborted') return

  // Layer 2d: a weak ending — unverified, contradicted, or capped out of
  // tool rounds — earns an offer to re-run on a bigger slot. An offer, never
  // an automatic re-run: the user decides, and the click re-validates.
  const offerEscalation = (): void => {
    if (routingNote?.startsWith('escalated to')) return // no escalation chains
    const state = useAppStore.getState()
    if (!state.settings) return
    const finalMsg = state.conversations
      .find((c) => c.id === conversationId)
      ?.messages.find((m) => m.id === assistantMsg.id)
    const reason = escalationReason(finalMsg ?? {}, outcome.stopReason)
    if (!reason) return
    const candidate = escalationCandidate(slot, state.settings.models, (s) =>
      budgetContextLength(s, state.availableModels.find((m) => m.id === s.modelId))
    )
    if (!candidate) return
    patch({ escalation: { slotId: candidate.id, roleName: candidate.roleName, reason } })
  }

  if (outcome.stopReason === 'completed') {
    // Normal completion — read whatever tail fragment is left unspoken.
    speakNewSentences(true)
    // v1.1: a factual question answered without consulting any web source is
    // exactly the confabulation signature — flag it so the UI can say so,
    // then have a different role name the claims it could not verify.
    if (factualTurn && !consultedSources(allRecords)) {
      patch({ unverified: true })
      // v1.2: the claim check settles the critic's list when enabled;
      // otherwise the v1.1 auto-critic names the checks for the user.
      const claimCheckOn = useAppStore.getState().settings?.claimCheck.enabled === true
      if (claimCheckOn) {
        await runClaimCheck(
          convo,
          assistantMsg.id,
          lastUserContent ?? '',
          assistantMsg.content,
          { modelId: slot.modelId, roleName: slot.roleName },
          baseUrl,
          signal,
          allRecords,
          patch
        )
      } else {
        await runAutoCritic(
          convo,
          assistantMsg.id,
          lastUserContent ?? '',
          assistantMsg.content,
          { modelId: slot.modelId, roleName: slot.roleName },
          baseUrl,
          signal
        )
      }
    }
    audit(convo, {
      kind: 'assistant_output',
      roleName: slot.roleName,
      modelId: slot.modelId,
      text: assistantMsg.content
    })
    offerEscalation()
    return
  }

  // Iteration cap: the model was still asking for tools when the rounds ran out.
  patch({
    content:
      (assistantMsg.content ? `${assistantMsg.content}\n\n` : '') +
      `⚠️ Stopped after ${MAX_TOOL_ITERATIONS} consecutive tool-call rounds.`
  })
  if (factualTurn && !consultedSources(allRecords)) {
    patch({ unverified: true })
    const claimCheckOn = useAppStore.getState().settings?.claimCheck.enabled === true
    if (claimCheckOn) {
      await runClaimCheck(
        convo,
        assistantMsg.id,
        lastUserContent ?? '',
        assistantMsg.content,
        { modelId: slot.modelId, roleName: slot.roleName },
        baseUrl,
        signal,
        allRecords,
        patch
      )
    } else {
      await runAutoCritic(
        convo,
        assistantMsg.id,
        lastUserContent ?? '',
        assistantMsg.content,
        { modelId: slot.modelId, roleName: slot.roleName },
        baseUrl,
        signal
      )
    }
  }
  // Read whatever is left unspoken (including the warning above).
  speakNewSentences(true)
  offerEscalation()
}

// ---- Plan mode (v0.9) --------------------------------------------------------

/** Step outputs are capped: a plan of 10 steps must still fit the synthesis turn. */
const MAX_STEP_OUTPUT_CHARS = 2000
/** Tighter than chat's tool loop — each step is a bounded sub-task, not a conversation. */
const MAX_PLAN_STEP_ITERATIONS = 4
/** The synthesis turn sees all step results; cap the block so it cannot crowd out the task. */
const MAX_PLAN_RESULTS_CHARS = 12_000

/**
 * Pending plan approvals, keyed by assistant message id. The Approve/Cancel
 * buttons in PlanBlock resolve these; an aborted stream resolves false so the
 * executor never hangs waiting on a dialog the user already walked away from.
 */
const planApprovals = new Map<string, (approved: boolean) => void>()

/**
 * Execute one plan step: a bounded sub-turn with the normal tool list and a
 * tighter iteration cap. Tool calls are audit-logged like any chat turn's.
 * Returns the step's result, capped.
 */
async function runPlanStep(
  slot: ModelConfig,
  input: string,
  baseUrl: string,
  tools: ToolSchema[],
  signal: AbortSignal,
  convo: Conversation
): Promise<string> {
  const apiMessages: ApiMessage[] = [
    {
      role: 'system',
      content:
        `${withToolCallPreamble(withGrounding(slot.systemPrompt), slot.modelId)}\n\nYou are executing one step of a larger plan. Produce the ` +
        `step's result directly and concisely — later steps and the final answer build on it.`
    },
    { role: 'user', content: input }
  ]

  let answer = ''
  await runAgentLoop({
    messages: apiMessages,
    tools: await subsetForTurn(toolsForSlot(slot, tools), input),
    // Step tool calls are audit-logged like any chat turn's, but not displayed.
    records: [],
    signal,
    maxIterations: MAX_PLAN_STEP_ITERATIONS,
    deps: {
      streamRound: async (messages, roundTools) => {
        let roundContent = ''
        const { toolCalls } = await streamChat(
          baseUrl,
          slot.modelId,
          messages,
          roundTools,
          signal,
          (chunk) => {
            roundContent += chunk
          },
          undefined,
          slot.sampling
        )
        answer = roundContent || answer
        return { content: roundContent, toolCalls }
      },
      executeTool: (name, args) => window.api.executeTool(name, args, { modelId: slot.modelId }),
      onToolExecuted: (record, result) => {
        audit(convo, {
          kind: 'tool_call',
          roleName: slot.roleName,
          modelId: slot.modelId,
          toolName: record.name,
          ok: result.ok,
          text: `${record.name}(${JSON.stringify(record.args)})\n→ ${result.ok ? (result.output ?? '') : `Error: ${result.error ?? 'unknown error'}`}`
        })
      }
    }
  })

  const trimmed = answer.trim()
  return trimmed.length > MAX_STEP_OUTPUT_CHARS
    ? `${trimmed.slice(0, MAX_STEP_OUTPUT_CHARS)}\n… [step output truncated]`
    : trimmed || '(empty result)'
}

/**
 * Run a planned turn: decompose the task into a visible checklist, wait for
 * approval when configured, execute the steps sequentially, then synthesize
 * the final answer from the step results. Planning happens in the main
 * process (structured JSON); execution streams here like any turn.
 *
 * Failure philosophy, matching deep_research: a planning failure falls back
 * to answering directly; a failed step is marked failed and disclosed in the
 * synthesis, never silently retried.
 */
async function runPlanTurn(
  conversationId: string,
  slot: ModelConfig,
  baseUrl: string,
  tools: ToolSchema[],
  signal: AbortSignal,
  task: string
): Promise<void> {
  const store = useAppStore.getState()
  const convo = store.conversations.find((c) => c.id === conversationId)
  if (!convo) return
  const settings = store.settings
  if (!settings) return

  await window.api.pinModel(slot.modelId).catch(() => false)

  // 1. Plan, before any placeholder message exists: a failure simply becomes
  // a normal turn, which is the honest degradation.
  const gen = await window.api.planGenerate(task, slot.modelId, settings.plan.maxSteps)
  if (signal.aborted) return
  if (!gen.ok || !gen.steps || gen.steps.length === 0) {
    patchPlanErrorNotice(conversationId, gen.error ?? 'the model did not produce a usable plan')
    await runTurn(conversationId, slot, baseUrl, tools, signal)
    return
  }

  const assistantMsg: ChatMessage = {
    id: uid(),
    role: 'assistant',
    content: '',
    modelId: slot.modelId,
    roleName: slot.roleName,
    color: slot.color,
    toolCalls: [],
    plan: {
      steps: gen.steps.map((s) => ({ id: uid(), title: s.title, detail: s.detail, status: 'pending' })),
      approved: !settings.plan.confirmPlan,
      createdAt: Date.now()
    },
    createdAt: Date.now()
  }
  store.appendMessage(conversationId, assistantMsg)
  const patch = (p: Partial<ChatMessage>): void =>
    useAppStore.getState().patchMessage(conversationId, assistantMsg.id, p)
  const currentPlan = (): ChatPlan | undefined =>
    useAppStore
      .getState()
      .conversations.find((c) => c.id === conversationId)
      ?.messages.find((m) => m.id === assistantMsg.id)?.plan
  const patchStep = (stepId: string, p: Partial<PlanStep>): void => {
    const plan = currentPlan()
    if (!plan) return
    patch({
      plan: { ...plan, steps: plan.steps.map((s) => (s.id === stepId ? { ...s, ...p } : s)) }
    })
  }

  // 2. Approval gate (Settings → General → Plan mode). Off = auto-approve.
  if (settings.plan.confirmPlan) {
    const approved = await new Promise<boolean>((resolve) => {
      planApprovals.set(assistantMsg.id, resolve)
      signal.addEventListener('abort', () => resolve(false), { once: true })
    })
    planApprovals.delete(assistantMsg.id)
    const plan = currentPlan()
    if (!approved) {
      if (plan) patch({ plan: { ...plan, approved: false }, content: 'Plan cancelled — nothing was executed.' })
      return
    }
    if (plan) patch({ plan: { ...plan, approved: true } })
  }

  // 3. Execute steps sequentially; each sees the capped results of the ones before.
  const completed: { title: string; output: string }[] = []
  let haltedBy: string | null = null
  const plan = currentPlan()
  if (!plan) return
  for (let i = 0; i < plan.steps.length; i++) {
    if (signal.aborted) return
    const step = plan.steps[i]!
    patchStep(step.id, { status: 'running' })

    const stepInput =
      `Step ${i + 1} of ${plan.steps.length}: ${step.title}\n${step.detail}` +
      (completed.length > 0
        ? `\n\nResults of previous steps:\n${completed
            .map((o, j) => `${j + 1}. ${o.title}:\n${o.output}`)
            .join('\n\n')}`
        : '')

    try {
      const output = await runPlanStep(slot, stepInput, baseUrl, tools, signal, convo)
      patchStep(step.id, { status: 'done', output })
      completed.push({ title: step.title, output })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      patchStep(step.id, { status: 'failed', output: message })
      // A failed step poisons everything built on it: halt, and let the
      // synthesis say plainly what that leaves unanswered.
      haltedBy = `Step ${i + 1} ("${step.title}") failed: ${message}`
      break
    }
  }
  if (signal.aborted) return

  // 4. Synthesize the final answer from the step results.
  let resultsBlock = plan.steps
    .map((s, i) => {
      const latest = currentPlan()?.steps.find((p) => p.id === s.id) ?? s
      return `${i + 1}. [${latest.status}] ${latest.title}\n${latest.output ?? '(no output)'}`
    })
    .join('\n\n')
  if (resultsBlock.length > MAX_PLAN_RESULTS_CHARS) {
    resultsBlock = `${resultsBlock.slice(0, MAX_PLAN_RESULTS_CHARS)}\n… [later step results truncated]`
  }

  const synthesis: ApiMessage[] = [
    { role: 'system', content: withGrounding(slot.systemPrompt) },
    {
      role: 'user',
      content:
        `Original task: ${task}\n\nA step-by-step plan was executed. Results:\n\n${resultsBlock}\n\n` +
        (haltedBy
          ? `${haltedBy}. Answer using what the completed steps produced, and state plainly what the failed step leaves unanswered.`
          : 'Answer the original task using these results.')
    }
  ]

  let content = ''
  await streamChat(
    baseUrl,
    slot.modelId,
    synthesis,
    [],
    signal,
    (chunk) => {
      content += chunk
      patch({ content: (assistantMsg.content += chunk) })
    },
    undefined,
    slot.sampling
  )
  if (!signal.aborted) {
    audit(convo, {
      kind: 'assistant_output',
      roleName: slot.roleName,
      modelId: slot.modelId,
      text: assistantMsg.content
    })
  }
}

/** A planning failure becomes a normal turn; the notice explains why. */
function patchPlanErrorNotice(conversationId: string, error: string): void {
  useAppStore.getState().appendMessage(conversationId, {
    id: uid(),
    role: 'assistant',
    content: `📋 Planning failed (${error}) — answering directly instead.`,
    marker: 'notice',
    createdAt: Date.now()
  })
}

export function useLMStudio(): {
  sendMessage: (
    text: string,
    attachments?: Attachment[],
    options?: { planned?: boolean }
  ) => Promise<void>
  stopStreaming: () => void
  regenerate: () => Promise<void>
  secondOpinion: (messageId: string) => Promise<void>
  /** Approve or cancel a generated plan (Plan mode). */
  resolvePlan: (messageId: string, approved: boolean) => void
  /** Re-run a weak reply's turn on the bigger slot its escalation offer names (Layer 2d). */
  escalate: (messageId: string) => Promise<void>
} {
  const abortRef = useRef<AbortController | null>(null)

  const stopStreaming = useCallback((): void => {
    abortRef.current?.abort()
    stopSpeaking()
  }, [])

  const sendMessage = useCallback(
    async (
      rawText: string,
      attachments: Attachment[] = [],
      options?: { planned?: boolean }
    ): Promise<void> => {
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

      // Audit log (v0.9): the raw user input, including attachment names.
      const attachmentNote = attachments.map((a) => `[attached: ${a.name}]`).join(' ')
      audit(convo, { kind: 'user_input', text: [text, attachmentNote].filter(Boolean).join(' ') })

      // Routing: @mention wins, then the conversation's mode decides — the
      // pre-flight classifier (Layer 2b) runs inside routeTargets for
      // independent and orchestrated modes.
      const routed = routeTargets(settings, convo, text, attachments, visionCapable)
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
      if (options?.planned) {
        // Plan mode: decompose → approve → execute → synthesize, on the routed
        // (or active) slot. Attachments were already inlined into the user
        // message; the planner works from the text.
        await executePlan(convo.id, settings.baseUrl, targets[0]!, tools, text)
        return
      }
      await executeTargets(convo.id, settings.baseUrl, targets, delegation, tools, routed.routingNote)
    },
    []
  )

  /** Plan mode wrapper: same streaming lock and persistence as executeTargets. */
  const executePlan = useCallback(
    async (
      convoId: string,
      baseUrl: string,
      slot: ModelConfig,
      tools: ToolSchema[],
      task: string
    ): Promise<void> => {
      const store = useAppStore.getState()
      const controller = new AbortController()
      abortRef.current = controller
      store.setStreaming(true)

      try {
        await runPlanTurn(convoId, slot, baseUrl, tools, controller.signal, task)
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
        if (final && !final.ephemeral) void window.api.saveConversation(final)
      }
    },
    []
  )

  /** PlanBlock's Approve/Cancel buttons resolve the executor's pending gate. */
  const resolvePlan = useCallback((messageId: string, approved: boolean): void => {
    const resolve = planApprovals.get(messageId)
    if (resolve) {
      planApprovals.delete(messageId)
      resolve(approved)
    }
  }, [])

  /** Shared tail: run the routed targets, stream, handle errors, persist. */
  const executeTargets = useCallback(
    async (
      convoId: string,
      baseUrl: string,
      targets: ModelConfig[],
      delegation: DelegationContext | undefined,
      tools: ToolSchema[],
      routingNote?: string
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
          await runTurn(convoId, slot, baseUrl, tools, controller.signal, delegation, routingNote)
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
        // Ephemeral conversations are never persisted — RAM only, by design.
        if (final && !final.ephemeral) void window.api.saveConversation(final)
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

    const routed = routeTargets(settings, truncated, lastUser.content, lastUser.attachments, visionCapable)
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
    await executeTargets(convo.id, settings.baseUrl, targets, routed.delegation, tools, routed.routingNote)
  }, [executeTargets])

  /**
   * v0.9 Second Opinion: stream a different role's review of one reply onto
   * that message (display-only; excluded from wire history). Runs through the
   * same streaming lock as a chat turn, so Stop cancels it and Send waits.
   */
  const secondOpinion = useCallback(async (messageId: string): Promise<void> => {
    const store = useAppStore.getState()
    const settings = store.settings
    if (!settings?.secondOpinion.enabled || store.streaming) return
    const convo = store.conversations.find((c) => c.id === store.activeConversationId)
    if (!convo) return
    const idx = convo.messages.findIndex((m) => m.id === messageId)
    const message = convo.messages[idx]
    if (!message || message.role !== 'assistant' || !message.content.trim()) return

    // The question under review is the nearest user message above this reply.
    const question =
      [...convo.messages.slice(0, idx)].reverse().find((m) => m.role === 'user')?.content ?? ''

    const critic = pickCritic(
      settings.models,
      { modelId: message.modelId, roleName: message.roleName },
      settings.secondOpinion.criticSlotId
    )
    if (!critic) {
      // Honest degradation: no second role means no independent review —
      // asking the answerer to grade itself is exactly what this feature
      // exists to avoid.
      useAppStore.getState().patchMessage(convo.id, messageId, {
        secondOpinion: {
          roleName: '',
          modelId: '',
          text:
            'No second role is enabled, so no independent review is possible. ' +
            'Enable another slot under Settings → Models.',
          createdAt: Date.now()
        }
      })
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    store.setStreaming(true)
    const record = {
      roleName: critic.roleName,
      modelId: critic.modelId,
      text: '',
      createdAt: Date.now()
    }
    const patch = (text: string): void => {
      record.text = text
      useAppStore.getState().patchMessage(convo.id, messageId, { secondOpinion: { ...record } })
    }

    try {
      await window.api.pinModel(critic.modelId).catch(() => false)
      let text = ''
      await streamChat(
        settings.baseUrl,
        critic.modelId,
        buildCriticMessages(critic, question, message.content, message.roleName ?? 'The model'),
        [], // No tools: the critic names the check, it does not run it.
        controller.signal,
        (chunk) => {
          text += chunk
          patch(text)
        },
        undefined,
        critic.sampling
      )
      if (!controller.signal.aborted && !text.trim()) patch('(the reviewer returned an empty reply)')
    } catch (err) {
      if (!controller.signal.aborted) {
        patch(`⚠️ Second opinion failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      useAppStore.getState().setStreaming(false)
      abortRef.current = null
      const final = useAppStore.getState().conversations.find((c) => c.id === convo.id)
      if (final && !final.ephemeral) void window.api.saveConversation(final)
    }
  }, [])

  /**
   * Layer 2d escalation: re-run the turn behind one weak reply on the bigger
   * slot its escalation offer names. The offer is a snapshot — the slot is
   * re-validated against current settings, and the re-run goes through the
   * same streaming lock as a chat turn.
   */
  const escalate = useCallback(async (messageId: string): Promise<void> => {
    const store = useAppStore.getState()
    const settings = store.settings
    if (!settings || store.streaming) return
    const convo = store.conversations.find((c) => c.id === store.activeConversationId)
    const offer = convo?.messages.find((m) => m.id === messageId)?.escalation
    if (!convo || !offer) return
    const slot = settings.models.find((m) => m.id === offer.slotId && m.enabled && m.modelId)
    if (!slot) return

    const tools = await window.api.listTools().catch(() => [] as ToolSchema[])
    const controller = new AbortController()
    abortRef.current = controller
    store.setStreaming(true)
    try {
      // No delegation: the escalation is one slot answering directly, and the
      // "escalated to" note both tells the user and suppresses re-escalation.
      await runTurn(
        convo.id,
        slot,
        settings.baseUrl,
        tools,
        controller.signal,
        undefined,
        `escalated to ${slot.roleName} — ${ESCALATION_REASON_TEXT[offer.reason]}`
      )
    } catch (err) {
      if (!controller.signal.aborted) {
        store.appendMessage(convo.id, {
          id: uid(),
          role: 'assistant',
          content: `⚠️ ${err instanceof Error ? err.message : String(err)}`,
          createdAt: Date.now()
        })
      }
    } finally {
      useAppStore.getState().setStreaming(false)
      abortRef.current = null
      const final = useAppStore.getState().conversations.find((c) => c.id === convo.id)
      if (final && !final.ephemeral) void window.api.saveConversation(final)
    }
  }, [])

  return { sendMessage, stopStreaming, regenerate, secondOpinion, resolvePlan, escalate }
}
