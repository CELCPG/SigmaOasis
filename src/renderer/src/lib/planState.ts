/**
 * v1.12: a plan's terminal state, and the seven things a reader has to be able
 * to tell apart — never approved, running, finished, cancelled before it ran,
 * stopped part-way by the user, failed on its own, abandoned when the app quit
 * (which the reader must be able to tell from all three of the others).
 *
 * Cancel used to be prose only: the message said "Plan cancelled — nothing was
 * executed" while the block below it still read "awaiting approval" in amber
 * with a live "▶ Run this plan" button. And a Stop landed in the executor's
 * catch, so the user's own interruption was drawn as the step failing. Both
 * come from the same gap: the plan object had nowhere to record that it ended.
 *
 * v2.0.1 found the last opening in that gap, on the other side of a restart.
 * Everything that makes a plan live is a process — the approval resolver, the
 * step loop, the abort signal — and none of it is on disk, so a plan written
 * out mid-flight came back claiming a process that had died with the app. In
 * both of the states that make the claim: unapproved, where the block drew
 * "▶ Run this plan" and "Cancel" over a resolver that no longer existed and
 * both buttons did nothing and said nothing; and approved, where it drew
 * `running` in the accent ink over a step pulsing '◌' forever. One left the
 * reader holding a decision the app had already taken away by quitting, the
 * other told them work was happening in a process that no longer existed.
 * `abandonOrphanedPlans` closes both at the seam a plan crosses back over:
 * conversation load.
 *
 * Headless, pinned by test/planBlock.test.ts.
 */

import type {
  ChatPlan,
  Conversation,
  PlanOutcome,
  PlanStep,
  PlanStepStatus,
  ToolCallRecord
} from '../types'

/**
 * End a plan. Every step still pending is one that will never run, so it
 * becomes 'skipped' — a queued row and a never-run row cannot look alike.
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

/**
 * A plan with no outcome is claiming a process. Which claim it is depends on
 * whether it was approved — "you may still approve this" or "this is running"
 * — but both are claims about the executor, and both are made by the plan
 * object rather than by anything that checks.
 */
export function claimsALiveProcess(plan: ChatPlan): boolean {
  return !plan.outcome
}

/**
 * What the block says where the approval buttons, or the pulsing row, used to
 * be.
 *
 * A reader who watched two controls vanish — or a step stop moving — is owed
 * the reason and the way forward, otherwise the repair reads as the app losing
 * their plan quietly instead of loudly. Both say who ended it, that it cannot
 * be picked up, and what to do instead.
 *
 * `approved` is the exact discriminator, and it is exact rather than close
 * enough: the executor patches it true immediately after the gate resolves and
 * runs no step before that, so an unapproved plan is one that never began and
 * an approved one is one that did. The second deliberately does not say how
 * much ran — the rows do, one at a time, and they are the only thing that can.
 */
export const ABANDONED_AT_GATE =
  'The app quit while this plan was waiting to be approved, so nothing ran and nothing here ' +
  'can start it. Send the request again for a fresh plan.'
export const ABANDONED_MID_RUN =
  'The app quit while this plan was running, so it ended where the rows say and nothing here ' +
  'can pick it up. Send the request again for a fresh plan.'

export function abandonedNote(plan: ChatPlan): string {
  return plan.approved ? ABANDONED_MID_RUN : ABANDONED_AT_GATE
}

/**
 * End a plan the app walked away from.
 *
 * `endPlan` settles the steps that never started. This settles the one that
 * had, because a plan can be abandoned in the middle and `running` is the one
 * status that survives `endPlan` untouched — it has no executor-side meaning
 * to survive for. Left alone it renders '◌' in the accent ink with
 * `animate-pulse`: an animation claiming work is happening, on a row where it
 * stopped happening when the process died, and unlike a dead button it never
 * even has to be pressed to lie.
 */
export function abandonPlan(plan: ChatPlan): ChatPlan {
  return endPlan(
    {
      ...plan,
      steps: plan.steps.map((s) => (s.status === 'running' ? { ...s, status: 'interrupted' } : s))
    },
    'abandoned'
  )
}

/**
 * Plans that came back from disk with nobody behind them.
 *
 * The executor is a process, and everything that makes a plan live lives in it
 * — the approval resolver in `planApprovals`, the step loop, the abort signal
 * (all hooks/planMode.ts). None of it is on disk. So a plan read off disk with
 * no outcome recorded is a plan whose executor died with the process that ran
 * it, whichever of the two live states it is frozen in: waiting at a gate that
 * has no other side, or running a step that stopped running. Not paused —
 * abandoned, and by the app, which is why it may not borrow `cancelled` or
 * `stopped`. See PlanOutcome in ../types.
 *
 * The predicate is `claimsALiveProcess`, not the awaiting-approval shape it was
 * written for. Two states make the claim; a sweep that names one of them
 * catches the defect it was shown and leaves its twin — and the twin was the
 * louder of the two, an animated row rather than an inert button.
 *
 * `live` is the executor's own record of the plans it is behind, passed in
 * rather than imported so this module stays headless — and it is not
 * decoration. `load()` re-runs whenever the base URL changes, which the reader
 * can do with the gate open or a step mid-flight, and abandoning a plan whose
 * executor is right there would be this defect's mirror image: a true
 * statement replaced by a false one.
 *
 * Identity is preserved where nothing changed, so a load that finds no orphan
 * hands back the objects it was given.
 */
