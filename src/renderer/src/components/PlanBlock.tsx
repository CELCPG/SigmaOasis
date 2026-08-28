import type { ChatPlan, ToolCallRecord } from '../types'
import { useAppStore } from '../stores/appStore'
import { useLMStudio } from '../hooks/useLMStudio'
import { PlanBlockView } from './PlanBlockView'

interface Props {
  messageId: string
  plan: ChatPlan
  /** The message's tool-call records; each step shows the ones it made. */
  records: ToolCallRecord[]
}

/**
 * v0.9 Plan mode: the visible checklist of a multi-step task. When the plan
 * awaits approval (Settings → General → Plan mode), nothing has run yet and
 * the Approve/Cancel buttons gate execution. Each finished step's result is
 * expandable; a failed step is shown as failed, never silently retried, and a
 * plan that ended — cancelled, stopped, failed — says so instead of still
 * asking to be approved (see lib/planState.ts).
 *
 * The gate these buttons resolve lives in memory, so a plan that reached disk
 * while it was open comes back with nothing behind it. `abandonOrphanedPlans`
 * settles those at load, which is why `onResolve` can assume a live resolver:
 * by the time this renders, a plan still offering the buttons has one.
 *
 * v1.12.2: a step also shows the tool calls it made, under the step that made
 * them, so twenty calls stay a checklist rather than a wall.
 */
export function PlanBlock({ messageId, plan, records }: Props): JSX.Element {
  const streaming = useAppStore((s) => s.streaming)
  const hideToolCalls = useAppStore((s) => s.settings?.hideToolCalls) ?? false
  const { resolvePlan } = useLMStudio()

  return (
    <PlanBlockView
      plan={plan}
      streaming={streaming}
      onResolve={(approved) => resolvePlan(messageId, approved)}
      records={records}
      hideToolCalls={hideToolCalls}
    />
  )
}
