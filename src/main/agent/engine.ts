import {
  createTurnToolLedger,
  runAgentLoop,
  type AgentLoopStopReason,
  type ApiMessage
} from '../../renderer/src/lib/agentLoop'
import { defaultShell } from './command'
import { fitContext, historyBudget } from './context'
import { agentSystemPrompt, gitBranch, loadProjectNotes, subagentSystemPrompt, topLevel, type PromptEnv } from './prompts'
import { streamRound } from './stream'
import { newTaskState, taskSchema, TODO_SCHEMA, Toolbox, WRITING_TOOLS, type TaskState } from './tools'
import type {
  AgentHost,
  AgentTaskResult,
  AgentTaskSpec,
  PermissionMode,
  SubagentType,
  ToolCallRecord,
  ToolResult,
  ToolSchema
} from './types'

/**
 * The agent engine (v3.0): one task, start to finish.
 *
 * The loop itself is the chat's (renderer/src/lib/agentLoop.ts) — a pure state
 * machine with argument validation and a free repair round, repeat-call reuse,
 * per-tool budgets, recovery for a call written as prose and for an answer
 * written into the thinking channel. Every one of those was measured on the
 * same local models this engine drives, so the agent inherits them rather
 * than re-learning them. What is the agent's own sits around it:
 *
 * - its tools (./tools.ts), its prompt (./prompts.ts) and a round cap sized
 *   for real work instead of the chat's eight;
 * - context fitting before every request (./context.ts), so a long task sheds
 *   old tool output rather than falling off the end of the window;
 * - helpers (`task`), each a nested loop with a fresh context and its own
 *   tools, whose calls are filed under the call that started them;
 * - repeat-call reuse is kept for reads only while nothing has changed: any
 *   write or command clears it, because re-reading a file after editing it
 *   must read the file, not replay the old contents.
 */

export const DEFAULT_MAX_ROUNDS = 40
export const SUBAGENT_MAX_ROUNDS = 20
export const DEFAULT_COMMAND_TIMEOUT_SEC = 120
/**
 * A ceiling on one round's generation, thinking included, when the slot sets
 * none. Measured: qwen3.8-35b-a3b-distill spends one to three minutes
 * thinking before each call of an ordinary bug fix, and with no cap and a
 * 262K window a model caught in a reasoning loop has nothing to stop it for
 * an hour. At the cap the loop's thinking-channel recovery takes over.
 */
export const DEFAULT_ROUND_MAX_TOKENS = 16_384
/** A helper's report is handed to the parent whole up to this length. */
const REPORT_MAX_CHARS = 8_000

/**
 * Budgets for the expensive tools (Layer 3c in the chat): a helper is a whole
 * nested task, and web tools leave the machine. Workspace tools are local and
 * covered by the round cap.
 */
const AGENT_TOOL_BUDGETS: Record<string, number> = {
  task: 8,
  web_search: 8,
  fetch_webpage: 12,
  deep_research: 2
}

function subagentTypes(permission: PermissionMode, hasWorkspace: boolean): SubagentType[] {
  if (!hasWorkspace) return ['general']
  return permission === 'readOnly' ? ['explore', 'review'] : ['explore', 'review', 'general']
}

interface RunContext {
  spec: AgentTaskSpec
  host: AgentHost
  state: TaskState
  env: Omit<PromptEnv, 'tools'>
  completionTokens: number
  promptTokens?: number
}

