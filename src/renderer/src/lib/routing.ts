import type {
  AppSettings,
  Attachment,
  ClaimCheckRecord,
  Conversation,
  EscalationReason,
  ModelConfig
} from '../types'
import { looksFactual } from './grounding'

/**
 * Layer 2 of the routing/tools strategy: explicit mechanical routing.
 *
 * Everything in this module is pure and node:test-reachable. The hook keeps
 * React/store concerns; deciding *where a message goes* is decided here, in
 * code, so it can be fixture-tested and so a weak model never has to make the
 * routing call itself.
 *
 * Priority (first match wins):
 *   1. @mention — the user's explicit override always wins
 *   2. collaborative mode — the pipeline is already an explicit route
 *   3. pre-flight classifier — image / code / finance / factual signals
 *   4. today's behavior (active slot / orchestrator) when the classifier
 *      abstains
 */

// ---- @mention ---------------------------------------------------------------

/**
 * Strip fenced code blocks and inline code before mention matching, so a
 * handle that appears in pasted code ("use @coder for DI") is content, not a
 * routing instruction (Layer 2c).
 */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
}

/** `@RoleName` (spaces removed, case-insensitive, word-bounded) in the text routes the message. */
export function mentionTarget(settings: AppSettings, text: string): ModelConfig | null {
  const searchable = stripCode(text).toLowerCase()
  for (const m of settings.models) {
    if (!m.enabled || !m.roleName.trim()) continue
    const handle = `@${m.roleName.replace(/\s+/g, '').toLowerCase()}`
    let at = searchable.indexOf(handle)
    while (at !== -1) {
      const next = searchable[at + handle.length]
      // Word boundary: "@coderish" must not match the "@coder" handle.
      if (next === undefined || !/[a-z0-9]/.test(next)) return m
      at = searchable.indexOf(handle, at + 1)
    }
  }
  return null
}

// ---- pre-flight classifier --------------------------------------------------

export type RouteSignal = 'image' | 'code' | 'factual' | 'finance'

export interface RouteDecision {
  slot: ModelConfig
  signal: RouteSignal
  /** Short human-readable reason, shown to the user as the routing note. */
  reason: string
}

const STACK_TRACE =
  /Traceback \(most recent call last\)|^\s+at .+\(.+:\d+:\d+\)|\w+Error:/m
const FILE_PATH = /(?:~|\.{1,2})?\/[\w./-]+\.\w{1,10}\b/
const FINANCE_VOCAB =
  /\b(mortgage|loans?|amortiz\w*|apr|compound\w*|interest rate|exchange rate|inflation|down payment|monthly payment|savings goal)\b/i

interface CodeMatch {
  matched: boolean
  reason: string
}

