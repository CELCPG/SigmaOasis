import { useAppStore } from '../stores/appStore'
import { budgetContextLength } from '../lib/modelInfo'
import { consultedSources, stripTurnNotesEcho, TURN_CONTEXT_HEADER } from '../lib/grounding'
import { checkToolGrounding, conflictingToolFigures } from '../lib/toolGrounding'
import type { ToolExecuteContext } from '../lib/contextProviders'
import { extractLedgerEntries } from '../lib/factLedger'
import { createVerifyBudget, VERIFY_BUDGET_MS, type VerifyStep } from '../lib/turnPhase'
import type { AgentLoopStopReason } from '../lib/agentLoop'
import { escalationCandidate, escalationReason } from '../lib/routing'
import type { ChatMessage, Conversation, GroundingReport, ModelConfig, ResponseStats, ToolCallRecord, ToolSchema } from '../types'
import { reviseAgainstFindings, runAutoCritic, runClaimCheck, runCodeCheck, runRecompute, settleRevision } from './verification'
import { describeCodeCheck, looksArithmetic } from '../lib/workbenchChecks'
import { describeSourceCheck, findingsStanding, withSourceFindings, type SourceFinding } from '../lib/sourceCheck'
import { runSourceCheck } from './sourceCheck'

/**
 * What a chat turn does after its last token (v3.1: out of useLMStudio.ts).
 *
 * Moved verbatim from the end of `runTurn`, where it had grown to a third of
 * the file: the turn-notes echo scrub, the code check, recomputation, the one
 * revision against findings and its verdict, the claim check or auto-critic,
 * the fact-ledger write, the deadline and its notice, and the offer to re-run
 * on a bigger slot. Nothing here changed but where it lives — the closures
 * read the same names, which now arrive in a `TurnTailContext` instead of from
 * the enclosing function, and `runTurn` calls the two halves at exactly the
 * points it used to reach them. The individual passes stay in verification.ts;
 * this is the order they run in and the one budget they share.
 *
 * Out of the hook, it is reachable from node:test (test/turnTail.test.ts).
 */

/** The turn state the tail reads, captured when the answer has finished. */
export interface TurnTailContext {
  convo: Conversation
  slot: ModelConfig
  /** The slot's whole allowlist — the code check runs only where run_python is on it. */
  slotTools: ToolSchema[]
  /** Every schema the turn could reach, for the revision pass. */
  tools: ToolSchema[]
  baseUrl: string
  /** The turn's own signal: the user's Stop. */
  signal: AbortSignal
  /** The reply as the turn holds it; a kept revision rewrites its content. */
  assistantMsg: ChatMessage
  patch: (p: Partial<ChatMessage>) => void
  verifying: (step: VerifyStep | null) => void
  allRecords: ToolCallRecord[]
  toolContext: ToolExecuteContext
  lastUserContent: string | undefined
  shoppingTurn: boolean
  checkableTurn: boolean
  /** When the answer stopped streaming — the deadline counts from here (0: not recorded). */
  answerEndedAt: number
  /** The last figures the stream produced, re-stamped with the turn's length once the tail ends. */
  lastStats: ResponseStats | null
  turnOpenedAt: number
}

export interface TurnTail {
  /** Everything after the last token, under one deadline. */
  run: () => Promise<void>
}

/**
 * Prepare the tail. Synchronous on purpose: the echo scrub and the deadline
 * happen at this call, where `runTurn` always ran them — before the spoken
 * remainder of a completed reply and before the iteration-cap warning.
 */
