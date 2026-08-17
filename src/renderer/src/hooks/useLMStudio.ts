import { useCallback } from 'react'
import { useAppStore } from '../stores/appStore'
import { stopSpeaking, enqueueSpeech, extractCompleteSentences } from '../lib/voice'
import { estimateTokens } from '../lib/contextBudget'
import { budgetContextLength, formatContextLength } from '../lib/modelInfo'
import { toolsForSlot, withBudgetNotes } from '../lib/toolSelection'
import { buildCriticMessages, pickCritic } from '../lib/secondOpinion'
import {
  buildSearchContext,
  buildSearchQuery,
  buildTurnContext,
  consultedSources,
  looksFactual,
  looksReference,
  stripTurnNotesEcho,
  TURN_CONTEXT_HEADER,
  withGrounding,
  withToolCallPreamble
} from '../lib/grounding'
import { checkToolGrounding, revisionIsAnImprovement } from '../lib/toolGrounding'
import { looksLikeShopping, shoppingSubject } from '../lib/shopping'
import { buildPlaybookContext, selectPlaybook } from '../lib/playbooks'
import {
  LIBRARY_PASSAGES_PER_TURN,
  buildLibraryContext,
  isOffline,
  shouldConsultLibrary,
  toLibraryContextItems
} from '../lib/libraryRecall'
import {
  ATTACHMENT_PASSAGES_PER_TURN,
  attachmentFileRefs,
  buildAttachmentContext,
  indexedAttachmentRefs,
  TABULAR_FILE,
  tabularAttachmentsOnTurn,
  toAttachmentContextItems
} from '../lib/attachmentRecall'
import {
  consultModelSchema,
  runAgentLoop,
  toolCallPreamble,
  MAX_TOOL_ITERATIONS,
  TOOL_TURN_BUDGETS,
  type ApiMessage,
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
  Attachment,
  ChatMessage,
  Conversation,
  GroundingReport,
  ModelConfig,
  ResponseStats,
  ToolCallRecord,
  ToolResult,
  ToolSchema
} from '../types'
import { makeTailStream, streamChat } from './chatTransport'
import {
  audit,
  planAndCompact,
  subsetForTurn,
  toApiContent,
  uid,
  visionCapable
} from './turnHelpers'
import {
  reviseAgainstFindings,
  runAutoCritic,
  runClaimCheck,
  runCodeCheck,
  runConsultation,
  runDeliberation,
  runRecompute
} from './verification'
import {
  describeCodeCheck,
  looksArithmetic,
  revisionDropsAllFigures,
  revisionEchoesScaffolding
} from '../lib/workbenchChecks'
import { planApprovals, runPlanTurn } from './planMode'

/**
 * The engine: streams chat completions from LM Studio's OpenAI-compatible
 * API, runs the agentic tool-call loop, and routes messages — @mention to a
 * specific role, the active model in independent mode, or the whole chain in
 * collaborative pipeline mode. User messages may carry image and text-file
 * attachments, sent as multimodal content parts.
 */

// ---- Orchestration: models-as-tools -------------------------------------------

interface DelegationContext {
  specialists: ModelConfig[]
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
  let systemPrompt = withToolCallPreamble(
    withGrounding(slot.systemPrompt, new Date(), { offline }),
    slot.modelId
  )

  /** The app's own additions for this turn, appended to the turn's user message. */
  const turnContext: string[] = []

  const lastUserContent = [...convo.messages].reverse().find((m) => m.role === 'user')?.content

