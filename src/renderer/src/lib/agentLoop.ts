import type { ToolCallRecord, ToolResult, ToolSchema } from '../types'
import { validateToolArgs } from './toolArgs'

/**
 * The agentic tool-call loop, lifted out of the useLMStudio hook so the
 * node:test suite can reach it (Layer 0a of the routing/tools strategy).
 *
 * This module is a pure state machine: every side effect — streaming a
 * completion, executing a tool, running a delegated consultation, auditing,
 * patching the UI — is injected by the caller. No React, no store, no
 * `window`. Behavior is intended to be byte-for-byte what the hook's inline
 * loop did, plus the Layer 3 mechanics that sit inside the loop: argument
 * validation with a free repair round (3a), repeat-call detection (3b), and
 * disclosed per-tool budgets (3c). The hook keeps React concerns (patching,
 * voice, stats) and passes them in as deps.
 */

export const MAX_TOOL_ITERATIONS = 8
/** Hard cap on consult_model calls in a single orchestrator turn. */
export const MAX_DELEGATIONS_PER_TURN = 5

/**
 * The tool-call preamble (Layer 1d) is one sentence by instruction. A round
 * whose text fits this cap is treated as the stated reason for its calls and
 * rendered in the tool-call block; longer text is part of the answer proper
 * and stays put.
 */
export const MAX_TOOL_PREAMBLE_CHARS = 240

/**
 * Per-tool per-turn budgets (Layer 3c), checked *before* the call and stated
 * when hit — budgets before work, disclosed on the stop. Only egress and
 * expensive tools are listed; cheap local tools are covered by the iteration
 * cap and repeat detection. deep_research is one campaign per turn.
 */
export const TOOL_TURN_BUDGETS: Record<string, number> = {
  web_search: 3,
  // One call is one provider request plus a fetch to every image host it names
  // — the widest third-party fan-out of any tool here, so the tightest budget.
  image_search: 2,
  fetch_webpage: 2,
  deep_research: 1,
  shop_requirements: 2,
  shop_compare: 2
}

/**
 * Key-insensitive stringify for repeat detection (Layer 3b): the model's two
 * serializations of the same arguments must produce the same key.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/** The round's text as a tool-call preamble, or null when it is answer content. */
export function toolCallPreamble(roundContent: string): string | null {
  const trimmed = roundContent.trim()
  return trimmed.length > 0 && trimmed.length <= MAX_TOOL_PREAMBLE_CHARS ? trimmed : null
}

// ---- OpenAI wire types --------------------------------------------------------
// Shared with the hook's streamChat. They live here because the loop owns the
// wire history (assistant tool-call messages, tool results) across iterations.

export interface ApiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ApiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ApiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ApiContentPart[] | null
  tool_calls?: ApiToolCall[]
  tool_call_id?: string
}

/** The server's own token accounting. Absent on servers that do not report it. */
export interface ApiUsage {
  prompt_tokens?: number
  completion_tokens?: number
}

// ---- consult_model pseudo-tool ------------------------------------------------

/**
 * What the orchestrator needs to know about a specialist to route well
 * (Layer 2a). Built by the hook from the slot's config, its effective tool
 * list, and the model catalog; the schema builder itself stays pure.
 */
export interface SpecialistProfile {
  roleName: string
  /** The slot's routing declaration; absent falls back to the persona slice. */
  capability?: string
  systemPrompt: string
  /** Tool names the specialist may actually use (its allowlist ∩ global). */
  tools: string[]
  /** Context window for the roster, pre-formatted (e.g. "128K") or 'unknown'. */
  context?: string
  vision?: boolean
}

/**
 * The consult_model pseudo-tool schema. Only the orchestrator sees it — it is
 * never sent to LM Studio's tool list or to specialists. The enum of role
 * names plus a structured per-specialist line (capability, tools, context,
 * vision) lets the orchestrator pick who to call based on the task.
 */
export function consultModelSchema(specialists: SpecialistProfile[]): ToolSchema {
  const roster = specialists
    .map((s) => {
      const summary = s.capability?.trim() || s.systemPrompt.slice(0, 140)
      return (
        `${s.roleName} — ${summary} ` +
        `Tools: ${s.tools.join(', ') || 'none'}. ` +
        `Context: ${s.context ?? 'unknown'}. ` +
        `Vision: ${s.vision ? 'yes' : 'no'}.`
      )
    })
    .join('\n')
  return {
    type: 'function',
    function: {
      name: 'consult_model',
      description:
        'Consult another local specialist model. It receives your task with its own persona and tools, works independently, and returns its answer. Available specialists:\n' +
        roster,
      parameters: {
        type: 'object',
        properties: {
          role: {
            type: 'string',
            enum: specialists.map((s) => s.roleName),
            description: 'The specialist to consult'
          },
          task: {
            type: 'string',
            description:
              'Complete, self-contained instructions for the specialist — it does not see this conversation.'
          }
        },
        required: ['role', 'task']
      }
    }
  }
}

