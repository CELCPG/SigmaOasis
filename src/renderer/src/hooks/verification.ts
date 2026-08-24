import { useAppStore } from '../stores/appStore'
import { toolsForSlot, withBudgetNotes } from '../lib/toolSelection'
import { buildCriticMessages, NO_REVIEW_TEXT, pickCritic } from '../lib/secondOpinion'
import {
  buildRecomputeMessages,
  buildRecomputeReference,
  codeFailureFinding,
  describeRecompute,
  extractRecomputeProgram,
  isSelfContained,
  longestPythonFence,
  recomputeIsCircular,
  LAUNDERED_OUTPUT_MARKER
} from '../lib/workbenchChecks'
import { parseRanCode } from '../lib/ranCode'
import type { WorkbenchCheck } from '../lib/workbenchChecks'
import {
  buildReviewMessages,
  buildRevisionMessages,
  classifyReview,
  figuresChanged,
  pickReviewer
} from '../lib/deliberation'
import { withGrounding, withToolCallPreamble } from '../lib/grounding'
import { describeGroundingFindings } from '../lib/toolGrounding'
import {
  abandonClaims,
  buildExtractionMessages,
  buildJudgeMessages,
  claimCheckBlocked,
  firstResultUrl,
  parseClaims,
  parseVerdict,
  searchUnreachable,
  UNREACHABLE_NOTE
} from '../lib/claimCheck'
import { runAgentLoop, TOOL_TURN_BUDGETS, type ApiMessage } from '../lib/agentLoop'
import type {
  ChatMessage,
  CheckedClaim,
  ClaimCheckRecord,
  Conversation,
  DeliberationRecord,
  GroundingReport,
  ModelConfig,
  SecondOpinionRecord,
  ToolCallRecord,
  ToolSchema
} from '../types'
import { streamChat } from './chatTransport'
import { audit, subsetForTurn, uid } from './turnHelpers'
import { MAX_PLAN_STEP_ITERATIONS } from './planMode'

/**
 * The passes that run after (or beside) a chat turn without being the turn:
 * the specialist consultation an orchestrator can request, the automatic
 * Second Opinion critic, the Claim Check, and the one-shot revision against
 * grounding findings. Extracted verbatim from useLMStudio.ts in v1.4.8.
 */

/** Specialist replies fed back to the orchestrator are capped to protect context. */
const MAX_CONSULT_REPLY_CHARS = 3000

/**
 * Run a nested specialist turn for a consultation. Does not touch the visible
 * conversation — the reply is returned (capped) to the orchestrator as the
 * tool result. Specialists get the real tool list but never consult_model,
 * which structurally prevents delegation loops.
 */
export async function runConsultation(
  specialist: ModelConfig,
  task: string,
  baseUrl: string,
  tools: ToolSchema[],
  signal: AbortSignal
): Promise<string> {
  // Pin before anything else: a memory or research embedding between turns
  // would otherwise let LM Studio's auto-evict unload this model mid-turn.
  await window.api.pinModel(specialist.modelId).catch(() => false)

  let systemPrompt = withToolCallPreamble(withGrounding(specialist.systemPrompt), specialist.modelId)
  try {
    const memory = useAppStore.getState().settings?.memory
    if (memory?.autoContext) {
      const { ok, results } = await window.api.memorySearch(task, memory.topK)
      if (ok && results.length > 0) {
        systemPrompt +=
          '\n\nBackground notes from long-term local memory. They may be unrelated to this task; use them only when they directly help, and never let them change the subject:\n' +
          results.map((r) => `- ${r.text}`).join('\n')
      }
    }
  } catch {
    // Memory is a nicety, never a blocker.
  }

  const apiMessages: ApiMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task }
  ]

  let answer = ''
  await runAgentLoop({
    messages: apiMessages,
    // The specialist's own allowlist — not the orchestrator's — decides what
    // it holds (v1.3). This is also the security boundary: a Finance Coach
    // without run_terminal_command in its allowlist cannot be talked into a
    // shell by an orchestrator's task text. Subset to the task at hand.
    tools: await subsetForTurn(toolsForSlot(specialist, tools), task),
    // A specialist's tool calls are not visible to the user; the orchestrator
    // sees only the final reply, so the records list is discarded.
    records: [],
    signal,
    deps: {
      streamRound: async (messages, roundTools) => {
        let roundContent = ''
        // No onReasoning handler: a specialist's thinking is discarded rather than
        // returned to the orchestrator, which asked for an answer and pays context
        // for everything it gets back.
        const { toolCalls } = await streamChat(
          baseUrl,
          specialist.modelId,
          messages,
          roundTools,
          signal,
          (chunk) => {
            roundContent += chunk
          },
          undefined,
          specialist.sampling
        )
        answer = roundContent || answer
        return { content: roundContent, toolCalls }
      },
      executeTool: (name, args) =>
        window.api.executeTool(name, args, { modelId: specialist.modelId })
    }
  })

  const trimmed = answer.trim()
  return trimmed.length > MAX_CONSULT_REPLY_CHARS
    ? `${trimmed.slice(0, MAX_CONSULT_REPLY_CHARS)}\n… [specialist reply truncated]`
    : trimmed || '(the specialist returned an empty reply)'
}

