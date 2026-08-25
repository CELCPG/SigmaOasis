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

import type { ChatPlan, PlanOutcome, PlanStep, PlanStepStatus, ToolCallRecord } from '../types'

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

/**
 * How a plan ended is the one thing in the block a reader must not miss, so it
 * is the heaviest and highest-contrast text in it — not, as through v1.12.2,
 * the lightest. "cancelled — nothing ran" was set in the faintest grey the
 * palette had, 2.15:1 and identical to the step body copy, on a block whose
 * every other cue said the work was over — which reads as a completed plan.
 *
 * Every ink here clears 4.5:1 on both canvases and is set semibold, one step
 * heavier than any step title. Hue still separates the four (pinned by
 * test/planBlock.test.ts).
 */
export const OUTCOME_CLASS: Record<PlanOutcome, string> = {
  // Weight and contrast from the plan work (the outcome must be the most
  // legible thing in the block); the neutral goes through the ink token rather
  // than a raw Tailwind grey, which the widened contrast guard now refuses.
  completed: 'font-semibold text-green-900 dark:text-green-300',
  cancelled: 'font-semibold text-ink-primary',
  stopped: 'font-semibold text-amber-900 dark:text-amber-300',
  failed: 'font-semibold text-red-900 dark:text-red-300'
}

/** The outcome sits in a bordered chip, so it reads as a stamp, not a caption. */
export const OUTCOME_BADGE = 'rounded-md border border-black/15 px-1.5 py-px dark:border-white/20'

export const STATUS_ICON: Record<PlanStepStatus, string> = {
  pending: '○',
  running: '◌',
  done: '✓',
  failed: '✗',
  stopped: '■',
  skipped: '–'
}

export const STATUS_CLASS: Record<PlanStepStatus, string> = {
  pending: 'text-ink-tertiary',
  running: 'text-accent-ink animate-pulse',
  done: 'text-green-600 dark:text-green-400',
  failed: 'text-red-500',
  // Stopping is not failing: amber, and never the failure red.
  stopped: 'text-amber-600 dark:text-amber-500',
  skipped: 'text-ink-tertiary'
}

/** Suffix on the step's own line, for the two statuses a glyph alone underplays. */
export const STATUS_NOTE: Partial<Record<PlanStepStatus, string>> = {
  stopped: 'stopped here',
  skipped: 'never ran'
}

/**
 * A step's own copy — its detail line and its tool disclosure.
 *
 * v1.12.3: a step that never ran had its title struck through and everything
 * below it left at full strength, so a stopped plan's abandoned steps still
 * presented their contents as results. Measured on a real stopped run: five
 * rows labelled "never ran" carrying "Result: ~$1,080" and "Result: ~$244" in
 * the same ink as a step that really ran — figures the planner invented, sitting
 * where a reader lifts them from. Struck and dimmed below the ink of a step that
 * did run, in both themes.
 *
 * Muted is the one place in the app where that token is correct prose: its
 * contract is decorative and DISABLED states, and a step that will never run is
 * exactly a disabled one. Everything it says is a thing that did not happen.
 */
export const STEP_BODY_CLASS = 'text-ink-tertiary'
export const STEP_BODY_NEVER_RAN = 'text-ink-muted line-through'

export function stepBodyClass(status: PlanStepStatus): string {
  return status === 'skipped' ? STEP_BODY_NEVER_RAN : STEP_BODY_CLASS
}

/**
 * What a step says it will reach for, before anything runs.
 *
 * v1.12.3: approval was asked for blind. The block showed three titles and
 * their prose and nothing else — no tool name, no badge — so the user
 * authorised execution without being told what would execute, and the tool
 * calls became visible only after they had run.
 *
 * Named tools are already filtered to the enabled set (main/ipc/plan.ts); a
 * step that names none says so, because a missing line and an empty one are
 * the same thing to a reader.
 */
export function toolPreview(step: Pick<PlanStep, 'tools'>): string {
  const names = step.tools ?? []
  return names.length > 0
    ? `Tools — may use: ${names.join(', ')}`
    : 'Tools — none planned; this step reasons only'
}