export function abandonOrphanedPlans(
  convos: Conversation[],
  live: { has: (messageId: string) => boolean }
): Conversation[] {
  return convos.map((convo) => {
    let found = false
    const messages = convo.messages.map((message) => {
      if (!message.plan || !claimsALiveProcess(message.plan) || live.has(message.id)) return message
      found = true
      return { ...message, plan: abandonPlan(message.plan) }
    })
    return found ? { ...convo, messages } : convo
  })
}

/** What the header says instead of a step count once the plan is over. */
export const OUTCOME_LABEL: Record<PlanOutcome, string> = {
  completed: 'finished',
  cancelled: 'cancelled — nothing ran',
  stopped: 'stopped by you',
  failed: 'failed',
  // Names the agent, because that is the whole of what this outcome adds:
  // the reader was asked to decide and then had the decision taken away. It
  // claims nothing about extent — the rows say that — so it stays the length
  // of a badge rather than a sentence.
  abandoned: 'abandoned when the app quit'
}

/**
 * How a plan ended is the one thing in the block a reader must not miss, so it
 * is the heaviest and highest-contrast text in it — not, as through v1.12.2,
 * the lightest. "cancelled — nothing ran" was set in the faintest grey the
 * palette had, 2.15:1 and identical to the step body copy, on a block whose
 * every other cue said the work was over — which reads as a completed plan.
 *
 * Every ink here clears 4.5:1 on both canvases and is set semibold, one step
 * heavier than any step title. Hue still separates the five (pinned by
 * test/planBlock.test.ts).
 */
export const OUTCOME_CLASS: Record<PlanOutcome, string> = {
  // Weight and contrast from the plan work (the outcome must be the most
  // legible thing in the block); the neutral goes through the ink token rather
  // than a raw Tailwind grey, which the widened contrast guard now refuses.
  completed: 'font-semibold text-green-900 dark:text-green-300',
  cancelled: 'font-semibold text-ink-primary',
  stopped: 'font-semibold text-amber-900 dark:text-amber-300',
  failed: 'font-semibold text-red-900 dark:text-red-300',
  // Its own hue, and deliberately not amber: amber is the reader's Stop, and
  // the ending this marks is the one thing in the set they had no hand in.
  // Blue is unused anywhere else in the block and is nowhere near the teal
  // `--accent-ink` that means live work.
  abandoned: 'font-semibold text-blue-900 dark:text-blue-300'
}

/** The outcome sits in a bordered chip, so it reads as a stamp, not a caption. */
export const OUTCOME_BADGE = 'rounded-md border border-black/15 px-1.5 py-px dark:border-white/20'

export const STATUS_ICON: Record<PlanStepStatus, string> = {
  pending: '○',
  running: '◌',
  done: '✓',
  failed: '✗',
  stopped: '■',
  skipped: '–',
  // Third in the circle family — empty, in flight, voided — so it reads as
  // the end of the same story the pulsing '◌' was telling, and never as the
  // '✗' of a step that broke or the '■' of a Stop the reader pressed.
  interrupted: '⊘'
}

export const STATUS_CLASS: Record<PlanStepStatus, string> = {
  pending: 'text-ink-tertiary',
  running: 'text-accent-ink animate-pulse',
  done: 'text-green-600 dark:text-green-400',
  failed: 'text-red-500',
  // Stopping is not failing: amber, and never the failure red.
  stopped: 'text-amber-600 dark:text-amber-500',
  skipped: 'text-ink-tertiary',
  // The outcome's blue, one rung brighter for a glyph: the row and the badge
  // above it are the same event, and the reader should not have to work that
  // out. Not the accent teal it replaces — that ink means work in progress,
  // and this is the row where the work stopped being in progress.
  //
  // Paired per theme rather than set once, and measured: the single-value
  // `blue-600` this was first written as reads 4.40:1 on the light block and
  // 3.88:1 on the dark one — a glyph that carries the row's whole meaning,
  // missing AA on both canvases at once. 700/400 clears both (5.71:1 / 7.89:1).
  // The five glyphs beside it are single-value and three of them miss AA in
  // light; that is older than this row and is recorded in docs/evals.md rather
  // than fixed by widening what this one is allowed to be.
  interrupted: 'text-blue-700 dark:text-blue-400'
}

/** Suffix on the step's own line, for the statuses a glyph alone underplays. */
export const STATUS_NOTE: Partial<Record<PlanStepStatus, string>> = {
  stopped: 'stopped here',
  skipped: 'never ran',
  // Locates, and does not attribute: the badge above already says who ended
  // it, and repeating "the app quit" on the row would spend the reader's
  // attention twice on one fact. Deliberately parallel to 'stopped here',
  // because the two rows mean the same thing about the plan and different
  // things about who caused it.
  interrupted: 'cut off here'
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
