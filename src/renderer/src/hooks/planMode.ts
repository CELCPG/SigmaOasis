import { useAppStore } from '../stores/appStore'
import { toolsForSlot, withBudgetNotes } from '../lib/toolSelection'
import { withGrounding, withToolCallPreamble } from '../lib/grounding'
import { runAgentLoop, TOOL_TURN_BUDGETS, type ApiMessage } from '../lib/agentLoop'
import type {
  ChatMessage,
  ChatPlan,
  Conversation,
  ModelConfig,
  PlanStep,
  ToolSchema
} from '../types'
import { makeTailStream, streamChat } from './chatTransport'
import { audit, subsetForTurn, uid } from './turnHelpers'

/**
 * Plan mode (v0.9): decompose a task into a visible checklist, gate on
 * approval, execute the steps as bounded sub-turns, and synthesize the answer.
 * Extracted verbatim from useLMStudio.ts in v1.4.8. `runPlanTurn` takes the
 * chat turn runner as a parameter rather than importing the hook, which keeps
 * the module graph acyclic.
 */

// ---- Plan mode (v0.9) --------------------------------------------------------

/** Step outputs are capped: a plan of 10 steps must still fit the synthesis turn. */
export const MAX_STEP_OUTPUT_CHARS = 2000
/** Tighter than chat's tool loop — each step is a bounded sub-task, not a conversation. */
export const MAX_PLAN_STEP_ITERATIONS = 4
/** The synthesis turn sees all step results; cap the block so it cannot crowd out the task. */
export const MAX_PLAN_RESULTS_CHARS = 12_000
/** Conversation carried into planning, each step, and the synthesis. */
export const MAX_PLAN_CONTEXT_CHARS = 4000

/**
 * The conversation so far, for a plan that is about to run without it.
 *
 * v1.4.5. Planning took the user's message and nothing else — no history for
 * the planner, none for any step, none for the synthesis. On a follow-up that
 * is the whole task: asked to "update to the proposed route 8 stops" one turn
 * after proposing an 8-stop route, the planner wrote six steps about a route it
 * could not see, every step reported missing input data, and the synthesis told
 * the user their request "cannot be completed at this time" and asked them to
 * supply the route the assistant had itself written a minute earlier.
 *
 * Newest turns first, oldest dropped: a follow-up refers to what just happened.
 */
export function planContext(messages: ChatMessage[]): string {
  const lines: string[] = []
  let used = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.marker || !m.content.trim()) continue
    const line = `${m.role === 'user' ? 'User' : m.roleName || 'Assistant'}: ${m.content.trim()}`
    if (used + line.length > MAX_PLAN_CONTEXT_CHARS) break
    lines.unshift(line)
    used += line.length
  }
  return lines.join('\n\n')
}

/**
 * Pending plan approvals, keyed by assistant message id. The Approve/Cancel
 * buttons in PlanBlock resolve these; an aborted stream resolves false so the
 * executor never hangs waiting on a dialog the user already walked away from.
 */
export const planApprovals = new Map<string, (approved: boolean) => void>()

/**
 * Execute one plan step: a bounded sub-turn with the normal tool list and a
 * tighter iteration cap. Tool calls are audit-logged like any chat turn's.
 * Returns the step's result, capped.
 */