/**
 * The forecast, read back against what the step actually ran — in **both**
 * directions, because a set difference has two.
 *
 * `toolPreview` is a promise made before approval and deliberately not a
 * leash: the names in it are not an allowlist, because a small model that
 * forecasts nothing would then be handed nothing, and the plan is worse for
 * it. What a non-binding forecast owes the reader instead is honesty — and
 * measured on a real run it did not pay. A step authorised as "Tools — may
 * use: memory_search" went on to call `reference_lookup` against the user's
 * own installed library, and all the row said afterwards was "🔧 2 tool
 * calls": a count that agreed with itself while the names disagreed.
 *
 * v1.17 checked exactly that half. A blind critic then found the other half
 * open, and the raw audit log of judge-r6/PT1 confirms it: the plan shown at
 * the approval moment forecast `list_notes` on one step and `read_note` on
 * another; `trace/audit.jsonl` for that run holds `memory_search` ×1 and
 * `reference_lookup` ×3 and nothing else. **Neither forecast tool ever ran**,
 * both lines stayed on screen unannotated, and the header read `4/4 steps
 * done · finished`. The reader who approved on the strength of "may use:
 * list_notes" was never told the forecast was worthless — and the two steps
 * that did reach for tools were the ones that had said "none planned".
 *
 * That is round 5's recurring species in a new place: a check that reads a
 * quantity *adjacent to* the one it means — here one direction of a set
 * difference in place of the difference itself. So this returns the whole
 * symmetric difference from one place, and the block reports every member of
 * it. Adding a direction later means adding it here, not remembering to.
 *
 * Same rule on status as `undisclosedToolRuns` in lib/toolGrounding.ts for the
 * ran-but-unforecast half: a call that errored still ran, and still ran
 * undisclosed. The unrun half is gated the other way, on `done`, and the
 * distinction is *did not* versus *could not have*: only a step that reached
 * the end of its own sub-turn can be said to have finished without touching
 * what it forecast. A step that failed, was stopped, or was skipped never got
 * that far, and its row already says so in its own words.
 */
export interface StepToolReconciliation {
  /** Ran, and the forecast never named it. */
  undisclosed: string[]
  /** Forecast, and the step ran to the end without ever calling it. */
  unrun: string[]
  /**
   * The forecast named no tool at all and tools ran anyway. Not the same
   * failure as adding one to a list: the reader was told in as many words that
   * this step would only reason, so the row owes them more than a name.
   */
  contradicted: boolean
}

export function reconcileStepTools(
  step: Pick<PlanStep, 'tools' | 'status'>,
  calls: readonly Pick<ToolCallRecord, 'name'>[]
): StepToolReconciliation {
  const forecast = [...new Set(step.tools ?? [])]
  const promised = new Set(forecast)
  const ran = new Set(calls.map((c) => c.name))
  const undisclosed = [...ran].filter((n) => !promised.has(n)).sort()
  return {
    undisclosed,
    unrun: step.status === 'done' ? forecast.filter((n) => !ran.has(n)).sort() : [],
    contradicted: promised.size === 0 && undisclosed.length > 0
  }
}

/** Did this step do something other than what it said? Either direction counts. */
export function stepDiverged(r: StepToolReconciliation): boolean {
  return r.undisclosed.length > 0 || r.unrun.length > 0
}

/** What the row says when the two disagree — names, because a count is not one. */
export function undisclosedRunNote(names: string[], contradicted = false): string {
  return (
    `⚠️ Ran ${names.join(', ')}, which this step did not disclose` +
    (contradicted ? ' — it planned no tools at all.' : '.')
  )
}

/**
 * What the row says when a forecast tool never ran.
 *
 * Deliberately *not* a warning, and the difference is the point. A tool that
 * ran unannounced is work the reader did not authorise; a tool that was
 * offered and turned out not to be needed is often the step doing its job. The
 * defect was never that the forecast over-reached — it was that nothing said
 * so, so a reader could not tell an informed approval from an uninformed one.
 * A ⚠️ here would put the two failures at the same volume and teach the reader
 * to discount both, which is this project's most expensive recurring mistake.
 * So: no glyph, the step's own body ink, stated as fact.
 */
export function unrunForecastNote(names: string[]): string {
  return `Forecast ${names.join(', ')}, which this step never ran.`
}

/**
 * The header's share of the same reconciliation.
 *
 * `4/4 steps done` is true — every step reached the end of its sub-turn — and
 * it is also the whole of what the header said about a run in which half the
 * forecast was fiction. The count stays, because shrinking it would trade one
 * false impression for another; what it gets is the clause that stops it being
 * read as a clean bill. Set at the weight and ink of the count itself: a
 * reader must not be able to take the one without the other.
 */
export function forecastDivergenceNote(diverged: number, total: number): string {
  return (
    `${diverged} of ${total} step${total === 1 ? '' : 's'} diverged from ` +
    `${diverged === 1 ? 'its' : 'their'} forecast`
  )
}
