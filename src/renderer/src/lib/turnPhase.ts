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

import { formatElapsed } from './oasisRipple'

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
  /**
   * v1.12.6: when the reader's wait began — the STAGE's origin, not this
   * provider's. The gathering walk changes label as it moves from the search to
   * the library to the playbook, and a count restarted at each of those would
   * report the app's bookkeeping rather than the wait.
   */
  since: number
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

/**
 * v1.12.5: how long the whole post-answer tail may run before it is stopped
 * and says so.
 *
 * Round 3 named the tail and round 4 cut two of its causes — a claim check that
 * could not succeed, a stall with no counter — but nothing bounded the general
 * case. On a recorded run (.h2h-runs/judge-r4/V3) the checks were still going
 * when a 300-second capture budget expired: composer still on Stop, "Checking
 * figures and links…" still on screen, no end in prospect. A check the reader
 * cannot wait out is not a check, it is a hang with a label.
 *
 * Sixty seconds because that is a bound, not a diet: it is longer than two of
 * the three post-answer tails that finished at all in those runs (≈23 s and
 * ≈54 s; the third was ≈111 s), so the default amount of checking is unchanged
 * on the turns that were already survivable. What changes is that the turns
 * that were not now end, naming what they did and did not get to.
 *
 * **What it bounds, exactly.** Round 13: what the deadline governs is when new
 * work may *start*, and it aborts the model streams a pass is waiting on. It
 * cannot recall a call already handed to the main process — `window.api
 * .executeTool` is an IPC round trip with no cancellation path — so a pass that
 * got a `deep_research` or a `run_python` away before the minute was up runs
 * until that call returns. Measured (`.h2h-runs/judge-r12/TTU1`): the revision
 * pass started at ~1 s, its `deep_research` campaign took 93 s, and the footer
 * read `114.1s checking` under a line that said checking had stopped at 60 s.
 *
 * Killing that call at the 60 s mark would make the sentence true by throwing
 * away the work the reader had already paid 93 s for. So the sentence changed
 * instead — see `notice` — and it now says what the limit actually does.
 */
export const VERIFY_BUDGET_MS = 60_000

/**
 * How far past the limit a tail may land before the notice stops calling itself
 * a stop at the limit and starts naming the overrun.
 *
 * One second, because that is the resolution the reader is reading at: the stat
 * line prints `60.1s checking` beside a `60s limit` and the two agree, which is
 * how a blind critic scored the recorded 60.1 s pairs. The cases this must
 * catch are the ones where they visibly do not — 62.2 s, 69.4 s, 81.3 s,
 * 114.1 s, all recorded.
 */
export const VERIFY_OVERRUN_FLOOR_MS = 1_000

/** The post-answer passes that cost real time, in the order the turn runs them. */
export type VerifyPass = 'claims' | 'code' | 'recompute' | 'revising'

/** What each pass is called in the reader's terms, for the notice below. */
const PASS_NAME: Record<VerifyPass, string> = {
  claims: 'the claim check',
  code: 'the code check',
  recompute: 'the recomputation',
  revising: 'the revision'
}

/** The disclosure a spent budget leaves on the message, shaped like the other checks. */
export interface VerifyDeadlineNotice {
  kind: 'deadline'
  ok: false
  summary: string
}

export interface VerifyBudget {
  /** Aborts when the deadline expires — or when the turn itself is stopped. */
  readonly signal: AbortSignal
  /** True only once the deadline fired; a user Stop is not an expiry. */
  expired: () => boolean
  /** Milliseconds left, floored at zero. */
  remainingMs: () => number
  /**
   * How long the tail has actually taken, from the same origin the stat line's
   * "checking" span is measured from. Over `budgetMs` once work that was
   * already in flight at the deadline carried on past it.
   */
  elapsedMs: (now?: number) => number
  /**
   * May `pass` start? Records the answer either way, so the notice can name
   * every pass the deadline cost. Consult it last in a condition — it counts
   * what it is asked about.
   */
  admits: (pass: VerifyPass) => boolean
  /** `pass` returned. */
  ran: (pass: VerifyPass) => void
  /** Disarm the timer. Idempotent. */
  stop: () => void
  /**
   * null while the tail fit inside the budget; otherwise what the reader is
   * told. `endedAt` is when the tail actually finished — pass the same stamp
   * the turn's `turnMs` is computed from, so the figure this quotes and the
   * figure the stat line prints are one measurement rather than two readings.
   */
  notice: (endedAt?: number) => VerifyDeadlineNotice | null
}

/**
 * One deadline over the whole tail, not one per pass: three passes each under
 * their own minute is the same unbounded wait wearing three hats.
 *
 * `outer` is the turn's own signal, so Stop still stops everything — but a Stop
 * leaves no notice, because the reader who pressed it already knows why the
 * checking ended.
 *
 * `startedAt` is the origin the deadline counts from, and round 13 made the
 * caller supply it. It used to be "now", meaning the moment control reached
 * this call — a few hundred milliseconds after the last token, because the
 * paced tail drain and the turn's own bookkeeping sit in between. The stat
 * line's "checking" span starts at the last token (lib/turnCost.ts subtracts
 * the stream from the turn), so the two clocks disagreed by exactly that gap,
 * which is why every well-behaved recorded tail reads 60.1–60.3 s against a
 * 60 s limit rather than 60.0. Handed the same origin, a figure over the limit
 * is an overrun and nothing else.
 */