// ---- the loop -----------------------------------------------------------------

/** What one streamed completion round produced. */
export interface StreamRoundResult {
  /** The round's visible answer text (may be empty on a pure tool-call round). */
  content: string
  toolCalls: ApiToolCall[]
}

export interface AgentLoopDeps {
  /**
   * Stream one completion against the current wire history. The caller owns
   * everything display-related (content patching, reasoning, stats); the loop
   * only needs the final round text and the accumulated tool calls.
   */
  streamRound: (messages: ApiMessage[], tools: ToolSchema[]) => Promise<StreamRoundResult>
  /** Execute a real tool (IPC in the app, a stub in tests). */
  executeTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>
  /**
   * Handle a consult_model call: resolve the role, validate the task, run the
   * nested specialist turn. Absent on non-orchestrated turns — a consult_model
   * call then falls through to executeTool, exactly as the inline loop did.
   */
  consult?: (role: string, task: string) => Promise<ToolResult>
  /** Called after each executed call (real or consult) — the app's audit hook. */
  onToolExecuted?: (record: ToolCallRecord, result: ToolResult) => void
}

export interface AgentLoopOptions {
  /**
   * The starting wire history (system prompt + conversation). Mutated in
   * place: assistant tool-call messages and tool results are appended as the
   * loop runs.
   */
  messages: ApiMessage[]
  /** The wire tool list for this turn (already includes consult_model, if any). */
  tools: ToolSchema[]
  /**
   * Shared, caller-owned tool-call records — the turn's visible record list.
   * Records created by the loop are appended in place so pre-existing entries
   * (e.g. the app-run auto-search) keep their position.
   */
  records: ToolCallRecord[]
  signal: AbortSignal
  maxIterations?: number
  maxDelegations?: number
  /**
   * Per-tool per-turn budgets (Layer 3c), defaulting to TOOL_TURN_BUDGETS.
   * An empty map disables budgets.
   */
  toolBudgets?: Record<string, number>
  /**
   * Extra iterations granted when a round's calls failed argument validation
   * (Layer 3a): the repair round does not count against the iteration cap.
   * Defaults to 1 per turn.
   */
  repairIterations?: number
  /** Called after every records mutation so the caller can re-render. */
  onRecordChange?: (record: ToolCallRecord) => void
  deps: AgentLoopDeps
}

export type AgentLoopStopReason =
  /** A round ended with no tool calls — the reply is complete. */
  | 'completed'
  /** The abort signal fired; unwind quietly. */
  | 'aborted'
  /** The final permitted round still asked for tools — the cap stopped the turn. */
  | 'iteration_cap'

export interface AgentLoopOutcome {
  stopReason: AgentLoopStopReason
}

