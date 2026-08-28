import { useCallback } from 'react'
import { useAppStore } from '../stores/appStore'
import { stopSpeaking, enqueueSpeech, extractCompleteSentences } from '../lib/voice'
import { estimateTokens } from '../lib/contextBudget'
import { budgetContextLength, formatContextLength } from '../lib/modelInfo'
import { toolsForSlot, withBudgetNotes } from '../lib/toolSelection'
import { buildCriticMessages, NO_REVIEW_TEXT, pickCritic } from '../lib/secondOpinion'
import {
  buildTurnContext,
  consultedSources,
  looksFactual,
  looksReference,
  needsVerification,
  stripTurnNotesEcho,
  TURN_CONTEXT_HEADER,
  withGrounding,
  withToolCallPreamble
} from '../lib/grounding'
import { checkToolGrounding, conflictingToolFigures } from '../lib/toolGrounding'
import { composeFailure, explainFailure } from '../../../shared/failure'
import { looksLikeShopping } from '../lib/shopping'
import { isOffline } from '../lib/libraryRecall'
import { attachmentFileRefs, TABULAR_FILE } from '../lib/attachmentRecall'
import { projectInstructionsBlock } from '../lib/projectContext'
import { TURN_CONTEXT_PROVIDERS, gatherTurnContext } from '../lib/contextProviders'
import {
  createVerifyBudget,
  gatheringPhase,
  verifyingPhase,
  VERIFY_BUDGET_MS,
  type VerifyStep
} from '../lib/turnPhase'
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
import { makeTailStream, newWitness, streamChat } from './chatTransport'
import {
  audit,
  planAndCompact,
  subsetForTurn,
  toApiContent,
  turnRequestEstimate,
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
  runRecompute,
  settleRevision
} from './verification'
import { describeCodeCheck, looksArithmetic } from '../lib/workbenchChecks'
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
  let systemPrompt = withToolCallPreamble(
    withGrounding(slot.systemPrompt + projectBlock, new Date(), { offline }),
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
  const toolContext = { modelId: slot.modelId, attachments: fileRefs, conversationId: convo.id }
  const forcedTools = fileRefs.some((f) => TABULAR_FILE.test(f.name)) ? ['run_python', 'analyze_file'] : []
  const turnToolsPending = subsetForTurn(slotTools, lastUserContent, conversationId, forcedTools)

  // Tool-call records for the whole turn, including app-initiated provider
  // calls — declared here so the providers and the agent loop share one list.
  const allRecords: ToolCallRecord[] = []
  // One tool ledger for the whole turn: provider pre-flight calls and loop
  // calls share budgets and repeat detection (the old bypass asymmetry).
  const turnLedger = createTurnToolLedger()

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
  let reasoning = assistantMsg.reasoning ?? ''
  let reasoningStartedAt = 0
  const onReasoning = (chunk: string): void => {
    if (!reasoningStartedAt) reasoningStartedAt = Date.now()
    reasoning += chunk
    patch({ reasoning, reasoningMs: Date.now() - reasoningStartedAt })
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
      signal,
      onRecordChange: () => patch({ toolCalls: [...allRecords] }),
      deps: {
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
    await tail.finish(signal.aborted)
    // v1.17.3: and record how it ended, on the same three paths. `signal` is
    // the OUTER controller — the watchdog aborts its own inner one — so
    // `signal.aborted` here means the user pressed Stop and nothing else does.
    patch({
      ending: {
        accepted: witness.accepted,
        streamed: witness.streamed,
        produced: assistantMsg.content.trim() !== '' || reasoning.trim() !== '',
        stoppedByUser: signal.aborted,
        silentMs: Date.now() - witness.lastActivityAt
      }
    })
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

  /**
   * v1.12.5: the deadline over everything from here to the composer being
   * released. It starts at the last token — the only thing between that and
   * the first costly pass is a regex — so what it bounds is exactly the wait
   * the reader is held through with no answer to the question "how long?".
   *
   * `signal` rides along, so Stop still stops the checking; only an expiry
   * leaves a notice.
   */
  const budget = createVerifyBudget(VERIFY_BUDGET_MS, signal)
  /** Stopped by the user, or stopped by the deadline — both leave the answer standing. */
  const stopped = (): boolean => signal.aborted || budget.signal.aborted

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
  type CodeCheck = Awaited<ReturnType<typeof runCodeCheck>>
  const codeCheckMemo = new Map<string, CodeCheck>()
  const codeFindingFor = async (content: string): Promise<CodeCheck> => {
    if (!workbenchChecksOn) return { finding: null, ran: false, ok: false }
    const hit = codeCheckMemo.get(content)
    if (hit) return hit
    if (!budget.admits('code')) return { finding: null, ran: false, ok: false }
    const out = await runCodeCheck(convo, slot, content, allRecords, toolContext, () => patch({ toolCalls: [...allRecords] }))
    budget.ran('code')
    codeCheckMemo.set(content, out)
    return out
  }
  /**
   * The report as it stands against the records the turn holds **now**.
   *
   * Every rung's corpus is `allRecords` read at the moment of the call, so a
   * report is only ever true of the turn as it was when it was built. Re-read
   * it, do not carry it — `settleRevision` carries what carrying it cost.
   *
   * Re-running is cheap and cannot lose a finding. `checkToolGrounding` is a
   * pure pass over text, and the code check is memoised on `content`, so
   * restating a report the turn has already built re-uses that finding rather
   * than re-running the sandbox — and does so whether or not the deadline has
   * since expired.
   */
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
    // v1.12: two numeric tools disagreeing about the same labelled figure in
    // this turn (market_data said +14.61%, the model's python said -8.99%,
    // measured live). Disclosed, not adjudicated — the model may well have
    // relayed the right one, but the disagreement should not be silent.
    if (!checks.some((c) => c.kind === 'conflict')) {
      for (const conflict of conflictingToolFigures(allRecords)) {
        checks.push({
          kind: 'conflict',
          ok: false,
          summary: `⚖️ Tools disagree: ${conflict} — say which one the answer uses and why.`
        })
      }
      if (checks.some((c) => c.kind === 'conflict')) patch({ checks: [...checks] })
    }
    // v1.6 code check, disclosed whether or not it found anything.
    const firstCode = await codeFindingFor(assistantMsg.content)
    if (firstCode.ran || firstCode.note === 'the code needs input, files or the network, so it cannot be checked in the sandbox') {
      checks.push(describeCodeCheck({ ran: firstCode.ran, ok: firstCode.ok, finding: firstCode.finding, note: firstCode.note, compared: firstCode.compared }))
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
    // `admits` counts what it is asked about, so it goes last: the budget must
    // not record a pass this turn was never going to run.
    if (
      workbenchChecksOn &&
      lastUserContent &&
      !stopped() &&
      looksArithmetic(allUserText(), assistantMsg.content) &&
      (!numericRan || (report?.figures.length ?? 0) > 0) &&
      budget.admits('recompute')
    ) {
      checks.push(
        await runRecompute(convo, slot, baseUrl, lastUserContent, assistantMsg.content, allRecords, toolContext, budget.signal, () =>
          patch({ toolCalls: [...allRecords] })
        )
      )
      // Only a pass that got to finish counts as run: `reviseAgainstFindings`
      // and `runRecompute` both swallow an abort and return, so their returning
      // is not on its own evidence that the reader got the check.
      if (!budget.signal.aborted) budget.ran('recompute')
      patch({ checks: [...checks] })
      report = await groundingReport()
    }
    if (!report) return
    const autoCorrect = useAppStore.getState().settings?.grounding.autoCorrect !== false
    if (!autoCorrect || stopped() || !budget.admits('revising')) {
      patch({ grounding: report })
      return
    }

    verifying('revising')
    const before = assistantMsg.content
    const revised = await reviseAgainstFindings(
      slot,
      baseUrl,
      tools,
      budget.signal,
      convo,
      before,
      report,
      allRecords,
      () => patch({ toolCalls: [...allRecords] })
    )
    if (!budget.signal.aborted) budget.ran('revising')

    // Provisionally adopt the revision so the checker sees it, then keep it
    // only if it actually reduced what can be faulted. Measured against the
    // live model: a correction that swapped two invented addresses for two
    // different invented addresses, and added a claim that the rest had been
    // "verified against search results" when nothing had run.
    const original = assistantMsg.content
    if (revised.trim() && !stopped()) assistantMsg.content = revised
    // v2.3: every report the verdict reads is graded HERE, after the pass — the
    // revision's own tool calls have joined `allRecords` by now, so `report`
    // above is a claim about the turn as it was before them. `settleRevision`
    // carries the measured case and the argument.
    const verdict = await settleRevision({
      draft: original,
      revised,
      abandoned: stopped(),
      grade: groundingReport
    })
    if (verdict.keep === 'draft') {
      assistantMsg.content = original
      patch({ content: original, grounding: verdict.grounding ?? undefined })
      return
    }
    // The revision's code ran clean where the draft's did not: say so — but the
    // comparison rides along (memoised, no second run), so "the revised code
    // runs" cannot become the tick over a figure its output contradicts.
    if (verdict.corrected.before.code?.length && !verdict.corrected.after?.code?.length) {
      const i = checks.findIndex((c) => c.kind === 'code')
      const line = describeCodeCheck({ ran: true, ok: false, revisedRuns: true, compared: (await codeFindingFor(revised)).compared })
      if (i >= 0) checks[i] = line
      else checks.push(line)
    }
    // Both reports, not just the first. The revision was kept because it
    // reduced the findings, which is not the same as clearing them — what
    // survived is the half the disclosure line most needs to say.
    patch({
      content: revised,
      corrected: { ...verdict.corrected, at: Date.now() },
      grounding: verdict.grounding ?? undefined,
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

  /**
   * Everything after the last token, under one deadline, ending in a number
   * the reader can trust.
   *
   * Both endings — a completed answer and one that ran out of tool rounds —
   * ran a byte-identical copy of this, which is how a bound added to one could
   * have missed the other.
   */
  const runVerificationTail = async (): Promise<void> => {
    try {
      // v1.1: a factual question answered without consulting any web source is
      // exactly the confabulation signature — flag it so the UI can say so,
      // then have a different role name the claims it could not verify.
      if (checkableTurn && !consultedSources(allRecords)) {
        patch({ unverified: true })
        verifying('claims')
        // v1.2: the claim check settles the critic's list when enabled;
        // otherwise the v1.1 auto-critic names the checks for the user.
        const claimCheckOn = useAppStore.getState().settings?.claimCheck.enabled === true
        if (budget.admits('claims')) {
          if (claimCheckOn) {
            await runClaimCheck(
              convo,
              assistantMsg.id,
              lastUserContent ?? '',
              assistantMsg.content,
              { modelId: slot.modelId, roleName: slot.roleName },
              baseUrl,
              budget.signal,
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
              budget.signal
            )
          }
          if (!budget.signal.aborted) budget.ran('claims')
        }
      }
      verifying('grounding')
      await checkGrounding()
    } finally {
      budget.stop()
    }
    // The deadline fired and it cost the reader something: name it, rather than
    // letting a check the app skipped look like a check that passed.
    const notice = budget.notice()
    if (notice) {
      checks.push(notice)
      patch({ checks: [...checks] })
    }
    // The tail is over, so the turn's real length is finally known. `totalMs`
    // stays the stream — tok/s is a rate of that — and this is what the reader
    // actually waited, from the turn's open rather than from the first request
    // (lib/turnCost.ts).
    if (lastStats) patch({ stats: { ...lastStats, turnMs: Date.now() - turnOpenedAt } })
    verifying(null)
  }

  if (outcome.stopReason === 'completed') {
    // Normal completion — read whatever tail fragment is left unspoken.
    speakNewSentences(true)
    await runVerificationTail()
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
  await runVerificationTail()
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
            content: `⚠️ ${composeFailure(explainFailure(err, { subject: 'The turn', request: turnRequestEstimate(convoId) }))}`,
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
            content: `⚠️ ${composeFailure(explainFailure(err, { subject: 'The turn', request: turnRequestEstimate(convoId) }))}`,
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
      if (!controller.signal.aborted && !text.trim()) patch(NO_REVIEW_TEXT)
    } catch (err) {
      if (!controller.signal.aborted) {
        patch(`⚠️ ${composeFailure(explainFailure(err, { subject: 'The second opinion' }))}`)
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
          content: `⚠️ ${composeFailure(explainFailure(err, { subject: 'The escalated turn' }))}`,
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