export function createVerifyBudget(
  budgetMs: number = VERIFY_BUDGET_MS,
  outer?: AbortSignal,
  startedAt: number = Date.now()
): VerifyBudget {
  const control = new AbortController()
  const done = new Set<VerifyPass>()
  const started = new Set<VerifyPass>()
  const refused = new Set<VerifyPass>()
  let expired = false
  const onOuterAbort = (): void => control.abort()
  // From `startedAt`, not from here: the origin may be in the past.
  const timer = setTimeout(
    () => {
      expired = true
      control.abort()
    },
    Math.max(0, startedAt + budgetMs - Date.now())
  )
  if (outer?.aborted) control.abort()
  else outer?.addEventListener('abort', onOuterAbort)
  const elapsedMs = (now: number = Date.now()): number => Math.max(0, now - startedAt)
  return {
    signal: control.signal,
    expired: () => expired,
    remainingMs: () => Math.max(0, budgetMs - elapsedMs()),
    elapsedMs,
    admits(pass) {
      if (expired || control.signal.aborted) {
        refused.add(pass)
        return false
      }
      started.add(pass)
      return true
    },
    ran(pass) {
      started.delete(pass)
      done.add(pass)
    },
    stop() {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onOuterAbort)
    },
    /**
     * What the deadline cost, in three states rather than two.
     *
     * A pass that never began and a pass the deadline caught mid-flight were
     * both reported as `Not run`, and on the recorded TTU1 turn that put
     * `Not run: the revision` under the revision's own `deep_research` row —
     * the same shape round 12 repaired for the recomputation, one pass over.
     * The revision had run; what it had not done was finish. So:
     *
     *   Ran        — began and reported back inside the tail.
     *   Cut short  — began, and the deadline ended it before it reported back.
     *   Not run    — the deadline was already spent when it was asked for.
     *
     * The head sentence is the other half. `Checking stopped at its 60s limit`
     * is true of a tail that ends at the limit and false of one that ends at
     * 114.1 s, and the difference between those two turns is not a difference
     * in what the app decided — it is whether a call already dispatched came
     * back quickly. So the decision and the wall clock are stated separately,
     * and the second is stated in the stat line's own word and figure.
     */
    notice(endedAt = Date.now()) {
      if (!expired) return null
      const cut = new Set(started)
      // A pass that both ran and was refused (draft checked, revision not)
      // counts as lost: the notice may under-claim, never over-claim.
      const blocked = [...refused].filter((p) => !cut.has(p))
      if (cut.size === 0 && blocked.length === 0) return null
      const ranNames = [...done].filter((p) => !cut.has(p) && !refused.has(p)).map((p) => PASS_NAME[p])
      const elapsed = elapsedMs(endedAt)
      const limit = Math.round(budgetMs / 1000)
      const overran = elapsed - budgetMs >= VERIFY_OVERRUN_FLOOR_MS
      return {
        kind: 'deadline',
        ok: false,
        summary:
          (overran
            ? `⏱ Checking stopped starting new work at its ${limit}s limit; a pass already ` +
              `running carried it to ${(elapsed / 1000).toFixed(1)}s. `
            : `⏱ Checking stopped at its ${limit}s limit. `) +
          `Ran: ${ranNames.length > 0 ? ranNames.join(', ') : 'nothing'}. ` +
          (cut.size > 0 ? `Cut short: ${[...cut].map((p) => PASS_NAME[p]).join(', ')}. ` : '') +
          (blocked.length > 0 ? `Not run: ${blocked.map((p) => PASS_NAME[p]).join(', ')}. ` : '') +
          'The answer above is unchanged.'
      }
    }
  }
}

/**
 * v1.12.4: the third wait that was anonymous. The first run_python of a session
 * loads CPython-compiled-to-WASM before a line of the model's code runs —
 * seconds on a cold cache, ~0.9 s warm (test/workbenchCheck.ts prints it) — and
 * through it the block showed an unlabelled ⏳ and the word "running…", which is
 * what the runtime was not yet doing. Named here, with the other waits, so the
 * block borrows this vocabulary instead of inventing a second one
 * (components/RanCodeHeader.tsx renders it).
 */
export const SANDBOX_BOOT_WAIT: TurnWait = {
  label: 'Starting the Python sandbox',
  detail: 'one-time for this session; later runs skip it'
}

export function verifyingPhase(
  messageId: string,
  step: VerifyStep,
  since: number = Date.now()
): TurnPhase {
  return { messageId, stage: 'verifying', since, ...VERIFY_WAITS[step] }
}

export function gatheringPhase(
  messageId: string,
  wait: TurnWait,
  since: number = Date.now()
): TurnPhase {
  return { messageId, stage: 'gathering', since, ...wait }
}

/**
 * How long the reader has been in this stage, in the counter's own vocabulary
 * (lib/oasisRipple.ts `formatElapsed` — seconds under a minute, m:ss over it,
 * truncated). Borrowed rather than reinvented: one wait counted two ways would
 * be two waits as far as the reader is concerned.
 *
 * Pure, so eight seconds of gathering can be driven by mock timers instead of
 * waited out (test/turnPhase.test.ts).
 */
export function waitElapsed(phase: TurnPhase, now: number = Date.now()): string {
  return formatElapsed(Math.max(0, now - phase.since))
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
  const here = input.phase?.messageId === input.messageId ? input.phase : null
  return answerSettled(input.isStreaming, here)
}

/**
 * Is the answer text final — the turn over, or only being verified?
 *
 * The half of `actionsReady` that does not depend on there being any text, so
 * lib/replyRecovery.ts can ask the same question about a reply that came back
 * empty. `phaseHere` is the phase already narrowed to the message in hand.
 */
export function answerSettled(isStreaming: boolean, phaseHere: TurnPhase | null): boolean {
  if (!isStreaming) return true
  return phaseHere?.stage === 'verifying'
}