/**
 * Stream a round, execute any requested tools, feed the results back, and
 * repeat until the model stops calling tools, the signal aborts, or the
 * iteration cap is reached. Tool calls on the final permitted round still
 * execute — the cap stops the *next* completion, not work already requested.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopOutcome> {
  const { messages, tools, records, signal, deps } = options
  const maxIterations = options.maxIterations ?? MAX_TOOL_ITERATIONS
  const maxDelegations = options.maxDelegations ?? MAX_DELEGATIONS_PER_TURN
  const toolBudgets = options.toolBudgets ?? TOOL_TURN_BUDGETS
  let repairAllowance = options.repairIterations ?? 1
  let iterationCap = maxIterations
  let delegationCount = 0
  // Layer 3 turn state: executed-call counts for budgets (3c), and the results
  // of dispatched calls keyed by name+canonical args for repeat detection (3b).
  const executedCounts = new Map<string, number>()
  const previousCalls = new Map<string, ToolResult>()

  for (let iteration = 0; iteration < iterationCap; iteration++) {
    const round = await deps.streamRound(messages, tools)
    if (signal.aborted) return { stopReason: 'aborted' }
    if (round.toolCalls.length === 0) return { stopReason: 'completed' }

    // Record the calls on the wire history, then execute them in order.
    messages.push({ role: 'assistant', content: round.content || null, tool_calls: round.toolCalls })

    // A short text round ahead of tool calls is the model's stated reason for
    // them (Layer 1d) — attach it so the tool-call block can show it.
    const preamble = toolCallPreamble(round.content)

    // Layer 3a: a round with any argument failure earns one repair iteration
    // beyond the cap — the model gets its chance to correct the call.
    let roundHadArgFailure = false

    for (const tc of round.toolCalls) {
      let args: Record<string, unknown> = {}
      let argsMalformed = false
      try {
        args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>
      } catch {
        argsMalformed = true
      }
      const record: ToolCallRecord = { id: tc.id, name: tc.function.name, args, status: 'running' }
      if (preamble) record.preamble = preamble
      records.push(record)
      options.onRecordChange?.(record)

      let result: ToolResult

      if (tc.function.name === 'consult_model' && deps.consult) {
        // Pseudo-tool: the caller runs a nested specialist turn instead of an
        // IPC tool. The cap counts attempts, including failed ones — a model
        // that cannot name a real specialist must not get unlimited retries.
        delegationCount += 1
        if (delegationCount > maxDelegations) {
          result = {
            ok: false,
            error: `Delegation limit reached (${maxDelegations} consultations per turn) — synthesize an answer from what you have.`
          }
        } else {
          result = await deps.consult(String(args.role ?? ''), String(args.task ?? ''))
        }
      } else if (argsMalformed) {
        // Layer 3a: malformed JSON never dispatches. The repair message tells
        // the model exactly what happened so its next round can fix the call.
        roundHadArgFailure = true
        result = {
          ok: false,
          error:
            `Malformed arguments for ${tc.function.name}: not valid JSON ` +
            `(${tc.function.arguments.slice(0, 140)}). Correct the call and try again.`
        }
      } else if (previousCalls.has(`${tc.function.name} ${stableStringify(args)}`)) {
        // Layer 3b: same tool, same arguments — reuse, don't re-run. Checked
        // before the budget on purpose: a repeat is not new work, so it must
        // not spend budget. The note tells the model (and the user, via the
        // record) that nothing executed.
        const prev = previousCalls.get(`${tc.function.name} ${stableStringify(args)}`)!
        result = prev.ok
          ? { ok: true, output: `${prev.output ?? ''}\n\n(Identical call already ran this turn — result reused, not re-executed.)` }
          : { ok: false, error: `${prev.error ?? 'unknown error'} (identical call already failed this turn — not retried)` }
      } else if (
        toolBudgets[tc.function.name] !== undefined &&
        (executedCounts.get(tc.function.name) ?? 0) >= toolBudgets[tc.function.name]
      ) {
        // Layer 3c: the budget is checked before work and stated when hit.
        result = {
          ok: false,
          error:
            `${tc.function.name} budget reached (${toolBudgets[tc.function.name]} of ${toolBudgets[tc.function.name]} this turn) ` +
            '— answer from the results you already have, and name plainly what you could not check. ' +
            'Never invent the missing data.'
        }
      } else {
        // Layer 3a: validate against the tool's own schema before dispatch —
        // but only for tools on this turn's wire list. Unknown names fall
        // through to the executor's own error, as before.
        const schema = tools.find((t) => t.function.name === tc.function.name)
        const validation = schema ? validateToolArgs(schema.function.parameters, args) : null
        if (validation && !validation.ok) {
          roundHadArgFailure = true
          result = {
            ok: false,
            error:
              `Invalid arguments for ${tc.function.name}: ${validation.errors.join('; ')}. ` +
              `You sent ${JSON.stringify(args).slice(0, 140)}. Correct the call and try again.`
          }
        } else {
          result = await deps.executeTool(tc.function.name, args)
          executedCounts.set(tc.function.name, (executedCounts.get(tc.function.name) ?? 0) + 1)
          previousCalls.set(`${tc.function.name} ${stableStringify(args)}`, result)
        }
      }

      if (result.ok) {
        record.status = 'done'
        record.result = result.output ?? ''
        // Display payloads (image_search thumbnails) ride the record, not the
        // wire history — the model gets the text list, the user gets pictures.
        if (result.images && result.images.length > 0) record.images = result.images
      } else {
        record.status = 'error'
        record.result = result.error ?? 'Unknown tool error'
      }
      options.onRecordChange?.(record)
      deps.onToolExecuted?.(record, result)

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result.ok ? result.output ?? '' : `Error: ${result.error ?? 'unknown error'}`
      })
    }

    // The repair round is free: spend the allowance by extending the cap once
    // per argument-failing round, never past the allowance itself.
    if (roundHadArgFailure && repairAllowance > 0) {
      repairAllowance -= 1
      iterationCap += 1
    }
  }

  return { stopReason: signal.aborted ? 'aborted' : 'iteration_cap' }
}
