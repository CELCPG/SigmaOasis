import { useCallback } from 'react'
import { useAppStore } from '../stores/appStore'
import { stopSpeaking } from '../lib/voice'
import { buildCriticMessages, NO_REVIEW_TEXT, pickCritic } from '../lib/secondOpinion'
import { withGrounding } from '../lib/grounding'
import { composeFailure, explainFailure } from '../../../shared/failure'
import { isOffline } from '../lib/libraryRecall'
import { slotRulesBlock } from '../lib/projectContext'
import { looksLikeDocumentAsk } from '../lib/playbooks'
import { routeTargets, ESCALATION_REASON_TEXT } from '../lib/routing'
import type { Attachment, ChatMessage, Conversation, ModelConfig, ToolSchema } from '../types'
import { streamChat } from './chatTransport'
import { audit, turnRequestEstimate, uid, visionCapable } from './turnHelpers'
import { runDeliberation } from './verification'
import { planApprovals, runPlanTurn } from './planMode'
import { outlineAllowed } from '../lib/vibe'
import { sendToAgent } from './agentTasks'
import { runTurn, type DelegationContext } from './chatTurn'

/**
 * The engine's front: routes messages — @mention to a specific role, the
 * active model in independent mode, or the whole chain in collaborative
 * pipeline mode — and runs plans, outlines, deliberation, second opinions and
 * escalation around them. User messages may carry image and text-file
 * attachments, sent as multimodal content parts.
 *
 * v3.1: each model's turn — the stream from LM Studio's OpenAI-compatible API
 * and the agentic tool-call loop — is hooks/chatTurn.ts, and what follows its
 * last token is hooks/turnTail.ts. Both moved out verbatim.
 */

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
      if ((!text && attachments.length === 0) || !settings) return
      // v3.0: an agent chat's message is a task (or a steer into a running
      // one) for the main process, never a chat turn — and it is not held
      // back by a chat turn streaming in another conversation.
      const target = store.conversations.find((c) => c.id === store.activeConversationId)
      if (target?.agent) {
        await sendToAgent(target.id, text)
        return
      }
      if (store.streaming) {
        // v2.7 mid-turn steering: typed while a turn runs. The message goes
        // into the conversation now, ahead of the reply being written and
        // marked queued, and onto the queue the running loop drains at its
        // next round boundary. Attachments and plan mode wait for the turn.
        const running = store.conversations.find((c) => c.id === store.activeConversationId)
        if (!running || !text || attachments.length > 0 || options?.planned) return
        const inFlight = [...running.messages].reverse().find((m) => m.role === 'assistant')
        const steer: ChatMessage = { id: uid(), role: 'user', content: text, delivery: { state: 'queued' }, createdAt: Date.now() }
        if (inFlight) store.insertMessageBefore(running.id, inFlight.id, steer)
        else store.appendMessage(running.id, steer)
        store.queueSteer({ id: steer.id, conversationId: running.id, text })
        return
      }

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
      // v2.6: a document-shaped request goes to outline-then-fill when the
      // setting is on — measured before it was made a default (docs/evals.md).
      if (
        settings.grounding?.outline &&
        outlineAllowed(settings.vibeMode) &&
        targets.length === 1 &&
        !delegation &&
        looksLikeDocumentAsk(text)
      ) {
        await executeOutline(convo.id, targets[0]!, text)
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

  /**
   * v2.6: outline-then-fill for a document-shaped request. The main process
   * asks the model for a JSON outline and then for one section at a time;
   * each finished section lands in the reply as it is written, and the
   * outline rides the message so the reader sees the shape it was written
   * from. No tools ride the sections; the grounding block does.
   */
  const executeOutline = useCallback(
    async (convoId: string, slot: ModelConfig, request: string): Promise<void> => {
      const store = useAppStore.getState()
      const convo = store.conversations.find((c) => c.id === convoId)
      if (!convo) return
      const assistantMsg: ChatMessage = {
        id: uid(),
        role: 'assistant',
        content: '',
        modelId: slot.modelId,
        roleName: slot.roleName,
        color: slot.color,
        outline: { title: 'Outlining…', sections: [] },
        createdAt: Date.now()
      }
      store.appendMessage(convoId, assistantMsg)
      const patch = (p: Partial<ChatMessage>): void => useAppStore.getState().patchMessage(convoId, assistantMsg.id, p)
      store.setStreaming(true)
      const written: { heading: string; text: string; words: number; truncated?: boolean }[] = []
      const render = (title: string, done: boolean): void =>
        patch({
          content: `# ${title}\n\n${written.map((s) => `## ${s.heading}\n\n${s.text}`).join('\n\n')}${done ? '\n' : '\n\n_…_'}`,
          outline: { title, sections: written.map((s) => ({ heading: s.heading, words: s.words, truncated: s.truncated, done: true })) }
        })
      const unsubscribe = window.api.onOutlineSection((u) => {
        if (u.messageId !== assistantMsg.id) return
        written[u.index] = { heading: u.heading, text: u.text, words: u.words }
        render(useAppStore.getState().conversations.find((c) => c.id === convoId)?.messages.find((m) => m.id === assistantMsg.id)?.outline?.title ?? 'Document', false)
      })
      try {
        const r = await window.api.outlineWrite({
          model: slot.modelId,
          persona: withGrounding(slot.systemPrompt + slotRulesBlock(slot), new Date(), { offline: isOffline() }),
          request,
          messageId: assistantMsg.id
        })
        if (!r.ok) {
          patch({ content: `⚠️ ${r.error}`, outline: undefined })
        } else {
          patch({
            content: r.text,
            outline: {
              title: r.outline.title,
              sections: r.sections.map((s) => ({ heading: s.heading, words: s.text.split(/\s+/).filter(Boolean).length, truncated: s.truncated, done: true }))
            },
            ...(r.truncated ? { truncated: true } : {})
          })
          audit(convo, { kind: 'assistant_output', roleName: slot.roleName, modelId: slot.modelId, text: r.text })
        }
      } catch (err) {
        patch({ content: `⚠️ ${composeFailure(explainFailure(err, { subject: 'The document', request: turnRequestEstimate(convoId) }))}`, outline: undefined })
      } finally {
        unsubscribe()
        useAppStore.getState().setStreaming(false)
        const final = useAppStore.getState().conversations.find((c) => c.id === convoId)
        if (final && !final.ephemeral) void window.api.saveConversation(final)
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

  /**
   * PlanBlock's Approve/Cancel buttons resolve the executor's pending gate.
   *
   * v1.17.4: this is the app's ONLY writer of the `cancelled` outcome, and its
   * only caller is the Cancel control inside the plan block. Every other way a
   * plan can end is `stopped` (the abort listener on the turn's signal, i.e.
   * the composer's Stop), `failed` or `completed`. The reader's Cancel is
   * therefore not merely the usual cause of `cancelled` — it is the only one,
   * which is what lets the badge say `cancelled by you` without hedging.
   */
  const resolvePlan = useCallback((messageId: string, approved: boolean): void => {
    const resolve = planApprovals.get(messageId)
    if (resolve) {
      planApprovals.delete(messageId)
      resolve(approved ? 'approved' : 'cancelled')
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
      // v2.7: a steer the turn ended before it could deliver becomes the next
      // turn — it is already in the conversation, ahead of the reply that
      // finished without it, and the model reads it there.
      const leftover = useAppStore.getState().takeSteers(convoId)
      if (leftover.length > 0 && !controller.signal.aborted) {
        for (const s of leftover) useAppStore.getState().patchMessage(convoId, s.id, { delivery: { state: 'delivered', round: 0 } })
        await executeTargets(convoId, baseUrl, targets, delegation, tools)
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
