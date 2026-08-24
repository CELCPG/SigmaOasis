import { ipcMain } from 'electron'
import { chatCompleteJson, resolveChatModel } from './llm'
import { getSettings } from './store'

/**
 * Plan mode (v0.9): the planner half lives here because planning is a
 * structured-output model call, and llm.ts already solves that (grammar
 * constraint where the server supports it, tolerant extraction where it does
 * not). Execution stays in the renderer, where streaming and the tool loop
 * already exist.
 *
 * The plan is deliberately boring: an ordered list of concrete, self-contained
 * steps a single model can work through. No branching, no parallelism — those
 * are how plan executors become undebuggable.
 */

export interface PlannedStep {
  title: string
  detail: string
  /** Enabled tools the step says it may use — the pre-approval disclosure. */
  tools: string[]
}

interface PlanPayload {
  steps?: { title?: unknown; detail?: unknown; tools?: unknown }[]
}

/**
 * v1.12.3: when the caller knows which tools are enabled, each step must name
 * the ones it may use. Approval is asked for before anything runs, so the tool
 * names are the only part of the disclosure that says what the step will *do*;
 * an enum constrains the answer to tools that exist rather than to tools the
 * model wishes existed.
 */
function planSchema(
  toolNames: readonly string[]
): { name: string; schema: Record<string, unknown> } {
  const properties: Record<string, unknown> = {
    title: { type: 'string' },
    detail: { type: 'string' }
  }
  const required = ['title', 'detail']
  if (toolNames.length > 0) {
    properties.tools = { type: 'array', items: { type: 'string', enum: [...toolNames] } }
    required.push('tools')
  }
  return {
    name: 'task_plan',
    schema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: { type: 'object', properties, required, additionalProperties: false },
          minItems: 1,
          maxItems: 10
        }
      },
      required: ['steps'],
      additionalProperties: false
    }
  }
}

/**
 * Decompose a task into at most `maxSteps` ordered steps. Returns null when
 * the model produced nothing usable — the renderer then says so and falls
 * back to answering directly, which is the honest failure mode.
 */
export async function generatePlan(
  task: string,
  modelId?: string,
  maxSteps?: number,
  /**
   * The conversation the task came from. v1.4.5: without it the planner wrote
   * steps for a follow-up as though the follow-up were the whole request —
   * "update the route to 8 stops" became six steps that each asked for a route
   * the previous turn had already produced.
   */
  context?: string,
  /** Tools enabled for this turn. Each step names the ones it may use. */
  toolNames: readonly string[] = []
): Promise<PlannedStep[] | null> {
  const model = await resolveChatModel(modelId)
  if (!model) return null
  const cap = Math.min(10, Math.max(1, Math.round(maxSteps ?? getSettings().plan.maxSteps)))
  const allowed = new Set(toolNames)

  const parsed = await chatCompleteJson<PlanPayload>({
    model,
    messages: [
      {
        role: 'system',
        content:
          'You are a planner. Break the user\'s task into an ordered list of concrete steps, ' +
          `at most ${cap}. Each step must be self-contained (a later step cannot see this ` +
          'conversation), produce a result the next step can use, and be phrased as an ' +
          'instruction. No step may be "think about" or "consider" — every step produces ' +
          'something checkable. If the task is simple enough to answer directly, return a ' +
          'single step. Return JSON only.' +
          // The user approves the plan before any of it runs, so the step has
          // to say what it will reach for while that is still a decision.
          (allowed.size > 0
            ? `\n\nThese tools are enabled: ${[...allowed].join(', ')}. For each step, list in ` +
              '"tools" the ones that step may need — only from that list, and an empty list ' +
              'when the step is reasoning or arithmetic the model does itself. The user reads ' +
              'this before approving the plan.'
            : '')
      },
      {
        role: 'user',
        content: context
          ? `Conversation so far:\n${context}\n\nTask to plan: ${task}\n\n` +
            'Anything the conversation already established is available to the steps — plan to ' +
            'use it, never to ask for it again.'
          : task
      }
    ],
    temperature: 0.2,
    thinking: false,
    jsonSchema: planSchema([...allowed])
  })

  const steps = (parsed?.steps ?? [])
    .map((s) => ({
      title: String(s?.title ?? '').trim(),
      detail: String(s?.detail ?? '').trim(),
      // A named tool that is not enabled would be a promise the step cannot
      // keep, so the disclosure carries only names the turn actually holds.
      tools: [
        ...new Set(
          (Array.isArray(s?.tools) ? s.tools : [])
            .map((t) => String(t ?? '').trim())
            .filter((t) => allowed.has(t))
        )
      ]
    }))
    .filter((s) => s.title && s.detail)
    .slice(0, cap)
  return steps.length > 0 ? steps : null
}

export function registerPlanHandlers(): void {
  ipcMain.handle(
    'plan:generate',
    async (
      _e,
      task: string,
      modelId?: string,
      maxSteps?: number,
      context?: string,
      toolNames?: string[]
    ) => {
      const trimmed = String(task ?? '').trim()
      if (!trimmed) return { ok: false, error: 'A task is required.' }
      try {
        const steps = await generatePlan(
          trimmed,
          modelId,
          maxSteps,
          typeof context === 'string' ? context : undefined,
          Array.isArray(toolNames) ? toolNames.map((t) => String(t)) : []
        )
        return steps
          ? { ok: true, steps }
          : { ok: false, error: 'The model did not produce a usable plan.' }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}
