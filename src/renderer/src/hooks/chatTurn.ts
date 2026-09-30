import { useAppStore } from '../stores/appStore'
import { enqueueSpeech, extractCompleteSentences } from '../lib/voice'
import { estimateTokens } from '../lib/contextBudget'
import { budgetContextLength, formatContextLength } from '../lib/modelInfo'
import { bridgeToolsForSlot, toolsForSlot, withBudgetNotes } from '../lib/toolSelection'
import {
  buildTurnContext,
  looksFactual,
  looksReference,
  needsVerification,
  webToolsForTurn,
  withGrounding,
  withToolCallPreamble
} from '../lib/grounding'
import { looksLikeShopping } from '../lib/shopping'
import { isOffline } from '../lib/libraryRecall'
import { attachmentFileRefs, TABULAR_FILE } from '../lib/attachmentRecall'
import { projectInstructionsBlock, slotRulesBlock } from '../lib/projectContext'
import { TURN_CONTEXT_PROVIDERS, gatherTurnContext } from '../lib/contextProviders'
import type { ToolExecuteContext } from '../lib/contextProviders'
import { noteToolResult } from '../lib/taint'
import { gatheringPhase, verifyingPhase, type VerifyStep } from '../lib/turnPhase'
import { makeProviderIO } from './providerIO'
import {
  consultModelSchema,
  createTurnToolLedger,
  runAgentLoop,
  toolCallPreamble,
  MAX_TOOL_ITERATIONS,
  TOOL_TURN_BUDGETS,
  type ApiMessage,
  type ApiUsage,
  type SpecialistProfile
} from '../lib/agentLoop'
import type {
  ChatMessage,
  ModelConfig,
  ResponseStats,
  ToolCallRecord,
  ToolResult,
  ToolSchema
} from '../types'
import { makeTailStream, newWitness, streamChat } from './chatTransport'
import { audit, planAndCompact, subsetForTurn, toApiContent, uid } from './turnHelpers'
import { runConsultation } from './verification'
import { vibeSystemBlock } from '../lib/vibe'
import { turnThinking } from '../lib/quickReply'
import { offerEscalation, startTurnTail } from './turnTail'

/**
 * One model's turn (v3.1: out of useLMStudio.ts): its system prompt, the
 * context providers, the history it fits, the stream and the tool loop, then
 * the tail (hooks/turnTail.ts). Moved verbatim; the hook decides which turns
 * run and in what order — routing, plans, outlines, deliberation, escalation,
 * Stop — and calls this for each.
 */

// ---- Orchestration: models-as-tools -------------------------------------------

export interface DelegationContext {
  specialists: ModelConfig[]
}

/**
 * Stop was pressed before the request left the app.
 *
 * v1.17.3. The turn can bail at two points before `streamChat` is reached — a
 * context provider was cancelled mid-flight, or compaction returned after the
 * abort — and both leave an empty bubble. Without a record of that, the bubble
 * falls back to admitting it does not know how the turn ended, which is honest
 * but needlessly so: the app does know, and `accepted: false` is exactly how it
 * says the server was never asked.
 */
function stoppedBeforeSending(
  patch: (p: Partial<ChatMessage>) => void,
  turnOpenedAt: number
): void {
  patch({
    ending: {
      accepted: false,
      streamed: false,
      // No request went out, so no reply ran to its end. The Stop branch reads
      // `accepted` before this, but recording it any other way would be a lie
      // sitting in the store waiting for a reader.
      completed: false,
      produced: false,
      stoppedByUser: true,
      silentMs: Date.now() - turnOpenedAt
    }
  })
}

/**
 * Run one model's turn: stream a reply, execute any requested tools, feed the
 * results back, and repeat until the model stops calling tools.
 */
