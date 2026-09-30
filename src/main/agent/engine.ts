import {
  createTurnToolLedger,
  runAgentLoop,
  type AgentLoopStopReason,
  type ApiMessage
} from '../../renderer/src/lib/agentLoop'
import { defaultShell } from './command'
import { fitContext, historyBudget, LOW_WATER } from './context'
import { agentSystemPrompt, gitBranch, loadProjectNotes, subagentSystemPrompt, topLevel, type PromptEnv } from './prompts'
import { streamRound } from './stream'
import { skipThinking } from './phase'
import { claimsTestsPass } from './evalHarness'
import { THINK_TAG_MODELS } from '../../shared/thinking'
import { unifiedDiff } from '../../shared/patch'
import { fillHook, loadHooks, type HookMoment, type Hooks } from './hooks'
import { ensureWorktree, type Worktree } from './worktree'
import { planInView, setAsideFinishedStep, stepCompleted } from './plan'
import { ASK_USER_SCHEMA, newTaskState, taskSchema, TODO_SCHEMA, Toolbox, WRITING_TOOLS, type TaskState } from './tools'
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
  /** A5: when a file last changed in this task, and every command run — the verify round reads both. */
  lastEditAt: number
  commands: { command: string; ok: boolean; at: number }[]
  /** A8: the project's hooks, when the experiment is on and the file exists. */
  hooks: Hooks | null
  hookCount: number
  /** A6: the question ask_user posed this round; the loop pauses on it. */
  question: { question: string; choices: string[] } | null
  /** A4: a step was just marked completed; its output is set aside before the next round. */
  stepDone: boolean
}

