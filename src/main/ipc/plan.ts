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
}

interface PlanPayload {
  steps?: { title?: unknown; detail?: unknown }[]
}

const PLAN_SCHEMA = {
  name: 'task_plan',
  schema: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            detail: { type: 'string' }
          },
          required: ['title', 'detail'],
          additionalProperties: false
        },
        minItems: 1,
        maxItems: 10
      }
    },
    required: ['steps'],
    additionalProperties: false
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
  maxSteps?: number
): Promise<PlannedStep[] | null> {
  const model = await resolveChatModel(modelId)
  if (!model) return null
  const cap = Math.min(10, Math.max(1, Math.round(maxSteps ?? getSettings().plan.maxSteps)))

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
          'single step. Return JSON only.'
      },
      { role: 'user', content: task }
    ],
    temperature: 0.2,
    thinking: false,
    jsonSchema: PLAN_SCHEMA
  })

  const steps = (parsed?.steps ?? [])
    .map((s) => ({ title: String(s?.title ?? '').trim(), detail: String(s?.detail ?? '').trim() }))
    .filter((s) => s.title && s.detail)
    .slice(0, cap)
  return steps.length > 0 ? steps : null
}

export function registerPlanHandlers(): void {
  ipcMain.handle(
    'plan:generate',
    async (_e, task: string, modelId?: string, maxSteps?: number) => {
      const trimmed = String(task ?? '').trim()
      if (!trimmed) return { ok: false, error: 'A task is required.' }
      try {
        const steps = await generatePlan(trimmed, modelId, maxSteps)
        return steps
          ? { ok: true, steps }
          : { ok: false, error: 'The model did not produce a usable plan.' }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}
