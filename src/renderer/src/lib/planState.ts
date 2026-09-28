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
 * v3.0.1 found the last opening in that gap, on the other side of a restart.
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

import type { AuditEntry, AuditEntryInput, PlanAuditKind } from '../../../shared/audit'
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
 * decoration. Through v2.8.0 `load()` re-ran whenever the base URL changed,
 * which the reader can do with the gate open or a step mid-flight. App.tsx no
 * longer triggers it that way, but the next caller of `load()` can run it
 * mid-session again, and abandoning a plan whose executor is right there would
 * be this defect's mirror image: a true statement replaced by a false one.
 *
 * The session audit is deliberately left as it is. The log of the session
 * that ran the plan ends where that process ended — a `plan_start`, the step
 * lines it wrote, and no `plan_end` — and `planLedgersFromAudit` already
 * returns that ledger open, which is the record's own true account of a run
 * killed in the middle. Writing `abandoned` into a later session's log would
 * be the app recording, as though witnessed, an ending it only inferred at
 * load; and a `plan_end` with no `plan_start` in its own session is one the
 * reconstruction ignores anyway.
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

/**
 * What the header says instead of a step count once the plan is over.
 *
 * v1.17.4 — a blind critic, on the cancelled badge: *"`cancelled — nothing ran`
 * attributes the decision to nobody, where the same build family manages
 * `stopped by you` elsewhere."*
 *
 * The first question is whether the app can honestly say otherwise, and here it
 * can, absolutely rather than usually. `cancelled` has exactly one writer —
 * `resolvePlan(id, false)` in useLMStudio.ts — and that function's only caller
 * is the Cancel button inside this block. A plan the app ends on its own does
 * not land here: an aborted turn writes `stopped` (from the abort listener on
 * the approval gate, or from the `signal.aborted` checks around each step), a
 * step that throws writes `failed`, a plan that runs out writes `completed`,
 * and — v3.0.1 — a plan whose process died under it is settled at load as
 * `abandoned`, by `abandonOrphanedPlans` above and nothing else. There is no
 * fifth way in, so there is no case to hedge for and no second sentence to
 * write.
 *
 * The half that was already right is kept. "nothing ran" is the other thing a
 * reader of a dead checklist needs — that the steps below are a list of things
 * that did not happen — and dropping it to make room for the attribution would
 * have traded one missing fact for another.
 */
export const OUTCOME_LABEL: Record<PlanOutcome, string> = {
  completed: 'finished',
  cancelled: 'cancelled by you — nothing ran',
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
  completed: 'font-semibold text-ink-ok',
  cancelled: 'font-semibold text-ink-primary',
  stopped: 'font-semibold text-ink-warn',
  failed: 'font-semibold text-ink-danger',
  // Its own hue, and deliberately not amber: amber is the reader's Stop, and
  // the ending this marks is the one thing in the set they had no hand in.
  // Blue is unused anywhere else in the block and is nowhere near the teal
  // `--accent-ink` that means live work. Through a status ink token like its
  // three neighbours, not a raw palette pair: `--text-info` in index.css.
  abandoned: 'font-semibold text-ink-info'
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
  done: 'text-ink-ok',
  failed: 'text-ink-danger',
  // Stopping is not failing: amber, and never the failure red.
  stopped: 'text-ink-warn',
  skipped: 'text-ink-tertiary',
  // The outcome's ink: the row and the badge above it are the same event, and
  // the reader should not have to work that out. Not the accent teal it
  // replaces — that ink means work in progress, and this is the row where the
  // work stopped being in progress.
  //
  // A token rather than a raw step, and measured: the single-value `blue-600`
  // this was first written as reads 4.40:1 on the light block and 3.88:1 on
  // the dark one — a glyph that carries the row's whole meaning, missing AA on
  // both canvases at once. `--text-info` is 5.71:1 / 7.89:1 on the block, and
  // one value per theme is exactly the problem the status tokens exist to
  // solve (see index.css).
  interrupted: 'text-ink-info'
}

