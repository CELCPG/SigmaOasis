/**
 * What the turn is doing right now, by name — and the one rule that decides
 * when a finished answer becomes actionable.
 *
 * Two waits used to be invisible. Before the model is asked anything, a
 * factual turn runs the app's own web search (a serial provider with a
 * network timeout) while the reader watches an empty bubble. After the last
 * token, the unverified flag, the claim check (another whole model round
 * trip) and the grounding pass all run with `streaming` still true — which is
 * what the action row used to gate on, so Copy, Regenerate, Think harder,
 * Branch and the timestamp stayed hidden on an answer that was complete and
 * on screen.
 *
 * The phase names both waits, and `actionsReady` reads it: verification keeps
 * the turn busy, it no longer keeps the answer unusable.
 *
 * Pure and React-free, so the decisions are node-testable (test/turnPhase.test.ts).
 */

/** A named wait: what is being waited on, and why, in the reader's terms. */
export interface TurnWait {
  /** Short name of the work — shown as-is, so no wait is anonymous. */
  label: string
  /** One clause of why. */
  detail: string
}

/**
 * 'gathering': pre-model context work, named by the provider doing it.
 * 'verifying': post-answer checks — the answer text is final unless a
 * revision replaces it, so the reader may act on it now.
 */
export type TurnStage = 'gathering' | 'verifying'

export interface TurnPhase extends TurnWait {
  /** The assistant message this work belongs to. */
  messageId: string
  stage: TurnStage
}

/** The post-answer passes, named where useLMStudio enters them. */
export type VerifyStep = 'claims' | 'grounding' | 'revising'

export const VERIFY_WAITS: Record<VerifyStep, TurnWait> = {
  claims: {
    label: 'Checking claims',
    detail: 'another role is naming what this answer cannot support'
  },
  grounding: {
    label: 'Checking figures and links',
    detail: 'against what this turn’s tools actually returned'
  },
  revising: {
    label: 'Revising',
    detail: 'unsupported specifics went back for verification or removal'
  }
}

export function verifyingPhase(messageId: string, step: VerifyStep): TurnPhase {
  return { messageId, stage: 'verifying', ...VERIFY_WAITS[step] }
}

export function gatheringPhase(messageId: string, wait: TurnWait): TurnPhase {
  return { messageId, stage: 'gathering', ...wait }
}

/**
 * Can the reader act on this message now — copy, read aloud, branch?
 *
 * Yes the moment the answer text is complete. `streaming` stays true through
 * the verification tail (nothing else may start a turn while it runs), so the
 * phase is the only thing separating "still composing" from "composed, still
 * being checked". Buttons that start a NEW turn are a separate question — the
 * row shows them disabled while the turn is busy.
 */
export function actionsReady(input: {
  content: string
  isStreaming: boolean
  phase: TurnPhase | null
  messageId: string
}): boolean {
  if (!input.content) return false
  if (!input.isStreaming) return true
  return input.phase?.messageId === input.messageId && input.phase.stage === 'verifying'
}