function detectCode(text: string): CodeMatch {
  if (/```/.test(text)) return { matched: true, reason: 'fenced code detected' }
  if (STACK_TRACE.test(text)) return { matched: true, reason: 'stack trace detected' }
  if (FILE_PATH.test(text)) return { matched: true, reason: 'file path detected' }
  return { matched: false, reason: '' }
}

/**
 * Decide, before any model runs, whether this message obviously belongs to a
 * specialty slot. Returns null (abstain) when nothing matches or no suitable
 * enabled slot exists — abstention is the safety net and means "use today's
 * behavior".
 *
 * Signal priority: image > code > finance > factual. This deliberately
 * deviates from the strategy doc's table order: the finance vocabulary is
 * more specific than the broad `looksFactual` heuristic, so it is checked
 * first, and factual coverage is preserved as the last resort.
 */
export function preflightRoute(args: {
  text: string
  hasImages: boolean
  models: ModelConfig[]
  isVisionCapable?: (modelId: string) => boolean
}): RouteDecision | null {
  const { text, hasImages, models, isVisionCapable } = args
  const routable = models.filter((m) => m.enabled && m.modelId)

  if (hasImages) {
    const slot = routable.find((m) => isVisionCapable?.(m.modelId))
    if (slot) return { slot, signal: 'image', reason: 'image attached' }
    // No vision slot: fall through — abstention beats routing an image to a
    // blind model, and the active slot may itself be vision-capable.
  }

  const code = detectCode(text)
  if (code.matched) {
    const slot = routable.find((m) => m.specialty === 'coding')
    if (slot) return { slot, signal: 'code', reason: code.reason }
  }

  if (FINANCE_VOCAB.test(text)) {
    const slot = routable.find((m) => m.specialty === 'finance')
    if (slot) return { slot, signal: 'finance', reason: 'finance vocabulary' }
  }

  if (looksFactual(text)) {
    const slot = routable.find((m) => m.specialty === 'research')
    if (slot) return { slot, signal: 'factual', reason: 'factual question' }
  }

  return null
}

// ---- route targets ----------------------------------------------------------

export interface RouteResult {
  targets: ModelConfig[]
  delegation?: { specialists: ModelConfig[] }
  /** Set when the pre-flight classifier redirected the message. */
  routingNote?: string
}

/**
 * Decide which model slots answer a user message: @mention wins, then the
 * conversation's mode decides (pipeline chain / orchestrator / pre-flight
 * classifier / active slot).
 */
export function routeTargets(
  settings: AppSettings,
  convo: Conversation,
  text: string,
  attachments?: Attachment[],
  isVisionCapable?: (modelId: string) => boolean
): RouteResult {
  const mention = mentionTarget(settings, text)
  if (mention) return { targets: [mention] }

  if (convo.mode === 'collaborative') {
    // The pipeline is already an explicit route — the classifier stays out.
    return {
      targets: settings.pipeline
        .map((id) => settings.models.find((m) => m.id === id))
        .filter((m): m is ModelConfig => Boolean(m?.enabled && m.modelId))
    }
  }

  const decision = preflightRoute({
    text,
    hasImages: Boolean(attachments?.some((a) => a.kind === 'image')),
    models: settings.models,
    isVisionCapable
  })
  const routingNote = decision
    ? `routed to ${decision.slot.roleName} — ${decision.reason}`
    : undefined

  if (convo.mode === 'orchestrated') {
    const orchestrator =
      settings.models.find((m) => m.id === convo.orchestratorSlotId && m.enabled) ??
      settings.models.find((m) => m.enabled)
    if (!orchestrator) return { targets: [] }
    const slot = decision?.slot ?? orchestrator
    return {
      targets: [slot],
      delegation: {
        specialists: settings.models.filter((m) => m.enabled && m.modelId && m.id !== slot.id)
      },
      routingNote
    }
  }

  if (decision) return { targets: [decision.slot], routingNote }

  const active =
    settings.models.find((m) => m.id === convo.activeModelSlotId && m.enabled) ??
    settings.models.find((m) => m.enabled)
  return { targets: active ? [active] : [] }
}


// ---- escalation (Layer 2d) ----------------------------------------------------

/** Human-readable reason text for the routing note and the escalate button. */
export const ESCALATION_REASON_TEXT: Record<EscalationReason, string> = {
  iteration_cap: 'the answer ran out of tool-call rounds',
  contradicted: 'a claim was contradicted',
  unverified: 'the answer was unverified'
}

/**
 * Whether a finished turn ended weak enough to offer a re-run on a bigger
 * slot. Priority: iteration_cap > contradicted > unverified — a stopped tool
 * loop is the most broken state, a contradicted claim outranks a merely
 * unsourced one. Aborted turns never escalate.
 */
export function escalationReason(
  message: { unverified?: boolean; claimCheck?: ClaimCheckRecord },
  stopReason: 'completed' | 'aborted' | 'iteration_cap'
): EscalationReason | null {
  if (stopReason === 'aborted') return null
  if (stopReason === 'iteration_cap') return 'iteration_cap'
  if (message.claimCheck?.claims.some((c) => c.verdict === 'contradicted')) return 'contradicted'
  if (message.unverified) return 'unverified'
  return null
}

/**
 * Pick the slot an escalation should re-run on: an enabled, model-assigned
 * slot other than the current one, with the largest context window the app
 * knows about — the mechanical proxy for "bigger". A candidate must beat the
 * current slot's window when that window is known; when it is not, the
 * largest known window wins. Returns null when nothing qualifies.
 */
export function escalationCandidate(
  current: ModelConfig,
  models: ModelConfig[],
  contextOf: (slot: ModelConfig) => number | undefined
): ModelConfig | null {
  const currentCtx = contextOf(current)
  let best: ModelConfig | null = null
  let bestCtx = currentCtx ?? 0
  for (const m of models) {
    if (m.id === current.id || !m.enabled || !m.modelId) continue
    const ctx = contextOf(m)
    if (ctx === undefined) continue
    // With a known current window, only a strictly bigger one is "bigger".
    if (currentCtx !== undefined && ctx <= currentCtx) continue
    if (ctx > bestCtx) {
      best = m
      bestCtx = ctx
    }
  }
  return best
}