export async function runTurn(
  conversationId: string,
  slot: ModelConfig,
  baseUrl: string,
  tools: ToolSchema[],
  signal: AbortSignal,
  delegation?: DelegationContext,
  routingNote?: string,
  /**
   * v1.4: false suppresses the response cache for this turn. Regenerate replays
   * a byte-identical history, so a cache hit would hand back the same answer and
   * make the button look broken — asking again is the one case where the user
   * has explicitly said they want a different reply.
   */
  cacheable = true
): Promise<void> {
  const store = useAppStore.getState()
  const convo = store.conversations.find((c) => c.id === conversationId)
  if (!convo) return

  /**
   * v1.12.6: the turn's one origin — the moment the reader's wait begins.
   *
   * Everything below this line is the turn: pinning the model, the context
   * providers, the stream, the checks. `turnStartedAt` further down is the
   * STREAM's origin and is stamped after the providers have returned, so
   * measuring the turn from it silently drops however long they took — 8.8 s
   * on the recorded TTU1 runs, all of it the app's own web_search running
   * before the model was asked anything (lib/turnCost.ts).
   */
  const turnOpenedAt = Date.now()

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
  const tail = makeTailStream(assistantMsg, patch)
  // v2.7: the reader can see that the slot's standing rules rode this turn.
  if (slot.rules?.trim()) patch({ rulesApplied: true })
  /**
   * Name the wait (lib/turnPhase.ts). Both ends of a turn make the user wait
   * on work the model is not doing — the pre-model providers below, and the
   * checks that run after the last token — and both used to be silent. The
   * verifying phases are also what unlock the finished reply's action row.
   */
  const verifying = (step: VerifyStep | null): void =>
    useAppStore.getState().setTurnPhase(step ? verifyingPhase(assistantMsg.id, step) : null)

  // Pin before the memory RAG below: its embedding call JIT-loads the
  // embedding model, and LM Studio's default auto-evict would unload this
  // slot's model in response — an eject/reload cycle on every turn. After the
  // append so the ripple covers a cold model load, which a first-turn pin
  // waits for.
  await window.api.pinModel(slot.modelId).catch(() => false)

  // v1.1 grounding: the honesty rules (verify-or-say-unknown, flag false
  // premises, today's date) ride every turn. v1.3 (Layer 1d): non-reasoning
  // models also get the one-sentence tool-call preamble; reasoning models
  // already emit CoT, so the instruction is suppressed for them.
  //
  // v1.5: this is now the whole system prompt, and it is deliberately stable
  // from turn to turn — see lib/grounding.ts on why the per-turn additions
  // below go at the end of the user's message instead of here.
  // v1.5: offline swaps the "verify with web_search" rule for the reference
  // library, and the badge below says "offline" rather than implying neglect.
  const offline = isOffline()
  // v1.10: the project's standing instructions ride the system prompt — stable
  // for the life of the project, so they sit with the role prompt rather than
  // in the per-turn context.
  const project =
    (convo.projectId && store.settings?.projects.find((p) => p.id === convo.projectId)) || null
  const projectBlock = projectInstructionsBlock(project)
  // v2.7: persona, then the slot's standing rules, then the project's — three
  // layers, all stable from turn to turn.
  // v3.0: VIBE's one line rides here, after the project's instructions — the
  // system prompt, not the turn's notes; lib/vibe.ts has the measurement.
  let systemPrompt = withToolCallPreamble(
    withGrounding(
      slot.systemPrompt + slotRulesBlock(slot) + projectBlock + vibeSystemBlock(useAppStore.getState().settings?.vibeMode),
      new Date(),
      { offline }
    ),
    slot.modelId
  )
  // What the project spent this turn, for the details panel (estimates).
  const projectTokens = { instructions: estimateTokens(projectBlock), recall: 0, files: 0 }

  const lastUserContent = [...convo.messages].reverse().find((m) => m.role === 'user')?.content
  // The user message before this one anchors context-dependent follow-ups
  // ("lets go with the first one") — shared by the search, library and
  // shopping providers.
  const userMessages = convo.messages.filter((m) => m.role === 'user')
  const previousUserContent =
    userMessages.length > 1 ? userMessages[userMessages.length - 2].content : undefined

  // v1.6: files the Workbench may stage under /work for this turn's tools —
  // and with a data file in the conversation the Workbench tools must be on
  // the wire whatever the embedding rank says, because the app is about to
  // tell the model to compute with them.
  const fileRefs = attachmentFileRefs(convo)
  const toolContext: ToolExecuteContext = { modelId: slot.modelId, attachments: fileRefs, conversationId: convo.id }
  // v4.0.1: and a turn about the live world, or one that asks for the web by
  // name, carries the web tools on the same terms (lib/grounding.ts
  // `webToolsForTurn`) — offline excepted, where there is no web to reach.
  const forcedTools = [
    ...(fileRefs.some((f) => TABULAR_FILE.test(f.name)) ? ['run_python', 'analyze_file'] : []),
    ...(offline ? [] : webToolsForTurn(lastUserContent))
  ]
  const turnToolsPending = subsetForTurn(slotTools, lastUserContent, conversationId, forcedTools)

  // Tool-call records for the whole turn, including app-initiated provider
  // calls — declared here so the providers and the agent loop share one list.
  const allRecords: ToolCallRecord[] = []
  // One tool ledger for the whole turn: provider pre-flight calls and loop
  // calls share budgets and repeat detection (the old bypass asymmetry).
  const turnLedger = createTurnToolLedger()

  // v2.7 Code Mode: a program in the sandbox asks for a tool through the
  // bridge and the decision is made here, on this turn's own list and
  // ledger — the slot's allowlist minus the sandbox's own tools, the same
  // per-turn budget the loop charges, the same executeTool, a record filed
  // under the program's call, an audit line prefixed [code mode].
  const bridgeTools = new Set(bridgeToolsForSlot(slot, tools).map((t) => t.function.name))
  const unsubscribeInner = window.api.onInnerToolCall(async (call) => {
    let result: ToolResult
    if (!bridgeTools.has(call.name)) {
      result = { ok: false, error: `Tool "${call.name}" is not available to this program.` }
    } else {
      const budget = TOOL_TURN_BUDGETS[call.name]
      const used = turnLedger.executedCounts.get(call.name) ?? 0
      if (budget !== undefined && used >= budget) {
        result = { ok: false, error: `Budget: ${call.name} has been called ${used} time(s) this turn, its limit. Work with what you have.` }
      } else {
        result = await window.api
          .executeTool(call.name, call.args, toolContext)
          .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
        turnLedger.note(call.name, call.args, result)
        noteToolResult(toolContext, call.name, result)
      }
    }
    const record: ToolCallRecord = {
      id: uid(),
      name: call.name,
      args: call.args,
      status: result.ok ? 'done' : 'error',
      result: result.ok ? (result.output ?? '') : (result.error ?? 'Unknown tool error'),
      ...(call.parentCallId ? { parentCallId: call.parentCallId } : {})
    }
    allRecords.push(record)
    patch({ toolCalls: [...allRecords] })
    audit(convo, {
      kind: 'tool_call',
      roleName: slot.roleName,
      modelId: slot.modelId,
      toolName: call.name,
      ok: result.ok,
      text: `[code mode] ${call.name}(${JSON.stringify(call.args)})\n→ ${result.ok ? (result.output ?? '') : `Error: ${result.error ?? 'unknown error'}`}`
    })
    await window.api.innerToolResult(call.callId, result)
  })

  // Turn classifiers, shared by the context providers and the post-turn checks.
  const factualTurn = lastUserContent ? looksFactual(lastUserContent) : false
  const referenceTurn = lastUserContent ? looksReference(lastUserContent) : false
  const shoppingTurn = lastUserContent ? looksLikeShopping(lastUserContent) : false
  // The badge gate is wider than the search gate — see needsVerification.
  const checkableTurn = lastUserContent ? needsVerification(lastUserContent) : false

  // The pre-flight context blocks — auto search, library passages, playbook,
  // ledger, price check, memory/project/attachment recall, tabular profile —
  // are providers in a fixed-order registry (lib/contextProviders; STRATEGY-
  // harness-adoptions Tier 1.1). Prefetch providers start their embedding work
  // inside gatherTurnContext before any serial await, overlapping the search's
  // network wait exactly as the inline kickoffs did since v1.5. Block order is
  // registry order, pinned by test — the notes are prompt surface.
  const gathered = await gatherTurnContext(
    TURN_CONTEXT_PROVIDERS,
    {
      convo,
      conversations: useAppStore.getState().conversations,
      slot,
      slotTools,
      lastUserContent,
      previousUserContent,
      offline,
      factualTurn,
      referenceTurn,
      shoppingTurn,
      project,
      assistantMsgId: assistantMsg.id,
      signal
    },
    makeProviderIO({
      convo,
      slot,
      slotTools,
      toolContext,
      allRecords,
      ledger: turnLedger,
      patch,
      settings: () => useAppStore.getState().settings ?? null
    }),
    // The count on that line is of the whole pre-model wait, not of whichever
    // provider is holding it — the walk changes label, the reader's wait does
    // not (lib/turnPhase.ts).
    (wait) =>
      useAppStore
        .getState()
        .setTurnPhase(wait ? gatheringPhase(assistantMsg.id, wait, turnOpenedAt) : null)
  )
  // v1.17.3: Stop landed here — before the request went out at all. That is a
  // different sentence from "the model said nothing", and the bubble can only
  // say so if the turn records it (shared/failure.ts `explainEmptyReply`).
  if (gathered.aborted) return stoppedBeforeSending(patch, turnOpenedAt)
  if (offline) patch({ offline: true })
  projectTokens.recall = gathered.projectTokens.recall
  projectTokens.files = gathered.projectTokens.files
  /** The app's own additions for this turn, appended to the turn's user message. */
  // v2.7: a skill's helper files ride the turn's tool context, so run_python
  // and run_code find them under /work beside the conversation's attachments.
  if (gathered.attachments.length > 0) toolContext.attachments = [...fileRefs, ...gathered.attachments]
  const turnContext: string[] = gathered.blocks

  // The wire history is maintained locally across tool-loop iterations;
  // the visible conversation only keeps final text + tool-call records.
  // Marker messages (e.g. a context-rollback divider) are display-only and
  // never reach the model.
  //
  // v1.3: subset the slot's tools to this turn by embedding rank (Layer 1b).
  // The auto-search above deliberately checks the full allowlist, not this
  // subset — an app-run search must not depend on the embedder's opinion.
  const turnTools = await turnToolsPending
  const turnContextBlock = buildTurnContext(turnContext)
  const { history, summaryText } = await planAndCompact(
    { ...convo, messages: convo.messages.filter((m) => !m.marker) },
    slot,
    // Both are fixed overhead the history has to fit around, wherever they ride
    // on the wire.
    estimateTokens(systemPrompt) + estimateTokens(turnContextBlock ?? ''),
    estimateTokens(JSON.stringify(turnTools))
  )
  if (signal.aborted) return stoppedBeforeSending(patch, turnOpenedAt)
  if (summaryText) {
    // The summary stays in the system prompt rather than joining the per-turn
    // context: it changes only when compaction fires, and compaction has
    // already dropped messages by then, so the prefix was invalidated either
    // way. Between compactions this keeps it stable and in its natural place,
    // ahead of the history it stands in for.
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
  // The app's per-turn additions ride the turn's own user message, so that
  // everything before it is byte-identical to last turn's prompt and the
  // server can reuse its KV cache for all of it (lib/grounding.ts).
  if (turnContextBlock) {
    // +1 for the system message that history is offset by.
    const target = apiMessages[currentTurn + 1]
    // A multimodal turn takes the notes as one more text part, so the images
    // it carries are untouched.
    target.content = Array.isArray(target.content)
      ? [...target.content, { type: 'text', text: turnContextBlock }]
      : `${target.content ?? ''}${turnContextBlock}`
  }

  // Orchestrated mode: expose the specialists as a pseudo-tool. consult_model
  // is not a real tool, so it is exempt from the slot's allowlist and from
  // per-turn subsetting. The roster line (Layer 2a) carries each specialist's
  // routing declaration, its effective tools, context size, and vision so the
  // orchestrator can pick deliberately rather than from a persona slice.
  // The budget each tool carries this turn, stated in its own description so
  // the model plans within it instead of discovering it by refusal.
  let wireTools: ToolSchema[] = withBudgetNotes(turnTools, TOOL_TURN_BUDGETS)
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
  //
  // v4.1 (S3): through the paced tail, not a patch per chunk — the tail lands
  // it on the message at each round boundary and at the end (makeTailStream).
  let reasoning = assistantMsg.reasoning ?? ''
  let reasoningStartedAt = 0
  const onReasoning = (chunk: string): void => {
    if (!reasoningStartedAt) reasoningStartedAt = Date.now()
    reasoning += chunk
    tail.reasoning(reasoning, Date.now() - reasoningStartedAt)
  }

  // Stats span the whole turn, not one round: a turn with three tool calls is
  // four completions, and the user experienced it as one wait.
  //
  // This is the STREAM's origin, and the providers above have already run by
  // the time it is stamped — which is why it cannot also be the turn's.
  const turnStartedAt = Date.now()
  /** The pre-model wait, as the distance between the turn's two origins. */
  const gatherMs = turnStartedAt - turnOpenedAt
  let firstTtftMs: number | null = null
  let promptTokens: number | undefined
  let completionTokens = 0
  let sawUsage = false
  let generationMs = 0
  /**
   * The last figures the stream produced, kept so the tail can re-stamp them
   * with the turn's true length once it is over (lib/turnCost.ts).
   */
  let lastStats: ResponseStats | null = null
  /**
   * v2.4: the instant the answer stopped and the checking started — the origin
   * of the stat line's "checking" span, since that span is `turnMs − gatherMs −
   * totalMs` and `totalMs` is stamped here. The verification deadline counts
   * from the same instant, so "its 60s limit" and "Ns checking" are two
   * statements about one clock instead of two clocks a drain apart.
   */
  let answerEndedAt = 0

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
    answerEndedAt = Date.now()
    const stats: ResponseStats = {
      ttftMs: firstTtftMs ?? 0,
      totalMs: answerEndedAt - turnStartedAt,
      gatherMs,
      ...(project ? { projectTokens } : {}),
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
    lastStats = stats
    patch({ stats })
  }

  /**
   * v1.17.3: what the transport saw, so the turn can name who fell silent.
   *
   * One per turn rather than one per round: the question a reader is asking of
   * an empty bubble is about the whole turn, and the last round is the one that
   * ended it. It is read in the `finally` below, because the measured case —
   * a stall the user pressed Stop on — leaves this function by the throw.
   */
  const witness = newWitness()
  // v1.17.4: and the same record, published while the reader is still waiting
  // on it. The post-mortem above answers "who fell silent" once the turn is
  // over; the thinking indicator has to answer "what is happening right now"
  // at sixty seconds, off the same two facts, from the same one recorder.
  witness.onChange = (): void =>
    useAppStore.getState().setStreamWitness({
      messageId: assistantMsg.id,
      accepted: witness.round.accepted,
      streamed: witness.round.streamed
    })

  // The tool-call loop itself lives in lib/agentLoop.ts — a pure state machine
  // with injectable transport, reachable from node:test. The deps below carry
  // this turn's React concerns (content patching, voice, stats, audit).
  let outcome: Awaited<ReturnType<typeof runAgentLoop>>
  try {
    outcome = await runAgentLoop({
      messages: apiMessages,
      tools: wireTools,
      records: allRecords,
      // The providers already charged this ledger: an app-run search spends
      // web_search budget, and its byte-identical repeat is reused, not re-run.
      ledger: turnLedger,
      // v3.1: a greeting is answered without thinking first (lib/quickReply.ts).
      // v4.1 (S4): and the slot's thinking setting decides the rest.
      ...turnThinking(slot, lastUserContent),
      signal,
      onRecordChange: () => patch({ toolCalls: [...allRecords] }),
      deps: {
        // v2.7: what the user typed while the last round ran lands here, at
        // the round boundary, and the record says which round it preceded.
        takePendingMessages: () => useAppStore.getState().takeSteers(conversationId),
        onSteerDelivered: (steer, round) => {
          useAppStore.getState().patchMessage(conversationId, steer.id, { delivery: { state: 'delivered', round } })
          audit(convo, { kind: 'user_steer', text: `[before round ${round + 1}] ${steer.text}` })
        },
        streamRound: async (messages, roundTools) => {
          let content = ''
          // Per round, not per turn: the loop asks whether *this* round put its
          // answer on the wrong channel, and a previous round's thinking would
          // answer the wrong question.
          const reasoningBefore = reasoning.length
          const roundStartedAt = Date.now()
          const { toolCalls, usage, ttftMs, truncated } = await streamChat(
            baseUrl,
            slot.modelId,
            messages,
            roundTools,
            signal,
            (chunk) => {
              content += chunk
              assistantMsg.content += chunk
              tail.schedule()
              speakNewSentences(false)
            },
            onReasoning,
            slot.sampling,
            // The only cacheable call site: the user-facing answer. Every other
            // streamChat caller is a verification or delegation pass that has to
            // stay live.
            cacheable,
            witness
          )
          recordStats(usage, ttftMs, Date.now() - roundStartedAt)
          // A reply cut off at max_tokens stops mid-thought. Saying so is the
          // difference between a cap the user set and a model that trailed off.
          if (truncated) patch({ truncated: true })
          // Layer 1d: a short text round that ends in tool calls is the model's
          // stated reason for them — it moves from the answer into the
          // tool-call block (the loop has already attached it to the records).
          if (toolCalls.length > 0 && toolCallPreamble(content)) {
            assistantMsg.content = assistantMsg.content.slice(
              0,
              assistantMsg.content.length - content.length
            )
          }
          // Round boundary: land the accumulated content in the message.
          tail.commit()
          return { content, toolCalls, reasoning: reasoning.slice(reasoningBefore) }
        },
        // The caller's model id goes along so main-process tools that need to
        // reason (deep_research) plan with the model the user is talking to.
        executeTool: async (name, args, meta) => {
          // v2.7: a run_code call carries its own record id, so the calls its
          // program makes can be filed under it.
          // v2.8: a proposed patch's review renders under its own record, so it carries the id too.
          const result = await window.api.executeTool(name, args, meta?.callId && (name === 'run_code' || name === 'propose_patch') ? { ...toolContext, parentCallId: meta.callId } : toolContext)
          // v2.6: the turn is tainted from the first foreign result on; the
          // flag rides toolContext to every later call (lib/taint.ts).
          noteToolResult(toolContext, name, result)
          return result
        },
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
  } finally {
    // Release the tail however the loop ended — abort included. This also
    // lands whatever content had streamed, so a stopped reply keeps its text.
    //
    // v2.2: awaited, and that await is the fix for a turn that called itself
    // finished while the answer was still being painted. Everything below —
    // the checks, the phase labels, the action row, and the `setStreaming
    // (false)` in the caller that releases the composer and turns Stop back
    // into Send — now happens after the last character is on screen rather
    // than after the last byte is off the socket. Bounded: TAIL_DRAIN_MS on a
    // visible window, the 1500 ms backstop on an occluded one.
    //
    // Stop skips the wait entirely. The user asked for the turn to be over,
    // not to watch the rest of it type itself out, so the remainder lands in
    // one publish — which still keeps every character that had streamed.
    unsubscribeInner()
    await tail.finish(signal.aborted)
    // Nothing is in flight any more, so nothing may still be described as
    // being waited on. Released here rather than at the return, because the
    // measured case leaves this function by the throw.
    useAppStore.getState().setStreamWitness(null)
    // v1.17.3: and record how it ended, on the same three paths. `signal` is
    // the OUTER controller — the watchdog aborts its own inner one — so
    // `signal.aborted` here means the user pressed Stop and nothing else does.
    patch({
      ending: {
        accepted: witness.accepted,
        streamed: witness.streamed,
        // v1.17.5. Last-round-scoped, unlike the two above: the round that
        // ended the turn is the one whose ending is being described, and a
        // throw in round two is not made harmless by round one having finished.
        completed: witness.completed,
        produced: assistantMsg.content.trim() !== '' || reasoning.trim() !== '',
        stoppedByUser: signal.aborted,
        silentMs: Date.now() - witness.lastActivityAt
      }
    })
  }

  if (outcome.stopReason === 'aborted') return

  // v3.1: the tail lives in hooks/turnTail.ts. Started here, where its echo
  // scrub and deadline always began.
  const turnTail = startTurnTail({
    convo,
    slot,
    slotTools,
    tools,
    baseUrl,
    signal,
    assistantMsg,
    patch,
    verifying,
    allRecords,
    toolContext,
    lastUserContent,
    shoppingTurn,
    checkableTurn,
    answerEndedAt,
    lastStats,
    turnOpenedAt
  })
  const escalate = (): void =>
    offerEscalation({ conversationId, routingNote, stopReason: outcome.stopReason, slot, assistantMsg, patch })

  if (outcome.stopReason === 'completed') {
    // Normal completion — read whatever tail fragment is left unspoken.
    speakNewSentences(true)
    await turnTail.run()
    audit(convo, {
      kind: 'assistant_output',
      roleName: slot.roleName,
      modelId: slot.modelId,
      text: assistantMsg.content
    })
    escalate()
    return
  }

  // Iteration cap: the model was still asking for tools when the rounds ran out.
  patch({
    content:
      (assistantMsg.content ? `${assistantMsg.content}\n\n` : '') +
      `⚠️ Stopped after ${MAX_TOOL_ITERATIONS} consecutive tool-call rounds.`
  })
  await turnTail.run()
  // Read whatever is left unspoken (including the warning above).
  speakNewSentences(true)
  escalate()
}
