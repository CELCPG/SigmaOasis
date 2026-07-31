import { useState } from 'react'
import type { ChatPlan, PlanStepStatus } from '../types'
import { useAppStore } from '../stores/appStore'
import { useLMStudio } from '../hooks/useLMStudio'

interface Props {
  messageId: string
  plan: ChatPlan
}

const STATUS_ICON: Record<PlanStepStatus, string> = {
  pending: '○',
  running: '◌',
  done: '✓',
  failed: '✗'
}

const STATUS_CLASS: Record<PlanStepStatus, string> = {
  pending: 'text-neutral-400',
  running: 'text-accent-glow animate-pulse',
  done: 'text-green-600 dark:text-green-400',
  failed: 'text-red-500'
}

/**
 * v0.9 Plan mode: the visible checklist of a multi-step task. When the plan
 * awaits approval (Settings → General → Plan mode), nothing has run yet and
 * the Approve/Cancel buttons gate execution. Each finished step's result is
 * expandable; a failed step is shown as failed, never silently retried.
 */
export function PlanBlock({ messageId, plan }: Props): JSX.Element {
  const streaming = useAppStore((s) => s.streaming)
  const { resolvePlan } = useLMStudio()
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({})

  const doneCount = plan.steps.filter((s) => s.status === 'done').length
  const awaitingApproval = !plan.approved && plan.steps.every((s) => s.status === 'pending')

  return (
    <div className="my-2 overflow-hidden rounded-2xl border border-black/10 dark:border-white/10 bg-black/[0.03] dark:bg-white/[0.03] text-xs">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span>📋</span>
        <span className="font-medium text-neutral-500">
          Plan — {doneCount}/{plan.steps.length} steps done
        </span>
        {awaitingApproval && (
          <span className="text-amber-600 dark:text-amber-500">awaiting approval</span>
        )}
      </div>

      <ol className="border-t border-black/10 dark:border-white/10 px-3 py-1.5">
        {plan.steps.map((step, i) => (
          <li key={step.id} className="py-1">
            <div className="flex items-start gap-2">
              <span className={`mt-px w-4 shrink-0 text-center ${STATUS_CLASS[step.status]}`}>
                {STATUS_ICON[step.status]}
              </span>
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  disabled={!step.output}
                  onClick={() => setOpenSteps((o) => ({ ...o, [step.id]: !o[step.id] }))}
                  className="w-full text-left disabled:cursor-default"
                >
                  <span className="font-medium text-neutral-600 dark:text-neutral-300">
                    {i + 1}. {step.title}
                  </span>
                  <span className="block text-neutral-400">{step.detail}</span>
                  {step.output && (
                    <span className="text-neutral-400">{openSteps[step.id] ? '▾' : '▸'}</span>
                  )}
                </button>
                {openSteps[step.id] && step.output && (
                  <pre
                    className={`mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg p-2 font-mono text-[11px] ${
                      step.status === 'failed'
                        ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                        : 'bg-black/5 dark:bg-white/5 text-neutral-500'
                    }`}
                  >
                    {step.output}
                  </pre>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>

      {awaitingApproval && (
        <div className="flex gap-2 border-t border-black/10 dark:border-white/10 px-3 py-2">
          <button
            type="button"
            onClick={() => resolvePlan(messageId, true)}
            className="rounded-xl border border-[rgba(0,212,170,0.4)] bg-[rgba(0,212,170,0.15)] px-3 py-1 font-medium text-accent-glow hover:bg-[rgba(0,212,170,0.25)]"
          >
            ▶ Run this plan
          </button>
          <button
            type="button"
            onClick={() => resolvePlan(messageId, false)}
            className="rounded-xl border border-black/10 dark:border-white/10 px-3 py-1 text-neutral-500 hover:bg-black/5 dark:hover:bg-white/5"
          >
            Cancel
          </button>
          <span className="ml-auto self-center text-[10px] text-neutral-400">
            {streaming ? '' : 'Nothing has run yet. Tools each step may use are the ones enabled in Settings → Tools.'}
          </span>
        </div>
      )}
    </div>
  )
}