  // v1.5: both of the turn's embedding calls start here, before anything is
  // awaited. Memory recall and tool ranking are independent of each other and
  // of the auto-search between them, but ran strictly in sequence through v1.4
  // — three round trips end to end, two of them waiting on a model that was
  // idle. They now overlap each other and the search's network wait.
  const memorySettings = useAppStore.getState().settings?.memory
  // null = all sources; [] = this conversation opted out of memory entirely.
  const scopedSources = convo.memorySources
  const memoryRecall =
    memorySettings?.autoContext &&
    (scopedSources == null || scopedSources.length > 0) &&
    lastUserContent
      ? window.api
          .memorySearch(lastUserContent, memorySettings.topK, undefined, scopedSources ?? null)
          .catch(() => null)
      : null
  // v1.6: files the Workbench may stage under /work for this turn's tools —
  // and with a data file in the conversation the Workbench tools must be on
  // the wire whatever the embedding rank says, because the app is about to
  // tell the model to compute with them.
  const fileRefs = attachmentFileRefs(convo)
  const toolContext = { modelId: slot.modelId, attachments: fileRefs }
  const forcedTools = fileRefs.some((f) => TABULAR_FILE.test(f.name)) ? ['run_python', 'analyze_file'] : []
  const turnToolsPending = subsetForTurn(slotTools, lastUserContent, conversationId, forcedTools)

  // v1.4.8: attached documents longer than the inline limit live in the
  // session index; retrieve what this message needs from them. Started here so
  // it overlaps the other embedding calls, exactly like memory recall.
  const attachmentRefs = indexedAttachmentRefs(convo)
  const attachmentRecall =
    attachmentRefs.length > 0 && lastUserContent
      ? window.api
          .attachmentPassages(attachmentRefs, lastUserContent, ATTACHMENT_PASSAGES_PER_TURN)
          .catch(() => null)
      : null

  // Tool-call records for the whole turn, including the app-initiated
  // auto-search below — declared here so it can be recorded like any other call.
  const allRecords: ToolCallRecord[] = []

