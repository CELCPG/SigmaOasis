import type { ChatPlan } from '../types'
import { useAppStore } from '../stores/appStore'
import { useLMStudio } from '../hooks/useLMStudio'
import { PlanBlockView } from './PlanBlockView'

interface Props {
  messageId: string
  plan: ChatPlan
}

/**
 * v0.9 Plan mode: the visible checklist of a multi-step task. When the plan
 * awaits approval (Settings → General → Plan mode), nothing has run yet and
 * the Approve/Cancel buttons gate execution. Each finished step's result is
 * expandable; a failed step is shown as failed, never silently retried, and a
 * plan that ended — cancelled, stopped, failed — says so instead of still
 * asking to be approved (see lib/planState.ts).
 */
export function PlanBlock({ messageId, plan }: Props): JSX.Element {
  const streaming = useAppStore((s) => s.streaming)
  const { resolvePlan } = useLMStudio()

  return (
    <PlanBlockView
      plan={plan}
      streaming={streaming}
      onResolve={(approved) => resolvePlan(messageId, approved)}
    />
  )
}
