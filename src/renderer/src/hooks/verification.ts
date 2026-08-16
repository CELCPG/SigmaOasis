import { useAppStore } from '../stores/appStore'
import { toolsForSlot, withBudgetNotes } from '../lib/toolSelection'
import { buildCriticMessages, pickCritic } from '../lib/secondOpinion'
import { withGrounding, withToolCallPreamble } from '../lib/grounding'
import { describeGroundingFindings } from '../lib/toolGrounding'
import {
  buildExtractionMessages,
  buildJudgeMessages,
  firstResultUrl,
  parseClaims,
  parseVerdict
} from '../lib/claimCheck'
import { runAgentLoop, TOOL_TURN_BUDGETS, type ApiMessage } from '../lib/agentLoop'
import type {
  ChatMessage,
  CheckedClaim,
  ClaimCheckRecord,
  Conversation,
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
    if (!signal.aborted && !text.trim()) patchRecord('(the reviewer returned an empty reply)')
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

    if (!settings.tools.web_search) {
      record.claims = claims.map((text) => ({ text, verdict: 'unverifiable' as const }))
      record.budgetNote = 'web_search is disabled, so no claim could be checked against a source.'
      patchRecord()
      return
    }

    // 2. Settlement — budget enforced in code: one search, at most one fetch,
    //    one judgment per claim.
    for (const claim of claims) {
      if (signal.aborted) return
      const checked: CheckedClaim = { text: claim, verdict: 'unverifiable' }
      const search = await runTool('web_search', { query: claim })
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

  const messages: ApiMessage[] = [
    { role: 'system', content: withGrounding(slot.systemPrompt) },
    { role: 'user', content: `The answer you just gave:\n\n${answer}\n\n---\n${findings}` }
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
