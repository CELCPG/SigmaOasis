import { useAppStore } from '../stores/appStore'
import {
  conversationContextUsage,
  historyBudget,
  planHistory,
  planHistoryFallback,
  requestEstimate,
  type ContextUsage
} from '../lib/contextBudget'
import { foldLocalDigest } from '../lib/contextCompressor'
import { budgetContextLength } from '../lib/modelInfo'
import { projectInstructionsBlock } from '../lib/projectContext'
import {
  schemasAvailableTo,
  selectTurnTools,
  stabilizeTurnTools,
  rankingIsDecisive,
  TURN_TOOL_CAP,
  withForcedTools
} from '../lib/toolSelection'
import { attachmentInlineNote } from '../lib/attachmentRecall'
import type { ApiContentPart } from '../lib/agentLoop'
import type { RequestEstimate } from '../../../shared/failure'
import type { ChatMessage, Conversation, ModelConfig, ToolSchema } from '../types'

/**
 * Per-turn helpers shared by the chat engine: audit logging, ids, wire content
 * for history messages, history planning and compaction, the vision check for
 * the router, and per-turn tool subsetting. Extracted verbatim from
 * useLMStudio.ts in v1.4.8 so the hook is glue over these rather than home to
 * them.
 */

/**
 * What a turn in this conversation costs, read off live settings.
 *
 * v1.17.3. The one caller of `conversationContextUsage` used to be the meter
 * under the composer; now the refusal sentence and the gate on Regenerate ask
 * the same question, and all three have to get the same answer or the app is
 * back to contradicting itself on one screen. So they ask through here.
 *
 * Null when LM Studio never reported a window size — the same silence the
 * meter keeps, for the same reason: there is no denominator to be honest about.
 */
export function turnContextUsage(
  conversationId: string | null,
  /** The slot that ran (or is about to). Defaults to the one the composer meters. */
  slotOverride?: ModelConfig
): ContextUsage | null {
  const store = useAppStore.getState()
  const convo = store.conversations.find((c) => c.id === conversationId)
  const settings = store.settings
  if (!convo || !settings) return null
  // The composer's own resolution, verbatim (InputBar.tsx): the conversation's
  // slot if it still exists and is enabled, else the first enabled one. Two
  // spellings of "which model is this for" would put the meter and the sentence
  // on different models, which is the defect one level down.
  const slot =
    slotOverride ??
    settings.models.find((m) => m.id === convo.activeModelSlotId && m.enabled) ??
    settings.models.find((m) => m.enabled)
  return conversationContextUsage(
    convo,
    slot,
    store.availableModels.find((m) => m.id === slot?.modelId),
    projectInstructionsBlock(settings.projects.find((p) => p.id === convo.projectId)),
    schemasAvailableTo(slot, settings.tools)
  )
}

/** The same arithmetic, in the shape shared/failure.ts quotes it in. */
export function turnRequestEstimate(
  conversationId: string | null,
  slotOverride?: ModelConfig
): RequestEstimate | undefined {
  const usage = turnContextUsage(conversationId, slotOverride)
  return usage ? requestEstimate(usage) : undefined
}

/**
 * Fire-and-forget audit log entry (v0.9). Checked here AND in the main
 * process: skipped when the log is disabled, and ephemeral conversations
 * never produce entries. Audit failures must never break a chat turn.
 */