/**
 * The status column's text alternative — v1.18.
 *
 * Measured on the real Chromium accessibility tree (test/planAccessibilityCheck
 * .ts, `Accessibility.getFullAXTree` on the shipped build), the six statuses
 * reached a screen reader as *four* distinguishable rows, and two of the
 * collisions were the dangerous ones:
 *
 *   running  → button "2. Step 2 detail 2 …" [disabled]   ┐ identical
 *   pending  → button "3. Step 3 detail 3 …" [disabled]   ┘
 *   done     → button "1. Step 1 detail 1 … ▸"            ┐ identical
 *   failed   → button "2. Step 2 detail 2 … ▸"            ┘
 *
 * A step that failed and a step that succeeded produced byte-identical
 * accessible names. The whole of the difference was `✓` versus `✗` — a bare
 * `StaticText` sitting OUTSIDE the row, which a reader announces as a symbol
 * name or as nothing at all. Colour carried the rest, which is no carrier.
 *
 * So the glyph gets the text alternative that a meaningful icon owes: not a
 * hidden label bolted beside it, but `role="img"` + `aria-label` on the glyph
 * itself, which is what that pair is for. It is announced first, before the
 * step number and title, because the state is what a reader scanning a
 * checklist is scanning for.
 *
 * Every status is labelled, with no exception for the ones that already carry a
 * visible note. A reader of a `skipped` row therefore hears "never ran" twice —
 * once from the glyph, once from the note beside the title. That echo is the
 * deliberate price of a rule with no hole in it: a status added later cannot
 * fall through, because there is nothing to fall through. This project's
 * recurring defect is the enumeration that stops covering its class, and three
 * words of repetition is a cheaper failure than a silent row.
 */