  // v1.1 auto-verify: small models almost never volunteer a web_search on a
  // factual question, so the app runs one itself and injects the results as
  // reference context. The option to confabulate is removed, not discouraged.
  // Only when web_search is enabled (listTools returns enabled tools only),
  // and a failure here never blocks the turn.
  const factualTurn = lastUserContent ? looksFactual(lastUserContent) : false
  // Offline the search cannot work; the library lookup below takes its place.
  if (factualTurn && !offline && lastUserContent && slotTools.some((t) => t.function.name === 'web_search')) {
    // The user message before this one anchors context-dependent follow-ups
    // ("lets go with the first one") so the query carries the topic too.
    const userMessages = convo.messages.filter((m) => m.role === 'user')
    const previousUserContent =
      userMessages.length > 1 ? userMessages[userMessages.length - 2].content : undefined
    const query = buildSearchQuery(lastUserContent, previousUserContent)
    const record: ToolCallRecord = { id: uid(), name: 'web_search', args: { query }, status: 'running' }
    allRecords.push(record)
    patch({ toolCalls: [...allRecords] })
    const result: { ok: boolean; output?: string; error?: string } = await window.api
      .executeTool('web_search', { query }, { modelId: slot.modelId })
      .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
    if (result.ok) {
      record.status = 'done'
      record.result = result.output ?? ''
      turnContext.push(buildSearchContext(query, result.output ?? ''))
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

  // v1.5: app-initiated reference lookup (STRATEGY-depth-and-reasoning.md,
  // Feature A). For the domains a reference book answers — first aid, health,
  // finance rules, legal, preparedness, home repair — and for any factual turn
  // while offline, the app consults the local library before the model speaks
  // and hands the passages over with their citations. Local and private, so
  // the trigger is broad; an empty library or no match injects nothing.
  const referenceTurn = lastUserContent ? looksReference(lastUserContent) : false
  const libraryOn = slotTools.some((t) => t.function.name === 'reference_lookup')
  if (
    lastUserContent &&
    shouldConsultLibrary({ enabled: libraryOn, reference: referenceTurn, factual: factualTurn, offline })
  ) {
    const userMessages = convo.messages.filter((m) => m.role === 'user')
    const previousUserContent =
      userMessages.length > 1 ? userMessages[userMessages.length - 2].content : undefined
    const query = buildSearchQuery(lastUserContent, previousUserContent)
    const looked = await window.api
      .libraryLookup(query, null, LIBRARY_PASSAGES_PER_TURN)
      .catch(() => null)
    if (looked?.ok && looked.passages.length > 0 && looked.formatted) {
      // Recorded like the auto-search: a tool-call record the user can open,
      // an audit line, and a source for the grounding check.
      const record: ToolCallRecord = {
        id: uid(),
        name: 'reference_lookup',
        args: { query },
        status: 'done',
        result: looked.formatted
      }
      allRecords.push(record)
      patch({ toolCalls: [...allRecords], libraryContext: toLibraryContextItems(looked.passages) })
      turnContext.push(buildLibraryContext(looked.formatted, offline))
      audit(convo, {
        kind: 'tool_call',
        roleName: slot.roleName,
        modelId: slot.modelId,
        toolName: 'reference_lookup',
        ok: true,
        text: `reference_lookup(${JSON.stringify({ query })})\n→ ${looked.formatted}`
      })
    }
    if (signal.aborted) return
  }
  if (offline) patch({ offline: true })

  // v1.5 playbooks: one short method for the kind of question, chosen by the
  // same domain classifiers, riding the turn notes after any passages so the
  // model reads the material first and the method for using it second.
  if (lastUserContent && useAppStore.getState().settings?.grounding.playbooks !== false) {
    const lastUser = [...convo.messages].reverse().find((m) => m.role === 'user')
    const playbook = selectPlaybook({
      text: lastUserContent,
      attachmentNames: (lastUser?.attachments ?? []).map((a) => a.name)
    })
    if (playbook) {
      turnContext.push(buildPlaybookContext(playbook))
      patch({ playbook: playbook.name })
    }
  }

  // v1.3 shopping intent (DESIGN-private-shopping §2e). Same reasoning as
  // the auto-search above, for the case where a wrong answer costs money: on
  // a purchase turn the app prices the thing mechanically, so the model has
  // real offers to write around instead of the option to recall a number.
  const shoppingTurn = lastUserContent ? looksLikeShopping(lastUserContent) : false
  const canCompare = slotTools.some((t) => t.function.name === 'shop_compare')
  if (shoppingTurn && canCompare && lastUserContent) {
    const userMessages = convo.messages.filter((m) => m.role === 'user')
    const previous =
      userMessages.length > 1 ? userMessages[userMessages.length - 2].content : undefined
    const product = shoppingSubject(lastUserContent, previous)
    if (product) {
      const record: ToolCallRecord = {
        id: uid(),
        name: 'shop_compare',
        args: { product },
        status: 'running'
      }
      allRecords.push(record)
      patch({ toolCalls: [...allRecords] })
      const result: { ok: boolean; output?: string; error?: string } = await window.api
        .executeTool('shop_compare', { product }, { modelId: slot.modelId })
        .catch((err: unknown) => ({
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        }))
      record.status = result.ok ? 'done' : 'error'
      record.result = result.ok ? (result.output ?? '') : (result.error ?? 'Unknown tool error')
      if (result.ok) {
        turnContext.push(buildSearchContext(`prices for "${product}"`, result.output ?? ''))
      }
      patch({ toolCalls: [...allRecords] })
      audit(convo, {
        kind: 'tool_call',
        roleName: slot.roleName,
        modelId: slot.modelId,
        toolName: 'shop_compare',
        ok: result.ok,
        text: `shop_compare(${JSON.stringify({ product })})\n→ ${result.ok ? (result.output ?? '') : `Error: ${result.error ?? 'unknown error'}`}`
      })
      if (signal.aborted) return
    }
  } else if (shoppingTurn) {
    // The comparison tools are off (they ship that way — they contact
    // commercial sites, which is the user's call to make). The option to
    // invent a price still has to go, so say so, and the grounding check
    // flags any price that appears anyway.
    turnContext.push(
      'This turn is a purchase decision and no price-checking tool is enabled. Do not state ' +
        'prices, discounts, or "typical" cost ranges — you have no source for them and a ' +
        'remembered price is a guess about a number that changes weekly. Say that price checking ' +
        'is off (Settings → Tools), describe the options qualitatively, and link only to pages ' +
        'that appeared in a tool result.'
    )
  }

  // RAG: fold the recalled memory into this turn's context (best effort).
  // v0.9: the injected chunks are recorded on the reply (memoryContext) so the
  // user can see exactly what the model was reminded of — and the conversation
  // can restrict which sources it recalls from (memorySources).
  //
  // Collected here rather than where the search was issued: the auto-search
  // above is the turn's longest wait, and there is no reason for the recall to
  // queue behind it when neither needs the other.
  if (memoryRecall) {
    try {
      const recalled = await memoryRecall
      if (recalled?.ok && recalled.results.length > 0) {
        const block = recalled.results.map((r) => `- [${r.source}] ${r.text}`).join('\n')
        turnContext.push(
          `Background notes from your long-term local memory. They may be unrelated to the current request; use them only when they directly help answer the user, and never let them change the subject:\n${block}`
        )
        patch({
          memoryContext: recalled.results.map((r) => ({
            source: r.source,
            score: r.score,
            text: r.text
          }))
        })
      }
    } catch {
      // Memory is a nicety, never a blocker.
    }
  }

  if (attachmentRecall) {
    try {
      const recalled = await attachmentRecall
      if (recalled?.ok) {
        const block = buildAttachmentContext(recalled.passages, recalled.notes)
        if (block) turnContext.push(block)
        if (recalled.passages.length > 0) {
          patch({ attachmentContext: toAttachmentContextItems(recalled.passages) })
        }
      }
    } catch {
      // Retrieval is best effort; the inline head still went through.
    }
  }

  // v1.6: a data file attached on this turn is profiled before the model
  // speaks — the "describe the data before analysing it" step of the data
  // playbook, done mechanically, so the model starts from the file's real
  // shape, types, ranges and a head instead of a slice of it. Recorded like
  // any tool call; the file stays available to run_python at /work/<name>.
  const tabular = tabularAttachmentsOnTurn(convo).slice(0, 2)
  if (tabular.length > 0 && slotTools.some((t) => t.function.name === 'analyze_file')) {
    for (const file of tabular) {
      const record: ToolCallRecord = { id: uid(), name: 'analyze_file', args: { file }, status: 'running' }
      allRecords.push(record)
      patch({ toolCalls: [...allRecords] })
      const result: { ok: boolean; output?: string; error?: string } = await window.api
        .executeTool('analyze_file', { file }, toolContext)
        .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      record.status = result.ok ? 'done' : 'error'
      record.result = result.ok ? (result.output ?? '') : (result.error ?? 'Unknown tool error')
      patch({ toolCalls: [...allRecords] })
      if (result.ok && result.output) {
        turnContext.push(
          `The app profiled the attached data file "${file}" before you answered (analyze_file). Use these facts; ` +
            'compute anything further with run_python on /work/' + file + ' rather than estimating from the head:\n' +
            result.output
        )
      }
      audit(convo, {
        kind: 'tool_call',
        roleName: slot.roleName,
        modelId: slot.modelId,
        toolName: 'analyze_file',
        ok: result.ok,
        text: `analyze_file(${JSON.stringify({ file })})\n→ ${result.ok ? (result.output ?? '') : `Error: ${result.error ?? 'unknown error'}`}`
      })
      if (signal.aborted) return
    }
  }

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
  if (signal.aborted) return
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
  let outcome: Awaited<ReturnType<typeof runAgentLoop>>
  try {
    outcome = await runAgentLoop({
      messages: apiMessages,
      tools: wireTools,
      records: allRecords,
      signal,
      onRecordChange: () => patch({ toolCalls: [...allRecords] }),
      deps: {
        streamRound: async (messages, roundTools) => {
          let content = ''
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
            cacheable
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
          return { content, toolCalls }
        },
        // The caller's model id goes along so main-process tools that need to
        // reason (deep_research) plan with the model the user is talking to.
        executeTool: (name, args) => window.api.executeTool(name, args, toolContext),
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
    tail.finish()
  }

  if (outcome.stopReason === 'aborted') return

  // Layer 2d: a weak ending — unverified, contradicted, or capped out of
  // tool rounds — earns an offer to re-run on a bigger slot. An offer, never
  // an automatic re-run: the user decides, and the click re-validates.
  // v1.3: did the reply actually use what the tools returned? Purely
  // mechanical (no model call, no network), so it runs on every finished turn
  // — including turns that consulted sources, which is exactly where a model
  // overriding a computed figure would otherwise pass unnoticed.
  // Every user message, not just this turn's: a budget stated four turns ago
  // is still the user's own number, and so is the arithmetic done on it.
  const allUserText = (): string =>
    convo.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n')

  // v1.6: the Workbench's code check joins the report. It is re-run on a
  // revision, so the gate compares like with like: a revision whose code now
  // runs has strictly fewer findings; one that merely rewords does not.
  const workbenchChecksOn =
    useAppStore.getState().settings?.grounding.workbenchChecks !== false &&
    slotTools.some((t) => t.function.name === 'run_python')
  const checks: NonNullable<ChatMessage['checks']> = []

  // v1.7: scrub a verbatim echo of the turn-notes scaffold before any check
  // reads the content (the eval caught a 9B opening its reply with the header
  // sentence). Mechanical, disclosed, and shares its marker with the prompt.
  {
    const scrub = stripTurnNotesEcho(assistantMsg.content)
    if (scrub.echoed) {
      if (scrub.text !== assistantMsg.content) {
        assistantMsg.content = scrub.text
        patch({ content: scrub.text })
      }
      checks.push({
        kind: 'echo',
        ok: scrub.text !== '' && !scrub.text.includes(TURN_CONTEXT_HEADER),
        summary: '🧾 The reply echoed the app’s internal turn notes; the echo was removed.'
      })
      patch({ checks: [...checks] })
    }
  }
  const codeCheckMemo = new Map<string, { finding: string | null; ran: boolean; ok: boolean; note?: string }>()
  const codeFindingFor = async (content: string): Promise<{ finding: string | null; ran: boolean; ok: boolean; note?: string }> => {
    if (!workbenchChecksOn) return { finding: null, ran: false, ok: false }
    const hit = codeCheckMemo.get(content)
    if (hit) return hit
    const out = await runCodeCheck(convo, slot, content, allRecords, toolContext, () => patch({ toolCalls: [...allRecords] }))
    codeCheckMemo.set(content, out)
    return out
  }
  const groundingReport = async (content = assistantMsg.content): Promise<GroundingReport | null> => {
    const base = checkToolGrounding(content, allRecords, allUserText(), { expectPricingTool: shoppingTurn })
    const code = await codeFindingFor(content)
    if (!code.finding) return base
    return { ...(base ?? { figures: [], links: [], checkedAgainst: ['run_python'] }), code: [code.finding] }
  }

  /**
   * v1.4.6: hand the findings back for one revision, then re-check.
   *
   * Only ever one pass. A second would be the model arguing with a regex, and
   * whatever survives the first correction is what the badge is for — the
   * point is to fix what can be fixed and disclose the rest, not to loop until
   * the checker is satisfied.
   */
  const checkGrounding = async (): Promise<void> => {
    // v1.6 code check, disclosed whether or not it found anything.
    const firstCode = await codeFindingFor(assistantMsg.content)
    if (firstCode.ran || firstCode.note === 'the code needs input, files or the network, so it cannot be checked in the sandbox') {
      checks.push(describeCodeCheck({ ran: firstCode.ran, ok: firstCode.ok, finding: firstCode.finding, note: firstCode.note }))
      patch({ checks: [...checks] })
    }
    let report = await groundingReport()

    // v1.6 recompute. Two cases, one action: figures were stated and nothing
    // computed them (no report can exist yet — the check has no corpus), or a
    // tool ran and does not support what was stated (measured: a correct
    // out-the-door price flagged because the model had misused the finance
    // calculator; the old path then revised the number away). Either way, ask
    // for a Python recomputation and re-check: figures it supports stop being
    // findings, and no revision is needed at all.
    const numericRan = allRecords.some(
      (r) => (r.name === 'run_python' || r.name === 'finance_calculator' || r.name === 'analyze_file') && r.status === 'done'
    )
    if (
      workbenchChecksOn &&
      lastUserContent &&
      !signal.aborted &&
      looksArithmetic(allUserText(), assistantMsg.content) &&
      (!numericRan || (report?.figures.length ?? 0) > 0)
    ) {
      checks.push(
        await runRecompute(convo, slot, baseUrl, lastUserContent, assistantMsg.content, allRecords, toolContext, signal, () =>
          patch({ toolCalls: [...allRecords] })
        )
      )
      patch({ checks: [...checks] })
      report = await groundingReport()
    }
    if (!report) return
    const autoCorrect = useAppStore.getState().settings?.grounding.autoCorrect !== false
    if (!autoCorrect || signal.aborted) {
      patch({ grounding: report })
      return
    }

    const before = assistantMsg.content
    const revised = await reviseAgainstFindings(
      slot,
      baseUrl,
      tools,
      signal,
      convo,
      before,
      report,
      allRecords
    )
    // A revision that came back empty, or that the user cancelled, leaves the
    // original standing: a flagged answer beats no answer.
    if (!revised.trim() || signal.aborted) {
      patch({ grounding: report })
      return
    }

    // Provisionally adopt the revision so the checker sees it, then keep it
    // only if it actually reduced what can be faulted. Measured against the
    // live model: a correction that swapped two invented addresses for two
    // different invented addresses, and added a claim that the rest had been
    // "verified against search results" when nothing had run.
    const original = assistantMsg.content
    assistantMsg.content = revised
    const after = await groundingReport(revised)
    // A revision that "fixes" flagged figures by deleting every figure from a
    // quantitative answer is not an improvement, it is a non-answer (measured:
    // a correct price replaced by "I could not verify…"). Keep the original,
    // flagged, and let the badge speak.
    if (
      revisionDropsAllFigures(original, revised) ||
      revisionEchoesScaffolding(revised) ||
      !revisionIsAnImprovement(report, after)
    ) {
      assistantMsg.content = original
      patch({ content: original, grounding: report })
      return
    }
    // The revision's code ran clean where the draft's did not: say so.
    if (report.code?.length && !after?.code?.length) {
      const i = checks.findIndex((c) => c.kind === 'code')
      const line = describeCodeCheck({ ran: true, ok: false, revisedRuns: true })
      if (i >= 0) checks[i] = line
      else checks.push(line)
    }
    patch({
      content: revised,
      corrected: { before: report, at: Date.now() },
      grounding: after ?? undefined,
      checks: [...checks]
    })
  }

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
    await checkGrounding()
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
  await checkGrounding()
  // Read whatever is left unspoken (including the warning above).
  speakNewSentences(true)
  offerEscalation()
}

/** The in-flight turn's AbortController — see the note inside useLMStudio(). */
const activeTurnAbort: { current: AbortController | null } = { current: null }

export function useLMStudio(): {
  sendMessage: (
    text: string,
    attachments?: Attachment[],
    options?: { planned?: boolean; deliberate?: boolean }
  ) => Promise<void>
  stopStreaming: () => void
  regenerate: () => Promise<void>
  secondOpinion: (messageId: string) => Promise<void>
  /** v1.5.1: draft → review → revise on an existing reply. */
  deliberate: (messageId: string) => Promise<void>
  /** Approve or cancel a generated plan (Plan mode). */
  resolvePlan: (messageId: string, approved: boolean) => void
  /** Re-run a weak reply's turn on the bigger slot its escalation offer names (Layer 2d). */
  escalate: (messageId: string) => Promise<void>
} {
  // Module-level, not useRef: every component that calls useLMStudio() must
  // share the one in-flight turn's controller. A useRef gave each caller its
  // own — regenerate/second-opinion/escalate ran from a MessageBubble and
  // stored their controller in that bubble's instance, so the composer's Stop
  // button aborted its own forever-null one. Only one turn streams at a time
  // (store.streaming gates entry), so a single shared slot is correct.
  const abortRef = activeTurnAbort

  const stopStreaming = useCallback((): void => {
    abortRef.current?.abort()
    stopSpeaking()
  }, [])

  const sendMessage = useCallback(
    async (
      rawText: string,
      attachments: Attachment[] = [],
      options?: { planned?: boolean; deliberate?: boolean }
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
      // v1.5.1 think harder: one review-and-revise pass on the reply just
      // produced (the last assistant message of this conversation).
      if (options?.deliberate) {
        const after = useAppStore.getState().conversations.find((c) => c.id === convo!.id)
        const last = after ? [...after.messages].reverse().find((m) => m.role === 'assistant') : undefined
        if (last && last.content.trim()) await deliberate(last.id)
      }
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
        await runPlanTurn(convoId, slot, baseUrl, tools, controller.signal, task, runTurn)
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
      routingNote?: string,
      /** v1.4: false on Regenerate, so asking again cannot return the cached reply. */
      cacheable = true
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
          await runTurn(
            convoId,
            slot,
            baseUrl,
            tools,
            controller.signal,
            delegation,
            routingNote,
            cacheable
          )
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
    // cacheable: false — Regenerate replays an identical history, so the cache
    // would hand back the very answer the user just rejected.
    await executeTargets(
      convo.id,
      settings.baseUrl,
      targets,
      routed.delegation,
      tools,
      routed.routingNote,
      false
    )
  }, [executeTargets])

  /**
   * v0.9 Second Opinion: stream a different role's review of one reply onto
   * that message (display-only; excluded from wire history). Runs through the
   * same streaming lock as a chat turn, so Stop cancels it and Send waits.
   */
  /**
   * v1.5.1 Think harder on an existing reply: draft → review by another slot
   * (or self, labelled) → revise, once. Runs under the shared abort handle so
   * Stop stops it.
   */
  const deliberate = useCallback(async (messageId: string): Promise<void> => {
    const store = useAppStore.getState()
    const settings = store.settings
    if (!settings || store.streaming) return
    const convo = store.conversations.find((c) => c.id === store.activeConversationId)
    if (!convo) return
    const idx = convo.messages.findIndex((m) => m.id === messageId)
    const message = convo.messages[idx]
    if (!message || message.role !== 'assistant' || !message.content.trim()) return
    const question =
      [...convo.messages.slice(0, idx)].reverse().find((m) => m.role === 'user')?.content ?? ''
    const answerer =
      settings.models.find((m) => m.modelId === message.modelId && m.roleName === message.roleName) ??
      settings.models.find((m) => m.enabled && m.modelId)
    if (!answerer) return
    const controller = new AbortController()
    abortRef.current = controller
    store.setStreaming(true)
    try {
      await runDeliberation(convo, messageId, question, message.content, answerer, settings.baseUrl, controller.signal)
    } finally {
      useAppStore.getState().setStreaming(false)
      abortRef.current = null
    }
  }, [])

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
        `escalated to ${slot.roleName} — ${ESCALATION_REASON_TEXT[offer.reason]}`,
        // Escalation is a retry of a turn that went badly; it must be fresh.
        false
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

  return { sendMessage, stopStreaming, regenerate, secondOpinion, deliberate, resolvePlan, escalate }
}