export function startTurnTail(t: TurnTailContext): TurnTail {
  const {
    convo,
    slot,
    slotTools,
    tools,
    baseUrl,
    signal,
    assistantMsg,
    patch,
    verifying,
    allRecords,
    toolContext,
    lastUserContent,
    shoppingTurn,
    checkableTurn,
    answerEndedAt,
    lastStats,
    turnOpenedAt
  } = t

  // Layer 2d: a weak ending — unverified, contradicted, or capped out of
  // tool rounds — earns an offer to re-run on a bigger slot. An offer, never
  // an automatic re-run: the user decides, and the click re-validates.
  // v1.3: did the reply actually use what the tools returned? Purely
  // mechanical (no model call, no network), so it runs on every finished turn
  // — including turns that consulted sources, which is exactly where a model
  // overriding a computed figure would otherwise pass unnoticed.
  // Every user message, not just this turn's: a budget stated four turns ago
  // is still the user's own number, and so is the arithmetic done on it.
  const allUserText = (): string =>
    convo.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n')

  // v2.5: the tool records of the conversation's EARLIER assistant turns, one
  // array per turn. Read by exactly one rung — `misdescribedRetrieval`, whose
  // question ("which documents did you use just now") is always asked a turn
  // late, so a corpus of this turn alone is structurally blind to it. Grouped
  // per turn, never flattened: passage numbering restarts at [1] each turn and
  // a flat list would drop every collision. See lib/toolGrounding.ts.
  const priorTurns = convo.messages
    .filter((m) => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0)
    .map((m) => m.toolCalls ?? [])

  // v1.6: the Workbench's code check joins the report. It is re-run on a
  // revision, so the gate compares like with like: a revision whose code now
  // runs has strictly fewer findings; one that merely rewords does not.
  const workbenchChecksOn =
    useAppStore.getState().settings?.grounding.workbenchChecks !== false &&
    slotTools.some((t) => t.function.name === 'run_python')
  const checks: NonNullable<ChatMessage['checks']> = []
  // v4.1 (G4): what the source check found in the draft; graded into every
  // report below by whether the sentence still stands (lib/sourceCheck.ts).
  let sourceFindings: SourceFinding[] = []

  /**
   * v1.12.5: the deadline over everything from here to the composer being
   * released. It starts at the last token — the only thing between that and
   * the first costly pass is a regex — so what it bounds is exactly the wait
   * the reader is held through with no answer to the question "how long?".
   *
   * `signal` rides along, so Stop still stops the checking; only an expiry
   * leaves a notice.
   *
   * v2.4: counted from the last token rather than from here. The paced tail
   * drain and the bookkeeping above sit between the two, and the stat line
   * bills that gap to "checking" — so a budget started here was always the
   * shorter of the two spans, and every honest recorded tail printed 60.1–60.3 s
   * beside a "60s limit". One origin, one number.
   */
  const budget = createVerifyBudget(
    VERIFY_BUDGET_MS,
    signal,
    answerEndedAt > 0 ? answerEndedAt : Date.now()
  )
  /** Stopped by the user, or stopped by the deadline — both leave the answer standing. */
  const stopped = (): boolean => signal.aborted || budget.signal.aborted

  // v1.7: scrub a verbatim echo of the turn-notes scaffold before any check
  // reads the content (the eval caught a 9B opening its reply with the header
  // sentence). Mechanical, disclosed, and shares its marker with the prompt.
  {
    const scrub = stripTurnNotesEcho(assistantMsg.content)
    if (scrub.echoed) {
      if (scrub.text !== assistantMsg.content) {
        assistantMsg.content = scrub.text
        patch({ content: scrub.text })
      }
      checks.push({
        kind: 'echo',
        ok: scrub.text !== '' && !scrub.text.includes(TURN_CONTEXT_HEADER),
        summary: '🧾 The reply echoed the app’s internal turn notes; the echo was removed.'
      })
      patch({ checks: [...checks] })
    }
  }
  type CodeCheck = Awaited<ReturnType<typeof runCodeCheck>>
  const codeCheckMemo = new Map<string, CodeCheck>()
  const codeFindingFor = async (content: string): Promise<CodeCheck> => {
    if (!workbenchChecksOn) return { finding: null, ran: false, ok: false }
    const hit = codeCheckMemo.get(content)
    if (hit) return hit
    if (!budget.admits('code')) return { finding: null, ran: false, ok: false }
    const out = await runCodeCheck(convo, slot, content, allRecords, toolContext, () => patch({ toolCalls: [...allRecords] }))
    // Unconditional, and it is the one pass where that is the honest answer:
    // `runCodeCheck` takes no signal, so it always reaches a conclusion — even
    // when the conclusion is that the reply contains no code to check.
    budget.ran('code')
    codeCheckMemo.set(content, out)
    return out
  }
  /**
   * The report as it stands against the records the turn holds **now**.
   *
   * Every rung's corpus is `allRecords` read at the moment of the call, so a
   * report is only ever true of the turn as it was when it was built. Re-read
   * it, do not carry it — `settleRevision` carries what carrying it cost.
   *
   * Re-running is cheap and cannot lose a finding. `checkToolGrounding` is a
   * pure pass over text, and the code check is memoised on `content`, so
   * restating a report the turn has already built re-uses that finding rather
   * than re-running the sandbox — and does so whether or not the deadline has
   * since expired.
   */
  const groundingReport = async (content = assistantMsg.content): Promise<GroundingReport | null> => {
    const base = withSourceFindings(
      checkToolGrounding(content, allRecords, allUserText(), {
        expectPricingTool: shoppingTurn,
        priorTurns
      }),
      findingsStanding(sourceFindings, content),
      allRecords
    )
    const code = await codeFindingFor(content)
    if (!code.finding) return base
    return { ...(base ?? { figures: [], links: [], checkedAgainst: ['run_python'] }), code: [code.finding] }
  }

  /**
   * v1.4.6: hand the findings back for one revision, then re-check.
   *
   * Only ever one pass. A second would be the model arguing with a regex, and
   * whatever survives the first correction is what the badge is for — the
   * point is to fix what can be fixed and disclose the rest, not to loop until
   * the checker is satisfied.
   */
  const checkGrounding = async (): Promise<void> => {
    // v1.12: two numeric tools disagreeing about the same labelled figure in
    // this turn (market_data said +14.61%, the model's python said -8.99%,
    // measured live). Disclosed, not adjudicated — the model may well have
    // relayed the right one, but the disagreement should not be silent.
    if (!checks.some((c) => c.kind === 'conflict')) {
      for (const conflict of conflictingToolFigures(allRecords)) {
        checks.push({
          kind: 'conflict',
          ok: false,
          summary: `⚖️ Tools disagree: ${conflict} — say which one the answer uses and why.`
        })
      }
      if (checks.some((c) => c.kind === 'conflict')) patch({ checks: [...checks] })
    }
    // v1.6 code check, disclosed whether or not it found anything.
    const firstCode = await codeFindingFor(assistantMsg.content)
    if (firstCode.ran || firstCode.note === 'the code needs input, files or the network, so it cannot be checked in the sandbox') {
      checks.push(describeCodeCheck({ ran: firstCode.ran, ok: firstCode.ok, finding: firstCode.finding, note: firstCode.note, compared: firstCode.compared }))
      patch({ checks: [...checks] })
    }
    let report = await groundingReport()

    // v1.6 recompute. Two cases, one action: figures were stated and nothing
    // computed them (no report can exist yet — the check has no corpus), or a
    // tool ran and does not support what was stated (measured: a correct
    // out-the-door price flagged because the model had misused the finance
    // calculator; the old path then revised the number away). Either way, ask
    // for a Python recomputation and re-check: figures it supports stop being
    // findings, and no revision is needed at all.
    const numericRan = allRecords.some(
      (r) => (r.name === 'run_python' || r.name === 'finance_calculator' || r.name === 'analyze_file') && r.status === 'done'
    )
    // `admits` counts what it is asked about, so it goes last: the budget must
    // not record a pass this turn was never going to run.
    //
    // v2.3: and the deadline is not one of the reasons to skip asking. This
    // condition tested `!stopped()`, which is `signal.aborted ||
    // budget.signal.aborted` — so once the budget expired the gate returned
    // before `admits` was ever consulted, and the pass the deadline cost went
    // unrecorded and therefore unnamed. Only the user's own Stop belongs here:
    // it leaves no notice at all, by design.
    if (
      workbenchChecksOn &&
      lastUserContent &&
      !signal.aborted &&
      looksArithmetic(allUserText(), assistantMsg.content) &&
      (!numericRan || (report?.figures.length ?? 0) > 0) &&
      budget.admits('recompute')
    ) {
      const recompute = await runRecompute(
        convo, slot, baseUrl, lastUserContent, assistantMsg.content, allRecords, toolContext, budget.signal, () =>
          patch({ toolCalls: [...allRecords] })
      )
      checks.push(recompute)
      // Only a pass that got to finish counts as run — and the pass is what says
      // so. This used to ask `!budget.signal.aborted`, which is a fact about the
      // clock: a recomputation whose `run_python` (never wired to that signal)
      // printed its output two seconds past the deadline was recorded as not
      // run, and the expiry line said so directly under this check's own
      // "🧮 Recomputed the stated figures in Python" — with the program, its
      // stdout and the comparison all on screen above it. See `WorkbenchCheck.ran`.
      if (recompute.ran) budget.ran('recompute')
      patch({ checks: [...checks] })
      report = await groundingReport()
    }
    if (!report) return
    const autoCorrect = useAppStore.getState().settings?.grounding.autoCorrect !== false
    // Same reordering, same reason: a revision this turn would have run, and
    // did not because the minute was up, is exactly what the expiry line exists
    // to name. `admits` records the refusal; `stopped()` used to swallow it.
    if (!autoCorrect || signal.aborted || !budget.admits('revising')) {
      patch({ grounding: report })
      return
    }

    verifying('revising')
    const before = assistantMsg.content
    const revised = await reviseAgainstFindings(
      slot,
      baseUrl,
      tools,
      budget.signal,
      convo,
      before,
      report,
      allRecords,
      () => patch({ toolCalls: [...allRecords] })
    )
    // Two builders reached this line from opposite sides of one defect: the
    // budget was asking the CLOCK what a pass had done, and the report was
    // published before the pass that changed the record. Both fixes are kept.
    //
    // The revision that came back is the evidence it ran — `reviseAgainstFindings`
    // returns '' when the loop produced nothing, deadline included.
    if (revised.trim()) budget.ran('revising')
    // No early return here, deliberately: an abandoned or empty revision still
    // has to reach `settleRevision` below, because the pass may have appended
    // records and the report above predates them. Returning early would publish
    // the stale report, which is the defect this round set out to fix.

    // Provisionally adopt the revision so the checker sees it, then keep it
    // only if it actually reduced what can be faulted. Measured against the
    // live model: a correction that swapped two invented addresses for two
    // different invented addresses, and added a claim that the rest had been
    // "verified against search results" when nothing had run.
    const original = assistantMsg.content
    if (revised.trim() && !stopped()) assistantMsg.content = revised
    // v2.3: every report the verdict reads is graded HERE, after the pass — the
    // revision's own tool calls have joined `allRecords` by now, so `report`
    // above is a claim about the turn as it was before them. `settleRevision`
    // carries the measured case and the argument.
    const verdict = await settleRevision({
      draft: original,
      revised,
      abandoned: stopped(),
      grade: groundingReport
    })
    if (verdict.keep === 'draft') {
      assistantMsg.content = original
      patch({ content: original, grounding: verdict.grounding ?? undefined })
      return
    }
    // The revision's code ran clean where the draft's did not: say so — but the
    // comparison rides along (memoised, no second run), so "the revised code
    // runs" cannot become the tick over a figure its output contradicts.
    if (verdict.corrected.before.code?.length && !verdict.corrected.after?.code?.length) {
      const i = checks.findIndex((c) => c.kind === 'code')
      const line = describeCodeCheck({ ran: true, ok: false, revisedRuns: true, compared: (await codeFindingFor(revised)).compared })
      if (i >= 0) checks[i] = line
      else checks.push(line)
    }
    // Both reports, not just the first. The revision was kept because it
    // reduced the findings, which is not the same as clearing them — what
    // survived is the half the disclosure line most needs to say.
    patch({
      content: revised,
      corrected: { ...verdict.corrected, at: Date.now() },
      grounding: verdict.grounding ?? undefined,
      checks: [...checks]
    })
  }

  /**
   * Everything after the last token, under one deadline, ending in a number
   * the reader can trust.
   *
   * Both endings — a completed answer and one that ran out of tool rounds —
   * ran a byte-identical copy of this, which is how a bound added to one could
   * have missed the other.
   */
  const runVerificationTail = async (): Promise<void> => {
    try {
      // v1.1: a factual question answered without consulting any web source is
      // exactly the confabulation signature — flag it so the UI can say so,
      // then have a different role name the claims it could not verify.
      if (checkableTurn && !consultedSources(allRecords)) {
        patch({ unverified: true })
        verifying('claims')
        // v1.2: the claim check settles the critic's list when enabled;
        // otherwise the v1.1 auto-critic names the checks for the user.
        const claimCheckOn = useAppStore.getState().settings?.claimCheck.enabled === true
        if (budget.admits('claims')) {
          // Both return whether a check reached the reader — a verdict, a
          // budget note, a failure line: any account of itself. The clock is not
          // consulted, here or anywhere else in this tail.
          const checked = claimCheckOn
            ? await runClaimCheck(
                convo,
                assistantMsg.id,
                lastUserContent ?? '',
                assistantMsg.content,
                { modelId: slot.modelId, roleName: slot.roleName },
                baseUrl,
                budget.signal,
                allRecords,
                patch
              )
            : await runAutoCritic(
                convo,
                assistantMsg.id,
                lastUserContent ?? '',
                assistantMsg.content,
                { modelId: slot.modelId, roleName: slot.roleName },
                baseUrl,
                budget.signal
              )
          if (checked) budget.ran('claims')
        }
      } else if (
        // v4.1 (G4): the sourced turn's half — its specifics against its own
        // sources, one at a time, same model. Off by default (the setting).
        useAppStore.getState().settings?.grounding.sourceCheck === true &&
        consultedSources(allRecords) &&
        !signal.aborted &&
        budget.admits('sources')
      ) {
        verifying('sources')
        const out = await runSourceCheck(slot, baseUrl, assistantMsg.content, allRecords, budget.signal)
        sourceFindings = out.findings
        if (!out.cut) budget.ran('sources')
        if (out.ran) {
          checks.push({ kind: 'sources', ...describeSourceCheck(out.checked, out.findings, out.cut) })
          patch({ checks: [...checks] })
        }
      }
      verifying('grounding')
      await checkGrounding()
      // v2.6: what this reply stated and a retrieved source confirms goes to
      // the fact ledger, so the next ask can be answered from it with its
      // date. Never from an ephemeral chat, never a claim without a source.
      if (!convo.ephemeral && useAppStore.getState().settings?.grounding?.factLedger !== false) {
        const drafts = extractLedgerEntries(assistantMsg.content, allRecords, lastUserContent ?? '')
        if (drafts.length > 0) {
          const wrote = await window.api.ledgerUpsert(drafts).catch(() => null)
          if (wrote?.ok) {
            patch({ ledgerUpdate: { written: wrote.written.length, refreshed: wrote.refreshed.length, superseded: wrote.superseded } })
          }
        }
      }
    } finally {
      budget.stop()
    }
    // One stamp, read twice. The expiry notice quotes how long checking took
    // and the stat line prints the same span as "Ns checking"; taken from two
    // `Date.now()` calls they can round to different tenths, and a screen that
    // states one quantity twice must state it identically both times.
    const tailEndedAt = Date.now()
    // The deadline fired and it cost the reader something: name it, rather than
    // letting a check the app skipped look like a check that passed.
    const notice = budget.notice(tailEndedAt)
    if (notice) {
      checks.push(notice)
      patch({ checks: [...checks] })
    }
    // The tail is over, so the turn's real length is finally known. `totalMs`
    // stays the stream — tok/s is a rate of that — and this is what the reader
    // actually waited, from the turn's open rather than from the first request
    // (lib/turnCost.ts).
    if (lastStats) patch({ stats: { ...lastStats, turnMs: tailEndedAt - turnOpenedAt } })
    verifying(null)
  }

  return { run: runVerificationTail }
}

/** What `offerEscalation` reads. */
export interface EscalationContext {
  conversationId: string
  routingNote: string | undefined
  stopReason: AgentLoopStopReason
  slot: ModelConfig
  assistantMsg: ChatMessage
  patch: (p: Partial<ChatMessage>) => void
}

export function offerEscalation({ conversationId, routingNote, stopReason, slot, assistantMsg, patch }: EscalationContext): void {
    if (routingNote?.startsWith('escalated to')) return // no escalation chains
    const state = useAppStore.getState()
    if (!state.settings) return
    const finalMsg = state.conversations
      .find((c) => c.id === conversationId)
      ?.messages.find((m) => m.id === assistantMsg.id)
    const reason = escalationReason(finalMsg ?? {}, stopReason)
    if (!reason) return
    const candidate = escalationCandidate(slot, state.settings.models, (s) =>
      budgetContextLength(s, state.availableModels.find((m) => m.id === s.modelId))
    )
    if (!candidate) return
    patch({ escalation: { slotId: candidate.id, roleName: candidate.roleName, reason } })
  
}