export const STATUS_LABEL: Record<PlanStepStatus, string> = {
  pending: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  // Not "Stopped" alone: the row must not read as the plan having failed, and
  // the outcome badge says "stopped by you" in the same voice.
  stopped: 'Stopped by you',
  // Locates, like its note, and does not attribute: the outcome badge above is
  // what names the app. Not "Stopped" — that word is the reader's, one level
  // down — and not "Failed", which blames the step for a process ending.
  //
  // Placed before `skipped` on purpose: `PLAN_STEP_STATUSES` is read off this
  // table's key order and the census walks it, so the order here is the order
  // the header tells the story in — what ran, where it was cut off, what never
  // got the chance: `4 steps: 1 done, 1 cut off, 2 never ran`.
  interrupted: 'Cut off',
  skipped: 'Never ran'
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
 * The header's single status element — v1.18.
 *
 * Through v1.17 this was three sibling spans, each rendered only in its own
 * state. A live region announces a change to its *contents*; a region that is
 * itself created and destroyed announces nothing reliably, so a plan that
 * ended told a screen-reader user precisely as much as one that had not. One
 * element that always exists and swaps what it says is the difference between
 * a reader being told and not, and it is why this is a function rather than
 * three conditionals in the view.
 *
 * Same order of precedence the three conditionals had: a plan with an outcome
 * is over whatever else is true of it.
 */
export interface PlanHeaderStatus {
  text: string
  className: string
}

export function planHeaderStatus(plan: ChatPlan): PlanHeaderStatus {
  if (plan.outcome) {
    return {
      text: OUTCOME_LABEL[plan.outcome],
      className: `${OUTCOME_BADGE} ${OUTCOME_CLASS[plan.outcome]}`
    }
  }
  if (awaitingApproval(plan)) return { text: 'awaiting approval', className: 'text-ink-warn' }
  // Approved and no outcome yet is the only live state; say so, so the header
  // alone tells the seven states apart. (Only ever true while `livePlans` is
  // behind it: a plan read off disk in this shape was settled at load.)
  return { text: 'running', className: 'text-accent-ink' }
}

/**
 * What the header says about the steps themselves — v2.4.
 *
 * A fraction is a promise about the steps it leaves out. `0/4 steps done` says
 * four things are not done yet, and *yet* is the whole of the reader's model of
 * a checklist: the numerator climbs, the denominator is reached. On a plan that
 * can still run, that promise is good.
 *
 * Measured, blind, round 11 (`.h2h-runs/B11/PT2-20260828-110253`, and the same
 * line in A11), `Plan — 0/4 steps done` also sat above four rows every one of
 * which read `never ran`, beside a badge reading `cancelled by you — nothing
 * ran`. Round 11 taught the badge to
 * attribute the decision; the count went on describing a run in progress. Not
 * one word of it is false — no step is done, there are four of them — and it
 * still tells a reader that three quarters of the work is ahead. Round 10's
 * lesson with the breadth in the presentation rather than in the claim.
 *
 * So the fraction survives exactly as long as it is closed. `4/4 steps done`
 * beside `finished` leaves nothing out and stays, because it is the same
 * statement as the census and a shorter one; the case to repair is a fraction
 * with a remainder that will never arrive. That plan gets the census instead:
 * how many steps there were and what became of every one of them.
 *
 * Not `4 steps` alone, which would leave their fate to the badge — the badge
 * speaks about the plan, and the rows are what the reader is about to read. And
 * not a shape written for `cancelled`, which is how the next outcome gets
 * forgotten: the tally walks `STATUS_LABEL`, so a status added later is counted
 * by construction rather than by being remembered here. The cost is one echo —
 * a cancelled plan says `4 never ran` above four rows that each say `never ran`
 * — which is the same deliberate repetition `STATUS_LABEL` already accepts.
 */
export function planHeaderCount(plan: ChatPlan): string {
  return countFromLedger(planLedger(plan))
}

/**
 * The header's number, and where it is allowed to come from — v2.5.
 *
 * A blind critic, on plan mode in both arms: *"The plan header's progress
 * fraction is the only thing visible without interacting, and it is the one
 * number no artifact in the run can check — the audit records tools, never
 * steps. A reader who trusts `3/3 steps done` is trusting the block about
 * itself."* Both critics counted every plan step statement **unsettleable**
 * rather than agreed, which is the honest reading of a claim with nothing
 * behind it.
 *
 * So the header stopped counting a `ChatPlan` directly. It counts a *ledger* —
 * the total, one status per step, and the outcome — and a ledger has two
 * sources: the live plan, and the session audit's `plan_*` lines. One counting
 * function, two readings, and `planLedgersFromAudit` below is the second.
 *
 * **What that buys, exactly.** A reader with an exported log can count the
 * `plan_step_end` lines whose status is `done` and get the numerator, count the
 * plan's `planStepCount` and get the denominator, and the chain says nobody
 * edited those lines afterwards. The header stops being an assertion and
 * becomes a citation.
 *
 * **What it does not buy, and this half matters more.** It is not
 * corroboration. `scripts/h2h-record.ts` has this project's clearest statement
 * of why, and it is about exactly this claim: *"a plan step is a construct of
 * the application; nothing outside it observes a step starting or ending […] a
 * step boundary it drew itself — writing any of those into a record makes the
 * record agree with the screen by construction. That is not evidence. It is the
 * same number twice."* Every word of that survives this change. The application
 * is still the only witness to its own steps, and a build that lied about a
 * step would write the lie to both places.
 *
 * The two are not the same defect, which is why one of them could be fixed
 * here. **Uncorroborated** is a fact about who is watching, and no code in a
 * local-first app can change it. **Unrecorded** is a fact about what was
 * written down, and a plan turn was leaving no trace of itself in a log whose
 * whole contract is a transcript of what was said. This closes the second.
 * `BEYOND_ANY_RECORD` keeps the first, narrowed to what is still true of it.
 */
export interface PlanLedger {
  total: number
  /** One per step, in order. Index 0 is the step the block numbers 1. */
  statuses: PlanStepStatus[]
  /** Absent while the plan can still progress. */
  outcome?: PlanOutcome
}

export function planLedger(plan: ChatPlan): PlanLedger {
  return {
    total: plan.steps.length,
    statuses: plan.steps.map((s) => s.status),
    ...(plan.outcome ? { outcome: plan.outcome } : {})
  }
}

/** The one place a plan's step count is turned into words. See `planHeaderCount`. */
export function countFromLedger(ledger: PlanLedger): string {
  const total = ledger.total
  const done = ledger.statuses.filter((s) => s === 'done').length
  if (!ledger.outcome || done === total) return `${done}/${total} steps done`
  const steps = `${total} step${total === 1 ? '' : 's'}`
  const tally = PLAN_STEP_STATUSES.map((status) => ({
    status,
    count: ledger.statuses.filter((s) => s === status).length
  }))
    .filter((group) => group.count > 0)
    .map((group) => `${group.count} ${STATUS_LABEL[group.status].toLowerCase()}`)
  return `${steps}: ${tally.join(', ')}`
}

/**
 * Every status and every outcome, read off the label tables rather than typed
 * out again. Both tables are `Record<T, string>`, so a member added to either
 * union has to be added to them to compile — which makes these lists total by
 * construction, and makes the validation in `planLedgersFromAudit` total too.
 */
export const PLAN_STEP_STATUSES = Object.keys(STATUS_LABEL) as PlanStepStatus[]
export const PLAN_OUTCOMES = Object.keys(OUTCOME_LABEL) as PlanOutcome[]

function asStepStatus(value: unknown): PlanStepStatus | null {
  return PLAN_STEP_STATUSES.find((s) => s === value) ?? null
}

function asOutcome(value: unknown): PlanOutcome | null {
  return PLAN_OUTCOMES.find((o) => o === value) ?? null
}

/**
 * Read a plan back out of a session audit — the check the header's number now
 * has, and the only one it can have (see `planHeaderCount`).
 *
 * Entries are taken in file order, which is append order: a turn runs alone, so
 * one plan's lines cannot interleave with another's. A `plan_start` opens a
 * ledger, a `plan_end` closes it, and a ledger left open when the entries run
 * out is returned open — a run killed mid-plan is a thing the record should be
 * able to say, not a thing it should round off.
 *
 * A step with no `plan_step_end` keeps `pending`, and `plan_end` puts those
 * through `endPlan` — the same function the block uses, not a second spelling
 * of its rule. So a plan cancelled at the approval gate reconstructs as N steps
 * that never ran from a record holding *no step lines at all*, which is right:
 * nothing ran, so nothing was written, and the absence is the evidence.
 */
export function planLedgersFromAudit(entries: readonly AuditEntry[]): PlanLedger[] {
  const ledgers: PlanLedger[] = []
  let open: PlanLedger | null = null
  const at = (index: unknown): number => (typeof index === 'number' ? index - 1 : -1)

  for (const e of entries) {
    if (e.kind === 'plan_start') {
      // A second start with one still open means the first never ended: keep it,
      // unfinished, rather than dropping it or pretending it completed.
      if (open) ledgers.push(open)
      const total = typeof e.planStepCount === 'number' ? e.planStepCount : 0
      open = { total, statuses: Array.from({ length: total }, () => 'pending' as PlanStepStatus) }
      continue
    }
    if (!open) continue
    if (e.kind === 'plan_step_start') {
      const i = at(e.planStepIndex)
      if (i >= 0 && i < open.statuses.length) open.statuses[i] = 'running'
    } else if (e.kind === 'plan_step_end') {
      const i = at(e.planStepIndex)
      const status = asStepStatus(e.planStepStatus)
      if (i >= 0 && i < open.statuses.length && status) open.statuses[i] = status
    } else if (e.kind === 'plan_end') {
      const outcome = asOutcome(e.planOutcome)
      ledgers.push(outcome ? closeLedger(open, outcome) : open)
      open = null
    }
  }
  if (open) ledgers.push(open)
  return ledgers
}

/** `endPlan`'s rule, applied to a ledger — pending becomes never-ran. */
function closeLedger(ledger: PlanLedger, outcome: PlanOutcome): PlanLedger {
  const shaped = endPlan(
    {
      steps: ledger.statuses.map((status, i) => ({
        id: String(i),
        title: '',
        detail: '',
        status
      })),
      approved: true,
      createdAt: 0
    },
    outcome
  )
  return planLedger(shaped)
}

/**
 * The lines a plan writes to the log, built here beside the header they have to
 * agree with — the reason every other sentence in this block moved out of its
 * component, applied to the record.
 *
 * `plan_end` deliberately does **not** carry the header's sentence. A record
 * that restates the summary is a record a reader can read instead of checking,
 * and then the check is one number agreeing with a copy of itself. The lines
 * carry the facts; the arithmetic stays on screen, where it can be redone.
 */
export type PlanAuditLine = Pick<
  AuditEntryInput,
  'text' | 'planStepIndex' | 'planStepCount' | 'planStepStatus' | 'planOutcome'
> & { kind: PlanAuditKind }

/**
 * The checklist as it was put in front of the reader: what each step said it
 * would do, and what it said it might reach for. `toolPreview` is the block's
 * own sentence, called rather than re-worded, so the plan that was approved and
 * the plan in the record cannot be two different documents.
 */
export function planStartLine(plan: ChatPlan): PlanAuditLine {
  const steps = plan.steps
    .map((s, i) => `${i + 1}. ${s.title}\n${s.detail}\n${toolPreview(s)}`)
    .join('\n\n')
  return {
    kind: 'plan_start',
    planStepCount: plan.steps.length,
    text: `Plan of ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}:\n\n${steps}`
  }
}

export function planStepStartLine(plan: ChatPlan, index: number): PlanAuditLine {
  return {
    kind: 'plan_step_start',
    planStepIndex: index,
    planStepCount: plan.steps.length,
    text: `Step ${index} of ${plan.steps.length} started — ${plan.steps[index - 1]?.title ?? ''}`
  }
}

/** The status word is `STATUS_LABEL`'s, the same one the row's glyph announces. */
export function planStepEndLine(
  plan: ChatPlan,
  index: number,
  status: PlanStepStatus,
  output?: string
): PlanAuditLine {
  const head = `Step ${index} of ${plan.steps.length} — ${STATUS_LABEL[status]}`
  return {
    kind: 'plan_step_end',
    planStepIndex: index,
    planStepCount: plan.steps.length,
    planStepStatus: status,
    text: output ? `${head}\n${output}` : head
  }
}

/** The outcome word is `OUTCOME_LABEL`'s — the badge's, including who caused it. */
export function planEndLine(plan: ChatPlan, outcome: PlanOutcome): PlanAuditLine {
  return {
    kind: 'plan_end',
    planStepCount: plan.steps.length,
    planOutcome: outcome,
    text: `Plan ${OUTCOME_LABEL[outcome]}.`
  }
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