/** Run one turn of a task. Never throws: a failure is a status with a reason. */
export async function runAgentTask(spec: AgentTaskSpec, host: AgentHost): Promise<AgentTaskResult> {
  const shell = host.shell ?? defaultShell()
  const state = newTaskState()
  const root = spec.workspace
  const [notes, listing, branch] = root
    ? await Promise.all([loadProjectNotes(root), topLevel(root), gitBranch(root)])
    : [null, [] as string[], null]
  const run: RunContext = {
    spec,
    host,
    state,
    env: {
      workspace: root,
      permission: spec.permission,
      shell,
      platform: process.platform,
      now: spec.now ?? new Date(),
      notes,
      listing,
      branch,
      rules: spec.rules
    },
    completionTokens: 0
  }

  const toolbox = new Toolbox({
    root,
    permission: spec.permission,
    host,
    shell,
    commandTimeoutSec: spec.commandTimeoutSec ?? DEFAULT_COMMAND_TIMEOUT_SEC,
    state,
    signal: spec.signal
  })
  const types = subagentTypes(spec.permission, Boolean(root))
  const tools: ToolSchema[] = [...toolbox.schemas(), TODO_SCHEMA, taskSchema(types), ...(host.extraTools?.schemas ?? [])]
  const system = agentSystemPrompt({ ...run.env, tools: tools.map((t) => t.function.name) })

  // A later turn of the same conversation continues the same history, with a
  // fresh system prompt (the date, the permission mode and SIGMA.md may all
  // have changed since).
  const messages: ApiMessage[] =
    spec.history && spec.history.length > 0
      ? [{ role: 'system', content: system }, ...spec.history.filter((m) => m.role !== 'system')]
      : [{ role: 'system', content: system }]
  messages.push({ role: 'user', content: spec.prompt })

  host.emit({ type: 'status', status: 'running' })
  let finalText = ''
  let stopReason: AgentLoopStopReason | 'error' = 'error'
  let detail: string | undefined
  try {
    const outcome = await loop(run, {
      messages,
      tools,
      toolbox,
      maxRounds: spec.maxRounds ?? DEFAULT_MAX_ROUNDS,
      parentCallId: null,
      onFinalText: (t) => (finalText = t),
      subagentTypes: types
    })
    stopReason = outcome
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err)
  }

  const status =
    stopReason === 'completed' ? 'done' : stopReason === 'aborted' ? 'stopped' : stopReason === 'iteration_cap' ? 'paused' : 'error'
  // The loop leaves the closing reply off the wire history — the chat keeps
  // it as the visible message instead — so the next turn of this task would
  // not know what it last said. It goes on here, as text alone: the reasoning
  // that preceded it is never replayed (the chat's rule since v1.9).
  if (status === 'done' && finalText.trim()) messages.push({ role: 'assistant', content: finalText })
  if (status === 'paused') {
    detail = `Paused after ${spec.maxRounds ?? DEFAULT_MAX_ROUNDS} rounds. Say “continue” to let it keep going.`
  }
  host.emit({ type: 'status', status, ...(detail ? { detail } : {}) })
  return {
    status,
    finalText,
    history: messages.filter((m) => m.role !== 'system'),
    todos: state.todos,
    changedFiles: [...state.checkpoints.keys()],
    checkpoints: [...state.checkpoints.values()],
    ...(detail ? { detail } : {})
  }
}

interface LoopOptions {
  messages: ApiMessage[]
  tools: ToolSchema[]
  toolbox: Toolbox
  maxRounds: number
  /** Set for a helper: its calls are filed under this record. */
  parentCallId: string | null
  onFinalText: (text: string) => void
  subagentTypes: SubagentType[]
}