/** Run one turn of a task. Never throws: a failure is a status with a reason. */
export async function runAgentTask(spec: AgentTaskSpec, host: AgentHost): Promise<AgentTaskResult> {
  const shell = host.shell ?? defaultShell()
  const state = newTaskState()
  // A9 (v4.0, an experiment): in a git repository the task works in its own
  // worktree on its own branch; the folder the user looks at is untouched.
  const worktree: Worktree | null =
    spec.workspace && spec.experiments?.worktrees ? await ensureWorktree(spec.workspace, spec.prompt, spec.worktree, spec.now).catch(() => null) : null
  const root = worktree?.path ?? spec.workspace
  const [notes, listing, branch, hooks] = root
    ? await Promise.all([
        loadProjectNotes(root, Boolean(spec.experiments?.notes)),
        topLevel(root),
        gitBranch(root),
        spec.experiments?.hooks ? loadHooks(root) : Promise.resolve(null)
      ])
    : [null, [] as string[], null, null]
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
      rules: spec.rules,
      experiments: spec.experiments,
      recipe: spec.experiments?.recipes ? spec.recipe : undefined
    },
    completionTokens: 0,
    lastEditAt: 0,
    commands: [],
    hooks,
    hookCount: 0,
    question: null,
    stepDone: false
  }

  const toolbox = new Toolbox({
    root,
    permission: spec.permission,
    host,
    shell,
    commandTimeoutSec: spec.commandTimeoutSec ?? DEFAULT_COMMAND_TIMEOUT_SEC,
    state,
    signal: spec.signal,
    experiments: spec.experiments
  })
  const types = subagentTypes(spec.permission, Boolean(root))
  // A6 (v4.0, an experiment): the task may ask the user and wait.
  const askUser = spec.experiments?.askUser ? [ASK_USER_SCHEMA] : []
  const tools: ToolSchema[] = [...toolbox.schemas(), TODO_SCHEMA, taskSchema(types), ...askUser, ...(host.extraTools?.schemas ?? [])]
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
    // A7 (v4.0, an experiment): before the report, a review helper reads the
    // diff of everything changed; what it finds becomes one more round.
    if (stopReason === 'completed' && spec.experiments?.reviewer && state.checkpoints.size > 0 && !spec.signal.aborted) {
      const findings = await reviewBeforeReport(run, state)
      if (findings) {
        messages.push({ role: 'user', content: `A review helper read the diff of everything this task changed and found:\n\n${findings}\n\nAddress what is real — fix it, or say why it is not a problem — then give the report.` })
        stopReason = await loop(run, { messages, tools, toolbox, maxRounds: Math.min(8, spec.maxRounds ?? DEFAULT_MAX_ROUNDS), parentCallId: null, onFinalText: (t) => (finalText = t), subagentTypes: types })
      }
    }
    // A5 (v4.0, an experiment): a verify round the report cannot skip. When a
    // file changed after the last successful command and a command is known,
    // one more round offers run_command only; a report that still claims a
    // passing check the timeline does not show is told so.
    if (stopReason === 'completed' && spec.experiments?.verifyRound && !spec.signal.aborted) {
      const verified = run.commands.some((c) => c.ok && c.at > run.lastEditAt)
      const candidate = [...run.commands].reverse().find((c) => c.command.trim())?.command
      if (!verified && run.lastEditAt > 0 && candidate) {
        messages.push({ role: 'user', content: `Files changed after the last check. Run \`${candidate}\` with run_command now, then give the report with its exit code. Do not report a check you did not run.` })
        const only = tools.filter((t) => t.function.name === 'run_command')
        stopReason = await loop(run, { messages, tools: only, toolbox, maxRounds: 3, parentCallId: null, onFinalText: (t) => (finalText = t), subagentTypes: [] })
      }
      const verifiedNow = run.commands.some((c) => c.ok && c.at > run.lastEditAt)
      if (run.lastEditAt > 0 && !verifiedNow && claimsTestsPass(finalText)) {
        finalText = `${finalText.trimEnd()}\n\n(No check ran after the last edit in this task, so the claim above is not backed by a command on the timeline.)`
        host.emit({ type: 'text', delta: '\n\n(No check ran after the last edit in this task, so the claim above is not backed by a command on the timeline.)' })
      }
    }
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err)
  }
  // A8: the task is over, whichever way; the project's on-end hooks run once.
  if (run.hooks && !spec.signal.aborted) await runHooks(run, toolbox, 'onEnd', {})

  const status =
    stopReason === 'completed' ? 'done' : stopReason === 'aborted' ? 'stopped' : stopReason === 'iteration_cap' || stopReason === 'paused' ? 'paused' : 'error'
  // The loop leaves the closing reply off the wire history — the chat keeps
  // it as the visible message instead — so the next turn of this task would
  // not know what it last said. It goes on here, as text alone: the reasoning
  // that preceded it is never replayed (the chat's rule since v1.9).
  if (status === 'done' && finalText.trim()) messages.push({ role: 'assistant', content: finalText })
  if (stopReason === 'paused' && run.question) {
    const choices = run.question.choices.length > 0 ? ` (${run.question.choices.join(' / ')})` : ''
    detail = `The agent asks: ${run.question.question}${choices}`
  } else if (status === 'paused') {
    detail = `Paused after ${spec.maxRounds ?? DEFAULT_MAX_ROUNDS} rounds. Say “continue” to let it keep going.`
  }
  if (worktree) detail = `${detail ? `${detail}\n` : ''}Worked on branch ${worktree.branch} in ${worktree.path}.`
  host.emit({ type: 'status', status, ...(detail ? { detail } : {}) })
  return {
    status,
    finalText,
    history: messages.filter((m) => m.role !== 'system'),
    todos: state.todos,
    changedFiles: [...state.checkpoints.keys()],
    checkpoints: [...state.checkpoints.values()],
    workspace: root,
    ...(worktree ? { worktree } : {}),
    ...(detail ? { detail } : {})
  }
}

/**
 * A8: run a moment's hooks. Each is a command under the host's approval and
 * a line on the timeline; a failed one's output is returned so the model can
 * be told. Never throws.
 */
