/**
 * v1.12: a plan's terminal state, and the six things a reader has to be able
 * to tell apart — never approved, running, finished, cancelled before it ran,
 * stopped part-way by the user, failed on its own.
 *
 * Cancel used to be prose only: the message said "Plan cancelled — nothing was
 * executed" while the block below it still read "awaiting approval" in amber
 * with a live "▶ Run this plan" button. And a Stop landed in the executor's
 * catch, so the user's own interruption was drawn as the step failing. Both
 * come from the same gap: the plan object had nowhere to record that it ended.
 *
 * Headless, pinned by test/planBlock.test.ts.
 */

import type { ChatPlan, PlanOutcome, PlanStepStatus } from '../types'

/**
 * End a plan. Every step still pending is one that will never run, so it
 * becomes 'skipped' — a queued row and an abandoned row cannot look alike.
 * Steps that already finished, failed, or were stopped keep what they said.
 */
export function endPlan(plan: ChatPlan, outcome: PlanOutcome): ChatPlan {
  return {
    ...plan,
    outcome,
    steps: plan.steps.map((s) => (s.status === 'pending' ? { ...s, status: 'skipped' } : s))
  }
}

/** Only a plan that can still be approved is awaiting approval. */
export function awaitingApproval(plan: ChatPlan): boolean {
  return !plan.outcome && !plan.approved && plan.steps.every((s) => s.status === 'pending')
}

/** What the header says instead of a step count once the plan is over. */
export const OUTCOME_LABEL: Record<PlanOutcome, string> = {
  completed: 'finished',
  cancelled: 'cancelled — nothing ran',
  stopped: 'stopped by you',
  failed: 'failed'
}

export const OUTCOME_CLASS: Record<PlanOutcome, string> = {
  completed: 'text-green-600 dark:text-green-400',
  cancelled: 'text-neutral-400',
  stopped: 'text-amber-600 dark:text-amber-500',
  failed: 'text-red-500'
}

export const STATUS_ICON: Record<PlanStepStatus, string> = {
  pending: '○',
  running: '◌',
  done: '✓',
  failed: '✗',
  stopped: '■',
  skipped: '–'
}

export const STATUS_CLASS: Record<PlanStepStatus, string> = {
  pending: 'text-neutral-400',
  running: 'text-accent-ink animate-pulse',
  done: 'text-green-600 dark:text-green-400',
  failed: 'text-red-500',
  // Stopping is not failing: amber, and never the failure red.
  stopped: 'text-amber-600 dark:text-amber-500',
  skipped: 'text-neutral-300 dark:text-neutral-600'
}

/** Suffix on the step's own line, for the two statuses a glyph alone underplays. */
export const STATUS_NOTE: Partial<Record<PlanStepStatus, string>> = {
  stopped: 'stopped here',
  skipped: 'never ran'
}