export async function runPlanStep(
  slot: ModelConfig,
  input: string,
  baseUrl: string,
  tools: ToolSchema[],
  signal: AbortSignal,
  convo: Conversation,
  context: string
): Promise<string> {
  const apiMessages: ApiMessage[] = [
    {
      role: 'system',
      content:
        `${withToolCallPreamble(withGrounding(slot.systemPrompt), slot.modelId)}\n\nYou are executing one step of a larger plan. Produce the ` +
        `step's result directly and concisely — later steps and the final answer build on it.` +
        // Without this a step cannot see what the conversation already settled,
        // and reports the absence as missing input rather than reading it.
        (context
          ? `\n\nThe conversation this plan came from, for reference — anything already ` +
            `established here is input to your step, not something to ask for again:\n${context}`
          : '')
    },
    { role: 'user', content: input }
  ]

  let answer = ''
  await runAgentLoop({
    messages: apiMessages,
    tools: await subsetForTurn(toolsForSlot(slot, tools), input),
    // Step tool calls are audit-logged like any chat turn's, but not displayed.
    records: [],
    signal,
    maxIterations: MAX_PLAN_STEP_ITERATIONS,
    deps: {
      streamRound: async (messages, roundTools) => {
        let roundContent = ''
        const { toolCalls } = await streamChat(
          baseUrl,
          slot.modelId,
          messages,
          roundTools,
          signal,
          (chunk) => {
            roundContent += chunk
          },
          undefined,
          slot.sampling
        )
        answer = roundContent || answer
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

  const trimmed = answer.trim()
  return trimmed.length > MAX_STEP_OUTPUT_CHARS
    ? `${trimmed.slice(0, MAX_STEP_OUTPUT_CHARS)}\n… [step output truncated]`
    : trimmed || '(empty result)'
}

/**
 * Run a planned turn: decompose the task into a visible checklist, wait for
 * approval when configured, execute the steps sequentially, then synthesize
 * the final answer from the step results. Planning happens in the main
 * process (structured JSON); execution streams here like any turn.
 *
 * Failure philosophy, matching deep_research: a planning failure falls back
 * to answering directly; a failed step is marked failed and disclosed in the
 * synthesis, never silently retried.
 */
export async function runPlanTurn(
  conversationId: string,
  slot: ModelConfig,
  baseUrl: string,
  tools: ToolSchema[],
  signal: AbortSignal,
  task: string,
  /**
   * The ordinary chat turn, for the planning-failed fallback. Passed in rather
   * than imported: runTurn lives in useLMStudio.ts, which imports this module.
   */
  runTurn: (
    conversationId: string,
    slot: ModelConfig,
    baseUrl: string,
    tools: ToolSchema[],
    signal: AbortSignal
  ) => Promise<void>
): Promise<void> {
  const store = useAppStore.getState()
  const convo = store.conversations.find((c) => c.id === conversationId)
  if (!convo) return
  const settings = store.settings
  if (!settings) return

  await window.api.pinModel(slot.modelId).catch(() => false)

  // 1. Plan, before any placeholder message exists: a failure simply becomes
  // a normal turn, which is the honest degradation.
  // The turn being planned is the last message; everything before it is what
  // the plan has to be written against.
  const context = planContext(convo.messages.slice(0, -1))
  const gen = await window.api.planGenerate(
    task,
    slot.modelId,
    settings.plan.maxSteps,
    context || undefined
  )
  if (signal.aborted) return
  if (!gen.ok || !gen.steps || gen.steps.length === 0) {
    patchPlanErrorNotice(conversationId, gen.error ?? 'the model did not produce a usable plan')
    await runTurn(conversationId, slot, baseUrl, tools, signal)
    return
  }

  const assistantMsg: ChatMessage = {
    id: uid(),
    role: 'assistant',
    content: '',
    modelId: slot.modelId,
    roleName: slot.roleName,
    color: slot.color,
    toolCalls: [],
    plan: {
      steps: gen.steps.map((s) => ({ id: uid(), title: s.title, detail: s.detail, status: 'pending' })),
      approved: !settings.plan.confirmPlan,
      createdAt: Date.now()
    },
    createdAt: Date.now()
  }
  store.appendMessage(conversationId, assistantMsg)
  const patch = (p: Partial<ChatMessage>): void =>
    useAppStore.getState().patchMessage(conversationId, assistantMsg.id, p)
  const currentPlan = (): ChatPlan | undefined =>
    useAppStore
      .getState()
      .conversations.find((c) => c.id === conversationId)
      ?.messages.find((m) => m.id === assistantMsg.id)?.plan
  const patchStep = (stepId: string, p: Partial<PlanStep>): void => {
    const plan = currentPlan()
    if (!plan) return
    patch({
      plan: { ...plan, steps: plan.steps.map((s) => (s.id === stepId ? { ...s, ...p } : s)) }
    })
  }

  // 2. Approval gate (Settings → General → Plan mode). Off = auto-approve.
  if (settings.plan.confirmPlan) {
    const approved = await new Promise<boolean>((resolve) => {
      planApprovals.set(assistantMsg.id, resolve)
      signal.addEventListener('abort', () => resolve(false), { once: true })
    })
    planApprovals.delete(assistantMsg.id)
    const plan = currentPlan()
    if (!approved) {
      if (plan) patch({ plan: { ...plan, approved: false }, content: 'Plan cancelled — nothing was executed.' })
      return
    }
    if (plan) patch({ plan: { ...plan, approved: true } })
  }

  // 3. Execute steps sequentially; each sees the capped results of the ones before.
  const completed: { title: string; output: string }[] = []
  let haltedBy: string | null = null
  const plan = currentPlan()
  if (!plan) return
  for (let i = 0; i < plan.steps.length; i++) {
    if (signal.aborted) return
    const step = plan.steps[i]!
    patchStep(step.id, { status: 'running' })

    const stepInput =
      `Step ${i + 1} of ${plan.steps.length}: ${step.title}\n${step.detail}` +
      (completed.length > 0
        ? `\n\nResults of previous steps:\n${completed
            .map((o, j) => `${j + 1}. ${o.title}:\n${o.output}`)
            .join('\n\n')}`
        : '')

    try {
      const output = await runPlanStep(slot, stepInput, baseUrl, tools, signal, convo, context)
      patchStep(step.id, { status: 'done', output })
      completed.push({ title: step.title, output })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      patchStep(step.id, { status: 'failed', output: message })
      // A failed step poisons everything built on it: halt, and let the
      // synthesis say plainly what that leaves unanswered.
      haltedBy = `Step ${i + 1} ("${step.title}") failed: ${message}`
      break
    }
  }
  if (signal.aborted) return

  // 4. Synthesize the final answer from the step results.
  let resultsBlock = plan.steps
    .map((s, i) => {
      const latest = currentPlan()?.steps.find((p) => p.id === s.id) ?? s
      return `${i + 1}. [${latest.status}] ${latest.title}\n${latest.output ?? '(no output)'}`
    })
    .join('\n\n')
  if (resultsBlock.length > MAX_PLAN_RESULTS_CHARS) {
    resultsBlock = `${resultsBlock.slice(0, MAX_PLAN_RESULTS_CHARS)}\n… [later step results truncated]`
  }

  const synthesis: ApiMessage[] = [
    {
      role: 'system',
      content:
        withGrounding(slot.systemPrompt) +
        (context ? `\n\nThe conversation this task came from:\n${context}` : '')
    },
    {
      role: 'user',
      content:
        `Original task: ${task}\n\nA step-by-step plan was executed. Results:\n\n${resultsBlock}\n\n` +
        (haltedBy
          ? `${haltedBy}. Answer using what the completed steps produced, and state plainly what the failed step leaves unanswered.`
          : 'Answer the original task using these results.') +
        // v1.4.6: the plan is the app's scaffolding, not something the user
        // saw. A measured run opened with "Step 1 returned no results and Step
        // 3 lists Spring Lake", which reads to the user as a reference to a
        // document that does not exist.
        '\n\nThe user never saw this plan or its steps. Write the answer as your own work: no ' +
        'step numbers, no mention of a plan. If something could not be established, say what ' +
        'is missing in ordinary terms.' +
        // And the reason it needs tools at all: when the steps came back empty
        // the model wanted to search, had nothing to call, and emitted
        // `google_search("...")` in a Python fence as though that were a tool.
        '\n\nYou still have your tools here. If the results are thin, use them rather than ' +
        'describing a search you did not run.'
    }
  ]

  let content = ''
  const tail = makeTailStream(assistantMsg, patch)
  try {
    await runAgentLoop({
    messages: synthesis,
    // The same allowlist any turn gets, with budgets stated. Without tools the
    // synthesis could only fabricate; with them it can actually close the gap.
    tools: withBudgetNotes(await subsetForTurn(toolsForSlot(slot, tools), task), TOOL_TURN_BUDGETS),
    records: [],
    signal,
    maxIterations: MAX_PLAN_STEP_ITERATIONS,
    deps: {
      streamRound: async (messages, roundTools) => {
        let roundContent = ''
        const { toolCalls } = await streamChat(
          baseUrl,
          slot.modelId,
          messages,
          roundTools,
          signal,
          (chunk) => {
            roundContent += chunk
            assistantMsg.content += chunk
            tail.schedule()
          },
          undefined,
          slot.sampling
        )
        content += roundContent
        tail.commit()
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
  } finally {
    tail.finish()
  }
  if (!signal.aborted) {
    audit(convo, {
      kind: 'assistant_output',
      roleName: slot.roleName,
      modelId: slot.modelId,
      text: assistantMsg.content
    })
  }
}

/** A planning failure becomes a normal turn; the notice explains why. */
export function patchPlanErrorNotice(conversationId: string, error: string): void {
  useAppStore.getState().appendMessage(conversationId, {
    id: uid(),
    role: 'assistant',
    content: `📋 Planning failed (${error}) — answering directly instead.`,
    marker: 'notice',
    createdAt: Date.now()
  })
}