export function audit(
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

export function uid(): string {
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
export function toApiContent(m: ChatMessage, withImages: boolean): string | ApiContentPart[] {
  const attachments = m.attachments ?? []
  const files = attachments.filter((a) => a.kind === 'file')
  const images = attachments.filter((a) => a.kind === 'image' && a.dataUrl)

  const textParts: string[] = []
  if (m.content) textParts.push(m.content)
  for (const f of files) {
    if (f.dataFile) {
      textParts.push(`[Attached file: ${f.name}${attachmentInlineNote(f)}]`)
      continue
    }
    textParts.push(
      `[Attached file: ${f.name}${attachmentInlineNote(f)}]\n\`\`\`\n${f.textContent ?? ''}\n\`\`\``
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
export function toSummaryText(messages: ChatMessage[]): string {
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
export async function planAndCompact(
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

  // Persist a summary onto the conversation and hand it back for this turn.
  const commit = (text: string): { history: ChatMessage[]; summaryText: string } => {
    const summary = {
      text,
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
    return { history: plan.keep, summaryText: text }
  }

  // v1.4: the summarizer is a model call, so it can fail — mid-swap, timed out,
  // or refused. Before, every one of those paths dropped `fresh` with no record
  // and the conversation quietly lost its middle. Fall back to a local, model-free
  // digest instead: worse text than the model would write, but the span is
  // accounted for. A digest of nothing keeps the old summary and leaves
  // `throughMessageId` where it was, so the next attempt can still cover it.
  const degrade = (): { history: ChatMessage[]; summaryText: string | null } => {
    const folded = foldLocalDigest(existing?.text, fresh)
    return folded === null
      ? { history: plan.keep, summaryText: existing?.text ?? null }
      : commit(folded)
  }

  useAppStore.getState().setCompacting(true)
  try {
    const result = await window.api.summarizeConversation({
      previousSummary: existing?.text,
      droppedText: toSummaryText(fresh),
      modelId: slot.modelId
    })
    if (!result.ok) return degrade()
    return commit(result.summary)
  } catch {
    return degrade()
  } finally {
    useAppStore.getState().setCompacting(false)
  }
}

/**
 * Vision check for the pre-flight router (Layer 2b), answered from the model
 * catalog LM Studio reported — never guessed from the model id.
 */
export function visionCapable(modelId: string): boolean {
  return useAppStore
    .getState()
    .availableModels.some((m) => m.id === modelId && m.vision === true)
}

/**
 * The tool subset each conversation is currently carrying, so a follow-up turn
 * can reuse it and leave the prompt prefix intact (see `stabilizeTurnTools`).
 * Names only, re-resolved against the live allowlist every turn; RAM only, and
 * a stale entry for a deleted conversation is three dozen bytes.
 */
const turnToolMemo = new Map<string, string[]>()

/**
 * v1.3: per-turn tool subsetting (Layer 1b). Always-on tools plus the top
 * embedding matches against the user's text, capped at TURN_TOOL_CAP. Any
 * ranking failure — no embedding model, an endpoint error — falls back to
 * the full per-role allowlist: an optimization, never a gate.
 *
 * v1.5: `stabilityKey` (a conversation id) holds the chosen subset steady
 * across turns that do not need a different one. Omitted by the one-shot
 * callers — a consultation and a plan step each get a fresh selection, because
 * there is no prefix of theirs to preserve.
 */
export async function subsetForTurn(
  tools: ToolSchema[],
  query: string | undefined,
  stabilityKey?: string,
  /** v1.6: tools this turn must carry regardless of rank (e.g. run_python when a data file is attached). */
  force: readonly string[] = []
): Promise<ToolSchema[]> {
  if (!query?.trim() || tools.length <= TURN_TOOL_CAP) return tools
  try {
    const res = await window.api.rankTools(
      query,
      tools.map((t) => ({ name: t.function.name, description: t.function.description }))
    )
    if (!res.ok || !res.scores) return tools
    const selected = selectTurnTools(tools, res.scores)
    if (!stabilityKey) return withForcedTools(tools, selected, force)
    const previous = turnToolMemo.get(stabilityKey)
    // v1.4.5: an indecisive ranking must not be allowed to move anything. On
    // "1" or "yes" the scores are separated by less than a rounding error, so
    // whichever tool wins is arbitrary — and swapping the toolbox on a coin
    // flip both hands the model the wrong tools and discards the prompt cache.
    // With nothing to hold to yet, this turn's arbitrary pick becomes the
    // incumbent and stops moving.
    const stable = rankingIsDecisive(res.scores)
      ? stabilizeTurnTools(tools, selected, previous)
      : stabilizeTurnTools(tools, selected, previous ?? selected.map((t) => t.function.name))
    const withForced = withForcedTools(tools, stable, force)
    turnToolMemo.set(
      stabilityKey,
      withForced.map((t) => t.function.name)
    )
    return withForced
  } catch {
    return tools
  }
}