async function runHooks(run: RunContext, toolbox: Toolbox, moment: HookMoment, vars: { file?: string; command?: string }): Promise<string[]> {
  const failures: string[] = []
  for (const template of run.hooks?.[moment] ?? []) {
    if (run.spec.signal.aborted) break
    const command = fillHook(template, vars)
    const id = `hook-${++run.hookCount}`
    const record: ToolCallRecord = { id, name: 'hook', args: { when: moment, command }, status: 'running' }
    run.host.emit({ type: 'tool_start', record })
    const r = await toolbox.execute('run_command', { command }, id).catch((err): ToolResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
    const done: ToolCallRecord = { ...record, status: r.ok ? 'done' : 'error', result: r.ok ? (r.output ?? '') : (r.error ?? '') }
    run.host.emit({ type: 'tool_end', record: done })
    if (!r.ok) failures.push(`Hook ${moment} \`${command}\` failed:\n${(r.error ?? '').slice(0, 2_000)}`)
  }
  return failures
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
    // A3 (v4.0, an experiment): on a <think> family, a round after a successful
    // read starts with the thinking block closed; the first round and a round
    // after a failed check think (./phase.ts). Helpers keep thinking: their
    // whole job is one investigation.
    quickReplyFor: !isHelper && spec.experiments?.thinkByPhase && THINK_TAG_MODELS.test(spec.model) ? skipThinking : undefined,
    // A4 (v4.0, an experiment): the plan in view, one transient message a round.
    preface: !isHelper && spec.experiments?.planFocus ? (iteration) => (iteration > 0 ? planInView(run.state.todos) : null) : undefined,
    // A6: ask_user ends the round; the answer is the next turn.
    pauseRequested: !isHelper && spec.experiments?.askUser ? () => run.question !== null : undefined,
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
        // A4: a step was finished last round; its output goes before the budget asks.
        if (run.stepDone) {
          run.stepDone = false
          const aside = setAsideFinishedStep(messages)
          if (aside > 0) host.emit({ type: 'context_elided', toolResults: aside, chars: 0 })
        }
        // A1 (v4.0): the low-water mark only while the experiment is on; otherwise elide to just under the budget, as 3.0 did.
        const fit = fitContext(messages, budget, toolChars, spec.experiments?.lowWaterMark ? LOW_WATER : 1)
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
        return { content: result.content, toolCalls: result.toolCalls, reasoning: result.reasoning, truncated: result.truncated, malformedCalls: result.malformedCalls }
      },
      executeTool: async (name, args, meta) => {
        const callId = meta?.callId ?? ''
        let result: ToolResult
        const todosBefore = run.state.todos
        if (name === 'task') {
          result = isHelper
            ? { ok: false, error: 'A helper cannot start helpers of its own. Do the work yourself.' }
            : await runHelper(run, args, callId, o.subagentTypes)
        } else if (name === 'ask_user') {
          result = isHelper ? { ok: false, error: 'A helper cannot ask the user. Report what you found instead.' } : askUser(run, args)
        } else if (o.toolbox.has(name)) {
          // A8: before a command the model asked for, the project's hooks.
          const before = name === 'run_command' && run.hooks && !isHelper ? await runHooks(run, o.toolbox, 'beforeCommand', { command: String(args.command ?? '') }) : []
          result = await o.toolbox.execute(name, args, callId)
          if (before.length > 0) result = { ...result, [result.ok ? 'output' : 'error']: `${before.join('\n\n')}\n\n${result.ok ? (result.output ?? '') : (result.error ?? '')}` }
          // A8: after an edit lands, the project's hooks — a failed one is told to the model.
          if (result.ok && (name === 'edit_file' || name === 'multi_edit' || name === 'write_file' || name === 'write_document') && run.hooks && !isHelper) {
            const failed = await runHooks(run, o.toolbox, 'afterEdit', { file: String(args.path ?? '') })
            if (failed.length > 0) result = { ...result, output: `${result.output ?? ''}\n\n${failed.join('\n\n')}` }
          }
          // A4: a step marked completed — set its output aside before the next round.
          if (!isHelper && name === 'todo_write' && spec.experiments?.planFocus && stepCompleted(todosBefore, run.state.todos)) run.stepDone = true
        } else if (run.host.extraTools?.schemas.some((s) => s.function.name === name)) {
          result = await run.host.extraTools.execute(name, args, callId)
        } else {
          result = { ok: false, error: `There is no tool named "${name}". Use one of: ${o.tools.map((t) => t.function.name).join(', ')}.` }
        }
        // Anything that changed the workspace (or might have) invalidates
        // every result reuse could hand back.
        if (WRITING_TOOLS.has(name) || name === 'task') ledger.previousCalls.clear()
        // A5 (v4.0): what the verify round and the report's honesty rest on —
        // when files last changed, and which commands ran after that.
        if (!isHelper) {
          if (name === 'edit_file' || name === 'multi_edit' || name === 'write_file' || name === 'write_document' || name === 'move_file' || name === 'copy_file' || name === 'delete_file') run.lastEditAt = Date.now()
          if (name === 'run_command') run.commands.push({ command: String(args.command ?? ''), ok: result.ok, at: Date.now() })
        }
        return result
      },
      takePendingMessages: isHelper ? undefined : spec.takeSteers,
      onSteerDelivered: isHelper ? undefined : (steer, r) => host.emit({ type: 'steer_delivered', id: steer.id, round: r })
    }
  })
  return outcome.stopReason
}