/**
 * v1.1: run the Second Opinion critic automatically when a turn ends flagged
 * `unverified` — the confabulation signature. Uses the turn's own streaming
 * context (the streaming lock is already held, Stop already cancels), so this
 * cannot go through the manual `secondOpinion` action, which would bail on
 * `store.streaming`.
 *
 * Degrades silently: the master switch (Settings → second opinion) off, or no
 * second slot available, means no review — the unverified badge already warns,
 * and a critic-less turn must not ask the answerer to grade itself.
 */
export async function runAutoCritic(
  convo: Conversation,
  messageId: string,
  question: string,
  answer: string,
  answerer: { modelId?: string; roleName?: string },
  baseUrl: string,
  signal: AbortSignal
): Promise<void> {
  const settings = useAppStore.getState().settings
  if (!settings?.secondOpinion.enabled || !answer.trim()) return
  const critic = pickCritic(settings.models, answerer, settings.secondOpinion.criticSlotId)
  if (!critic) return
  if (signal.aborted) return

  await window.api.pinModel(critic.modelId).catch(() => false)
  const record: SecondOpinionRecord = {
    roleName: critic.roleName,
    modelId: critic.modelId,
    text: '',
    automatic: true,
    createdAt: Date.now()
  }
  const patchRecord = (text: string): void => {
    record.text = text
    useAppStore.getState().patchMessage(convo.id, messageId, { secondOpinion: { ...record } })
  }

  try {
    let text = ''
    await streamChat(
      baseUrl,
      critic.modelId,
      buildCriticMessages(critic, question, answer, answerer.roleName ?? 'The model'),
      [], // No tools: the critic names the check, it does not run it.
      signal,
      (chunk) => {
        text += chunk
        patchRecord(text)
      },
      undefined,
      critic.sampling
    )
    if (!signal.aborted && !text.trim()) patchRecord(NO_REVIEW_TEXT)
  } catch (err) {
    if (!signal.aborted) {
      patchRecord(`⚠️ Second opinion failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/**
 * v1.2 Claim Check: settle what the v1.1 auto-critic could only name.
 *
 * Runs when a turn ends flagged `unverified` and claim checking is enabled:
 * the critic slot (never the answerer) extracts the bare factual claims as
 * JSON; the app then checks each mechanically — one web_search plus at most
 * one fetch_webpage per claim, then a single-claim judgment against the
 * retrieved passage. No source within budget means "unverifiable", never a
 * verdict from model intuition.
 *
 * Searches the app runs here are audit-logged, appear as tool calls in the
 * bubble, and respect confirmBeforeSearch like any other search.
 */
export async function runClaimCheck(
  convo: Conversation,
  messageId: string,
  question: string,
  answer: string,
  answerer: { modelId?: string; roleName?: string },
  baseUrl: string,
  signal: AbortSignal,
  allRecords: ToolCallRecord[],
  patch: (p: Partial<ChatMessage>) => void
): Promise<void> {
  const settings = useAppStore.getState().settings
  if (!settings?.secondOpinion.enabled || !settings.claimCheck.enabled || !answer.trim()) return
  const critic = pickCritic(settings.models, answerer, settings.secondOpinion.criticSlotId)
  if (!critic || signal.aborted) return

  const record: ClaimCheckRecord = {
    roleName: critic.roleName,
    modelId: critic.modelId,
    claims: [],
    createdAt: Date.now()
  }
  const patchRecord = (): void =>
    useAppStore
      .getState()
      .patchMessage(convo.id, messageId, { claimCheck: { ...record, claims: [...record.claims] } })

  // The pass is worth a model round trip only if a source could settle
  // something. A switched-off search tool says no outright; this turn's own
  // failed searches say it just as plainly. Either way, say so now rather than
  // after an extraction and five searches that cannot come back with anything.
  const blocked = !settings.tools.web_search
    ? 'Could not check: web_search is switched off (Settings → Tools), so no claim could be checked against a source.'
    : claimCheckBlocked(allRecords)
  if (blocked) {
    record.budgetNote = blocked
    patchRecord()
    return
  }

  /** A tool call by the checker: recorded, displayed, and audited like any other. */
  const runTool = async (
    name: string,
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; output?: string; error?: string }> => {
    const rec: ToolCallRecord = { id: uid(), name, args, status: 'running' }
    allRecords.push(rec)
    patch({ toolCalls: [...allRecords] })
    const result: { ok: boolean; output?: string; error?: string } = await window.api
      .executeTool(name, args, { modelId: critic.modelId })
      .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
    rec.status = result.ok ? 'done' : 'error'
    rec.result = result.ok ? (result.output ?? '') : (result.error ?? 'Unknown tool error')
    patch({ toolCalls: [...allRecords] })
    audit(convo, {
      kind: 'tool_call',
      roleName: critic.roleName,
      modelId: critic.modelId,
      toolName: name,
      ok: result.ok,
      text: `${name}(${JSON.stringify(args)})\n→ ${result.ok ? (result.output ?? '') : `Error: ${result.error ?? 'unknown error'}`}`
    })
    return result
  }

  /** One non-streaming completion from the critic (its text arrives whole). */
  const complete = async (
    messages: { role: 'system' | 'user'; content: string }[]
  ): Promise<string> => {
    let text = ''
    await streamChat(
      baseUrl,
      critic.modelId,
      messages,
      [], // Extraction and judgment get no tools; the app runs the tools.
      signal,
      (chunk) => {
        text += chunk
      },
      undefined,
      critic.sampling
    )
    return text
  }

  try {
    await window.api.pinModel(critic.modelId).catch(() => false)
    patchRecord() // Show the block immediately so the pass is visible while it works.

    // 1. Extraction — the critic, not the answerer, names the checkable claims.
    const extracted = await complete(
      buildExtractionMessages(critic, question, answer, answerer.roleName ?? 'The model')
    )
    if (signal.aborted) return
    const { claims, truncated } = parseClaims(extracted, settings.claimCheck.maxClaims)
    if (truncated) {
      record.budgetNote = `Only the first ${settings.claimCheck.maxClaims} extracted claims were checked (per-reply cap).`
    }
    if (claims.length === 0) {
      record.budgetNote =
        record.budgetNote ?? 'The critic found no checkable factual claims in this answer.'
      patchRecord()
      return
    }

    // 2. Settlement — budget enforced in code: one search, at most one fetch,
    //    one judgment per claim.
    for (const [i, claim] of claims.entries()) {
      if (signal.aborted) return
      const checked: CheckedClaim = { text: claim, verdict: 'unverifiable' }
      const search = await runTool('web_search', { query: claim })
      // One refused connection settles the whole pass: the remaining claims
      // would each buy the same failure at the cost of another wait.
      if (!search.ok && searchUnreachable(search.error ?? '')) {
        record.claims.push(...abandonClaims(claims.slice(i)))
        record.budgetNote = UNREACHABLE_NOTE
        patchRecord()
        return
      }
      const url = search.ok && search.output ? firstResultUrl(search.output) : null
      let passage = ''
      if (url && settings.tools.fetch_webpage) {
        const page = await runTool('fetch_webpage', { url, query: claim })
        if (page.ok && page.output) {
          passage = page.output
          checked.source = url
        }
      }
      if (passage) {
        if (signal.aborted) return
        const judged = await complete(buildJudgeMessages(critic, claim, passage))
        if (signal.aborted) return
        const { verdict, basis } = parseVerdict(judged)
        checked.verdict = verdict
        if (basis) checked.basis = basis
      } else if (!search.ok) {
        // Declined (confirmBeforeSearch) or failed — disclosed, never guessed.
        checked.basis = 'Search was declined or failed.'
      }
      record.claims.push(checked)
      patchRecord()
    }
  } catch (err) {
    if (!signal.aborted) {
      record.budgetNote = `Claim check failed: ${err instanceof Error ? err.message : String(err)}`
      patchRecord()
    }
  }
}

/**
 * One revision pass over an answer the grounding check found fault with.
 *
 * Runs with the slot's real tools on purpose: the first option offered to the
 * model is to *verify* a flagged specific, not to delete it. An address it can
 * confirm is worth more than an address it removed, and a correction pass that
 * could only delete would make answers shorter rather than truer.
 *
 * Returns the corrected answer, or '' when nothing usable came back — the
 * caller then keeps the original, flagged.
 */
export async function reviseAgainstFindings(
  slot: ModelConfig,
  baseUrl: string,
  tools: ToolSchema[],
  signal: AbortSignal,
  convo: Conversation,
  answer: string,
  report: GroundingReport,
  records: ToolCallRecord[]
): Promise<string> {
  const findings = describeGroundingFindings(report)
  if (!findings) return ''

  // v1.6: when the app recomputed the figures, hand the revision that output
  // directly — the correct values exist and the fix is substitution, not
  // deletion. Measured without this: the revision disclaimed the numbers away
  // while the right ones sat in a tool record it never looked at.
  const recompute = [...records]
    .reverse()
    // …and never a run already marked as checking nothing: handing a circular
    // recomputation over as "correct values, already verified" is the same
    // contradiction the footer stopped making.
    .find(
      (r) =>
        r.name === 'run_python' &&
        r.status === 'done' &&
        !r.checksNothing &&
        /recomputing the figures/i.test(r.preamble ?? '')
    )
  const recomputeStdout = recompute?.result ? parseRanCode(recompute.result, true).stdout : ''
  const recomputeBlock = recomputeStdout ? `\n\n${buildRecomputeReference(recomputeStdout)}` : ''

  const messages: ApiMessage[] = [
    { role: 'system', content: withGrounding(slot.systemPrompt) },
    { role: 'user', content: `The answer you just gave:\n\n${answer}\n\n---\n${findings}${recomputeBlock}` }
  ]

  let revised = ''
  try {
    await runAgentLoop({
      messages,
      tools: withBudgetNotes(
        await subsetForTurn(toolsForSlot(slot, tools), answer.slice(0, 400)),
        TOOL_TURN_BUDGETS
      ),
      // Tool calls made while correcting join the turn's own record list, so
      // the work done to verify a figure is as visible as the work that
      // produced it.
      records,
      signal,
      maxIterations: MAX_PLAN_STEP_ITERATIONS,
      deps: {
        streamRound: async (roundMessages, roundTools) => {
          let roundContent = ''
          const { toolCalls } = await streamChat(
            baseUrl,
            slot.modelId,
            roundMessages,
            roundTools,
            signal,
            (chunk) => {
              roundContent += chunk
            },
            undefined,
            slot.sampling
          )
          revised = roundContent || revised
          return { content: roundContent, toolCalls }
        },
        executeTool: (name, args) => window.api.executeTool(name, args, { modelId: slot.modelId }),
        onToolExecuted: (record, result) => {
          audit(convo, {
            kind: 'tool_call',
            roleName: slot.roleName,
            modelId: slot.modelId,
            toolName: record.name,
            ok: result.ok,
            text: `${record.name}(${JSON.stringify(record.args)})\n→ ${result.ok ? (result.output ?? '') : `Error: ${result.error ?? 'unknown error'}`}`
          })
        }
      }
    })
  } catch {
    // A failed correction is not a failed turn. The original stands, flagged.
    return ''
  }
  return revised.trim()
}

/**
 * v1.5.1 Think harder: draft → review → revise, once, on a finished reply.
 * See lib/deliberation.ts for the rules and the disclosure. The reviewer is a
 * different slot when one exists; otherwise the answerer reviews its own
 * draft if settings.grounding.selfReview allows, labelled as such.
 */
export async function runDeliberation(
  convo: Conversation,
  messageId: string,
  question: string,
  draft: string,
  answerer: ModelConfig,
  baseUrl: string,
  signal: AbortSignal
): Promise<void> {
  const settings = useAppStore.getState().settings
  if (!settings || !draft.trim()) return
  const { slot: reviewer, self } = pickReviewer(settings.models, answerer, settings.secondOpinion.criticSlotId)
  const record: DeliberationRecord = {
    reviewerRole: reviewer.roleName,
    reviewerModelId: reviewer.modelId,
    self,
    status: 'reviewing',
    draft,
    review: '',
    revised: false,
    createdAt: Date.now()
  }
  const patchRecord = (p: Partial<DeliberationRecord>): void => {
    Object.assign(record, p)
    useAppStore.getState().patchMessage(convo.id, messageId, { deliberation: { ...record } })
  }
  if (self && settings.grounding.selfReview === false) {
    patchRecord({
      status: 'error',
      note: 'no second slot is enabled and self-review is off (Settings → Models)'
    })
    return
  }
  patchRecord({})

  try {
    await window.api.pinModel(reviewer.modelId).catch(() => false)
    let review = ''
    await streamChat(
      baseUrl,
      reviewer.modelId,
      buildReviewMessages(reviewer, question, draft, answerer.roleName, self),
      [],
      signal,
      (chunk) => {
        review += chunk
        patchRecord({ review })
      },
      undefined,
      // A cool reviewer: the job is to find what is wrong, not to be creative.
      { ...reviewer.sampling, temperature: Math.min(reviewer.sampling.temperature, 0.3) }
    )
    if (signal.aborted) return
    audit(convo, {
      kind: 'assistant_output',
      roleName: reviewer.roleName,
      modelId: reviewer.modelId,
      text: `[think harder — ${self ? 'self-review' : 'review'}]\n${review || '(nothing came back)'}`
    })
    // A review that never came back and a review that found nothing are
    // different states; both keep the draft, only one of them checked it, and
    // the disclosure (describeDeliberation) reads them apart off `review`.
    if (classifyReview(review) !== 'problems') {
      patchRecord({ status: 'done', revised: false })
      return
    }

    patchRecord({ status: 'revising' })
    await window.api.pinModel(answerer.modelId).catch(() => false)
    let revision = ''
    await streamChat(
      baseUrl,
      answerer.modelId,
      buildRevisionMessages(answerer, question, draft, review),
      [],
      signal,
      (chunk) => {
        revision += chunk
      },
      undefined,
      answerer.sampling
    )
    if (signal.aborted) return
    const clean = revision.trim()
    if (!clean) {
      patchRecord({ status: 'done', revised: false, note: 'the revision came back empty; draft kept.' })
      return
    }
    const { added, removed } = figuresChanged(draft, clean)
    const note =
      added.length || removed.length
        ? `Figures changed: ${removed.slice(0, 4).join(', ') || '—'} → ${added.slice(0, 4).join(', ') || '—'}.`
        : undefined
    useAppStore.getState().patchMessage(convo.id, messageId, { content: clean })
    patchRecord({ status: 'done', revised: true, note })
    audit(convo, {
      kind: 'assistant_output',
      roleName: answerer.roleName,
      modelId: answerer.modelId,
      text: `[think harder — revised]\n${clean}`
    })
  } catch (err) {
    if (!signal.aborted) {
      patchRecord({ status: 'error', note: err instanceof Error ? err.message : String(err) })
    }
  }
}

/**
 * v1.6 Workbench verification — recompute (see lib/workbenchChecks.ts).
 * Asks the answerer for a Python program that recomputes its stated figures,
 * runs it as a real run_python record (visible as "Ran Python"), and returns
 * the disclosure line. The grounding pass that follows judges the reply's
 * figures against that stdout.
 */
export async function runRecompute(
  convo: Conversation,
  slot: ModelConfig,
  baseUrl: string,
  question: string,
  answer: string,
  records: ToolCallRecord[],
  toolContext: { modelId?: string; attachments?: { name: string; sourcePath: string }[] },
  signal: AbortSignal,
  onRecords: () => void
): Promise<WorkbenchCheck> {
  let text = ''
  try {
    await streamChat(
      baseUrl,
      slot.modelId,
      buildRecomputeMessages(slot, question, answer),
      [],
      signal,
      (chunk) => {
        text += chunk
      },
      undefined,
      { ...slot.sampling, temperature: 0 }
    )
  } catch (err) {
    return describeRecompute({ ran: false, ok: false, note: err instanceof Error ? err.message : String(err) })
  }
  if (signal.aborted) return describeRecompute({ ran: false, ok: false, note: 'cancelled' })
  const code = extractRecomputeProgram(text)
  if (!code) return describeRecompute({ ran: false, ok: false, note: 'the model did not return a program' })
  const record: ToolCallRecord = {
    id: uid(),
    name: 'run_python',
    args: { code },
    status: 'running',
    preamble: 'App-initiated: recomputing the figures stated in the answer.'
  }
  records.push(record)
  onRecords()
  const result: { ok: boolean; output?: string; error?: string } = await window.api
    .executeTool('run_python', { code, timeout_seconds: 30 }, toolContext)
    .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
  record.status = result.ok ? 'done' : 'error'
  record.result = result.ok ? (result.output ?? '') : (result.error ?? 'Unknown tool error')
  // A run whose inputs the model invented — or whose output the sandbox marked
  // as pure literals — checked nothing, whatever its exit status. Marked on the
  // record itself so the grounding footer cannot go on to name it as something
  // the answer was checked against (v1.12.3).
  const circular = recomputeIsCircular(code, question) || (record.result ?? '').includes(LAUNDERED_OUTPUT_MARKER)
  if (circular) record.checksNothing = true
  onRecords()
  audit(convo, {
    kind: 'tool_call',
    roleName: slot.roleName,
    modelId: slot.modelId,
    toolName: 'run_python',
    ok: result.ok,
    text: `[recompute] run_python(${JSON.stringify({ code })})\n→ ${result.ok ? (result.output ?? '') : `Error: ${result.error ?? 'unknown error'}`}`
  })
  return describeRecompute({ ran: true, ok: result.ok, circular, note: result.ok ? undefined : 'the recomputation raised an error' })
}

/**
 * v1.6 Workbench verification — code check. Runs the reply's longest
 * self-contained Python block; returns the finding line for the grounding
 * report (null when it runs, or when the failure is environmental) and the
 * run record for the bubble.
 */
export async function runCodeCheck(
  convo: Conversation,
  slot: ModelConfig,
  answer: string,
  records: ToolCallRecord[],
  toolContext: { modelId?: string; attachments?: { name: string; sourcePath: string }[] },
  onRecords: () => void
): Promise<{ finding: string | null; ran: boolean; ok: boolean; note?: string }> {
  const code = longestPythonFence(answer)
  if (!code) return { finding: null, ran: false, ok: false, note: 'no Python block' }
  if (!isSelfContained(code)) return { finding: null, ran: false, ok: false, note: 'the code needs input, files or the network, so it cannot be checked in the sandbox' }
  const record: ToolCallRecord = {
    id: uid(),
    name: 'run_python',
    args: { code },
    status: 'running',
    preamble: 'App-initiated: running the Python in the answer to check that it works.'
  }
  records.push(record)
  onRecords()
  const result: { ok: boolean; output?: string; error?: string } = await window.api
    .executeTool('run_python', { code, timeout_seconds: 20 }, toolContext)
    .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
  record.status = result.ok ? 'done' : 'error'
  record.result = result.ok ? (result.output ?? '') : (result.error ?? 'Unknown tool error')
  onRecords()
  audit(convo, {
    kind: 'tool_call',
    roleName: slot.roleName,
    modelId: slot.modelId,
    toolName: 'run_python',
    ok: result.ok,
    text: `[code check] run_python(${JSON.stringify({ code })})\n→ ${result.ok ? (result.output ?? '') : `Error: ${result.error ?? 'unknown error'}`}`
  })
  if (result.ok) return { finding: null, ran: true, ok: true }
  const finding = codeFailureFinding(result.error ?? '')
  return { finding, ran: true, ok: false, note: finding ? undefined : 'the failure was environmental, not the code’s' }
}
