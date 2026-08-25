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
 */
export const VERIFY_BUDGET_MS = 60_000

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
   * May `pass` start? Records the answer either way, so the notice can name
   * every pass the deadline cost. Consult it last in a condition — it counts
   * what it is asked about.
   */
  admits: (pass: VerifyPass) => boolean
  /** `pass` returned. */
  ran: (pass: VerifyPass) => void
  /** Disarm the timer. Idempotent. */
  stop: () => void
  /** null while the tail fit inside the budget; otherwise what the reader is told. */
  notice: () => VerifyDeadlineNotice | null
}

/**
 * One deadline over the whole tail, not one per pass: three passes each under
 * their own minute is the same unbounded wait wearing three hats.
 *
 * `outer` is the turn's own signal, so Stop still stops everything — but a Stop
 * leaves no notice, because the reader who pressed it already knows why the
 * checking ended.
 */
export function createVerifyBudget(
  budgetMs: number = VERIFY_BUDGET_MS,
  outer?: AbortSignal
): VerifyBudget {
  const startedAt = Date.now()
  const control = new AbortController()
  const done = new Set<VerifyPass>()
  const started = new Set<VerifyPass>()
  const refused = new Set<VerifyPass>()
  let expired = false
  const onOuterAbort = (): void => control.abort()
  const timer = setTimeout(() => {
    expired = true
    control.abort()
  }, budgetMs)
  if (outer?.aborted) control.abort()
  else outer?.addEventListener('abort', onOuterAbort)
  return {
    signal: control.signal,
    expired: () => expired,
    remainingMs: () => Math.max(0, budgetMs - (Date.now() - startedAt)),
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
    notice() {
      if (!expired) return null
      // Started but never returned = cut short by the deadline, same as refused.
      const lost = new Set([...refused, ...started])
      if (lost.size === 0) return null
      // A pass that both ran and was refused (draft checked, revision not)
      // counts as lost: the notice may under-claim, never over-claim.
      const ranNames = [...done].filter((p) => !lost.has(p)).map((p) => PASS_NAME[p])
      const lostNames = [...lost].map((p) => PASS_NAME[p])
      return {
        kind: 'deadline',
        ok: false,
        summary:
          `⏱ Checking stopped at its ${Math.round(budgetMs / 1000)}s limit. ` +
          `Ran: ${ranNames.length > 0 ? ranNames.join(', ') : 'nothing'}. ` +
          `Not run: ${lostNames.join(', ')}. The answer above is unchanged.`
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