/** A6: the ask_user tool — the question is recorded, the loop pauses after this round, the answer is the next turn. */
function askUser(run: RunContext, args: Record<string, unknown>): ToolResult {
  const question = String(args.question ?? '').trim()
  if (!question) return { ok: false, error: 'Give the question to ask.' }
  const choices = Array.isArray(args.choices) ? args.choices.map((c) => String(c).trim()).filter(Boolean).slice(0, 6) : []
  run.question = { question: question.slice(0, 1_000), choices }
  run.host.emit({ type: 'question', question: run.question.question, choices })
  return { ok: true, output: 'Asked. The task pauses here; the user’s answer arrives as your next message. Do not call another tool this round.' }
}

/**
 * A7: the diff of every file this task changed, handed to a review helper;
 * its findings, or null when it found nothing (or could not run).
 */
async function reviewBeforeReport(run: RunContext, state: TaskState): Promise<string | null> {
  const diffs: string[] = []
  for (const cp of state.checkpoints.values()) {
    if (cp.after === null) continue
    // A document or a moved file is bytes; the reviewer is told, not handed base64.
    if (cp.encoding === 'base64') diffs.push(`${cp.path}: ${cp.before === null ? 'a new file' : 'replaced'} (a document or moved file; its bytes are not shown)`)
    else diffs.push(unifiedDiff(cp.before ?? '', cp.after, cp.path).diff)
  }
  if (diffs.length === 0) return null
  const prompt = `Review this diff — every change a coding agent made for the task below — for bugs, missed cases and inconsistencies with the surrounding code. Read the files if you need context. Reply "No problems." if it looks right; otherwise list each concrete problem with file:line and why it matters, and nothing else.\n\nTask: ${run.spec.prompt.slice(0, 600)}\n\n${diffs.join('\n\n').slice(0, 60_000)}`
  const r = await runHelper(run, { subagent_type: 'review', prompt, description: 'review before the report' }, 'review-before-report', ['review'])
  if (!r.ok || !r.output) return null
  const body = r.output.replace(/^Report from the review helper[^\n]*\n\n/, '').trim()
  return /^no problems\.?$/i.test(body) || /^no problems\b/i.test(body.split('\n')[0] ?? '') ? null : body
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
  // The helper works where the task works: with A9 on that is the task's
  // worktree, not the folder the user looks at (4.0.2 — a general helper was
  // editing the user's folder, and the A7 reviewer read the unchanged files).
  const toolbox = new Toolbox({
    root: run.env.workspace,
    permission,
    host,
    shell: run.env.shell,
    commandTimeoutSec: spec.commandTimeoutSec ?? DEFAULT_COMMAND_TIMEOUT_SEC,
    state: run.state,
    signal: spec.signal,
    experiments: spec.experiments
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