async function loop(run: RunContext, o: LoopOptions): Promise<AgentLoopStopReason> {
  const { spec, host } = run
  const isHelper = o.parentCallId !== null
  const ledger = createTurnToolLedger()
  const records: ToolCallRecord[] = []
  const started = new Set<string>()
  const toolChars = JSON.stringify(o.tools).length
  const budget = historyBudget(spec.contextTokens)
  let round = 0

  const outcome = await runAgentLoop({
    messages: o.messages,
    tools: o.tools,
    records,
    signal: spec.signal,
    maxIterations: o.maxRounds,
    toolBudgets: AGENT_TOOL_BUDGETS,
    ledger,
    onRecordChange: (record) => {
      const shown: ToolCallRecord = o.parentCallId ? { ...record, parentCallId: o.parentCallId } : { ...record }
      if (!started.has(record.id)) {
        started.add(record.id)
        host.emit({ type: 'tool_start', record: shown })
      } else if (record.status !== 'running') {
        host.emit({ type: 'tool_end', record: shown })
      }
    },
    deps: {
      streamRound: async (messages, tools) => {
        round++
        if (!isHelper) host.emit({ type: 'round', round })
        // A command's result is never reused across rounds — the world it
        // reports on may have moved (./engine.ts header).
        for (const key of [...ledger.previousCalls.keys()]) if (key.startsWith('run_command ')) ledger.previousCalls.delete(key)
        const fit = fitContext(messages, budget, toolChars)
        if (fit.elided > 0 || fit.droppedRounds > 0) host.emit({ type: 'context_elided', toolResults: fit.elided, chars: fit.chars })
        const result = await streamRound({
          baseUrl: spec.baseUrl,
          model: spec.model,
          messages,
          tools,
          sampling: { max_tokens: DEFAULT_ROUND_MAX_TOKENS, ...spec.sampling },
          signal: spec.signal,
          transport: host.transport,
          // A helper's words are its report, delivered as the task call's
          // result; they do not stream into the parent's reply.
          onContent: isHelper ? undefined : (delta) => host.emit({ type: 'text', delta }),
          onReasoning: isHelper ? undefined : (delta) => host.emit({ type: 'reasoning', delta })
        })
        run.completionTokens += result.usage?.completion_tokens ?? 0
        if (run.promptTokens === undefined && result.usage?.prompt_tokens !== undefined) run.promptTokens = result.usage.prompt_tokens
        if (!isHelper) host.emit({ type: 'usage', promptTokens: run.promptTokens, completionTokens: run.completionTokens })
        // A round that ends in calls is narration on the way to them; the
        // reply the user reads is the round that ends without one.
        if (result.toolCalls.length === 0) o.onFinalText(result.content)
        return { content: result.content, toolCalls: result.toolCalls, reasoning: result.reasoning }
      },
      executeTool: async (name, args, meta) => {
        const callId = meta?.callId ?? ''
        let result: ToolResult
        if (name === 'task') {
          result = isHelper
            ? { ok: false, error: 'A helper cannot start helpers of its own. Do the work yourself.' }
            : await runHelper(run, args, callId, o.subagentTypes)
        } else if (o.toolbox.has(name)) {
          result = await o.toolbox.execute(name, args, callId)
        } else if (run.host.extraTools?.schemas.some((s) => s.function.name === name)) {
          result = await run.host.extraTools.execute(name, args, callId)
        } else {
          result = { ok: false, error: `There is no tool named "${name}". Use one of: ${o.tools.map((t) => t.function.name).join(', ')}.` }
        }
        // Anything that changed the workspace (or might have) invalidates
        // every result reuse could hand back.
        if (WRITING_TOOLS.has(name) || name === 'task') ledger.previousCalls.clear()
        return result
      },
      takePendingMessages: isHelper ? undefined : spec.takeSteers,
      onSteerDelivered: isHelper ? undefined : (steer, r) => host.emit({ type: 'steer_delivered', id: steer.id, round: r })
    }
  })
  return outcome.stopReason
}

/** The `task` tool: a helper with a fresh context, its own tools, one report back. */
async function runHelper(run: RunContext, args: Record<string, unknown>, callId: string, allowed: SubagentType[]): Promise<ToolResult> {
  const type = String(args.subagent_type ?? '') as SubagentType
  if (!allowed.includes(type)) {
    return { ok: false, error: `subagent_type must be one of: ${allowed.join(', ')}.` }
  }
  const prompt = String(args.prompt ?? '').trim()
  if (!prompt) return { ok: false, error: 'Give the helper a prompt: complete instructions, including what to report.' }
  const description = String(args.description ?? type).trim().slice(0, 80)
  const { spec, host } = run
  const permission: PermissionMode = type === 'general' ? spec.permission : 'readOnly'
  const toolbox = new Toolbox({
    root: spec.workspace,
    permission,
    host,
    shell: run.env.shell,
    commandTimeoutSec: spec.commandTimeoutSec ?? DEFAULT_COMMAND_TIMEOUT_SEC,
    state: run.state,
    signal: spec.signal
  })
  // Read-only helpers get the workspace's read tools; a general helper gets
  // what the parent has, minus todo_write (the checklist is the parent's)
  // and task (helpers do not nest).
  const extra = type === 'general' ? (host.extraTools?.schemas ?? []) : []
  const tools = [...toolbox.schemas(), ...extra]
  const system = subagentSystemPrompt(type, { ...run.env, permission, tools: tools.map((t) => t.function.name) })
  const messages: ApiMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: prompt }
  ]
  let report = ''
  const outcome = await loop(run, {
    messages,
    tools,
    toolbox,
    maxRounds: SUBAGENT_MAX_ROUNDS,
    parentCallId: callId,
    onFinalText: (t) => (report = t),
    subagentTypes: []
  })
  if (outcome === 'aborted') return { ok: false, error: 'The task was stopped while the helper was working.' }
  const capped = outcome === 'iteration_cap' ? `\n\n(The helper stopped at its ${SUBAGENT_MAX_ROUNDS}-round limit; this report may be incomplete.)` : ''
  const body = report.trim() || '(The helper finished without writing a report.)'
  const text = body.length > REPORT_MAX_CHARS ? `${body.slice(0, REPORT_MAX_CHARS)}\n… [report cut at ${REPORT_MAX_CHARS} characters]` : body
  return { ok: true, output: `Report from the ${type} helper (${description}):\n\n${text}${capped}` }
}
