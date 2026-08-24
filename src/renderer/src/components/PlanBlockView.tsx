import { useState } from 'react'
import type { ChatPlan, ToolCallRecord } from '../types'
import { stepRecords } from '../hooks/planMode'
import { ToolCallBlock } from './ToolCallBlock'
import {
  awaitingApproval,
  OUTCOME_BADGE,
  OUTCOME_CLASS,
  OUTCOME_LABEL,
  STATUS_CLASS,
  STATUS_ICON,
  STATUS_NOTE,
  stepBodyClass,
  toolPreview
} from '../lib/planState'

interface Props {
  plan: ChatPlan
  streaming: boolean
  onResolve: (approved: boolean) => void
  /** The turn's tool calls, so a step can show the ones it made (v1.12.2). */
  records?: ToolCallRecord[]
  /** Set where the calls are already listed elsewhere in the message. */
  hideToolCalls?: boolean
}

/**
 * The plan checklist itself, with no store behind it so a test can render it
 * (test/planBlock.test.ts). PlanBlock wires it to the pending approval.
 */
export function PlanBlockView({
  plan,
  streaming,
  onResolve,
  records = [],
  hideToolCalls = false
}: Props): JSX.Element {
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({})

  const doneCount = plan.steps.filter((s) => s.status === 'done').length
  const awaiting = awaitingApproval(plan)

  return (
    <div className="my-2 overflow-hidden rounded-2xl border border-black/10 dark:border-white/10 bg-black/[0.03] dark:bg-white/[0.03] text-xs">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span>📋</span>
        <span className="font-medium text-neutral-500">
          Plan — {doneCount}/{plan.steps.length} steps done
        </span>
        {awaiting && <span className="text-amber-600 dark:text-amber-500">awaiting approval</span>}
        {/* Approved and no outcome yet is the only live state; say so, so the
            header alone tells the six states apart. */}
        {!awaiting && !plan.outcome && <span className="text-accent-ink">running</span>}
        {plan.outcome && (
          <span className={`${OUTCOME_BADGE} ${OUTCOME_CLASS[plan.outcome]}`}>
            {OUTCOME_LABEL[plan.outcome]}
          </span>
        )}
      </div>

      <ol className="border-t border-black/10 dark:border-white/10 px-3 py-1.5">
        {plan.steps.map((step, i) => {
          const calls = hideToolCalls ? [] : stepRecords(records, step.id)
          const expandable = Boolean(step.output) || calls.length > 0
          return (
          <li key={step.id} className="py-1">
            <div className="flex items-start gap-2">
              <span className={`mt-px w-4 shrink-0 text-center ${STATUS_CLASS[step.status]}`}>
                {STATUS_ICON[step.status]}
              </span>
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  disabled={!expandable}
                  onClick={() => setOpenSteps((o) => ({ ...o, [step.id]: !o[step.id] }))}
                  className="w-full text-left disabled:cursor-default"
                >
                  <span
                    className={
                      step.status === 'skipped'
                        ? 'font-medium text-neutral-400 line-through dark:text-neutral-500'
                        : 'font-medium text-neutral-600 dark:text-neutral-300'
                    }
                  >
                    {i + 1}. {step.title}
                  </span>
                  {/* The count is the disclosure: a step that ran tools says so
                      before anything is expanded. */}
                  {calls.length > 0 && (
                    <span className="ml-1.5 text-neutral-400">
                      🔧 {calls.length} tool call{calls.length === 1 ? '' : 's'}
                    </span>
                  )}
                  {STATUS_NOTE[step.status] && (
                    <span className={`ml-2 ${STATUS_CLASS[step.status]}`}>
                      {STATUS_NOTE[step.status]}
                    </span>
                  )}
                  <span className={`block ${stepBodyClass(step.status)}`}>{step.detail}</span>
                  {/* What the step will reach for, stated while approving it is
                      still a decision — not disclosed afterwards by the calls. */}
                  <span className={`block ${stepBodyClass(step.status)}`}>{toolPreview(step)}</span>
                  {expandable && (
                    <span className="text-neutral-400">{openSteps[step.id] ? '▾' : '▸'}</span>
                  )}
                </button>
                {openSteps[step.id] && (
                  <>
                    {calls.map((record) => (
                      <ToolCallBlock key={record.id} record={record} />
                    ))}
                    {step.output && (
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
                  </>
                )}
              </div>
            </div>
          </li>
          )
        })}
      </ol>

      {awaiting && (
        <div className="flex gap-2 border-t border-black/10 dark:border-white/10 px-3 py-2">
          <button
            type="button"
            onClick={() => onResolve(true)}
            className="rounded-xl border border-[rgba(0,212,170,0.4)] bg-[rgba(0,212,170,0.15)] px-3 py-1 font-medium text-accent-ink hover:bg-[rgba(0,212,170,0.25)]"
          >
            ▶ Run this plan
          </button>
          <button
            type="button"
            onClick={() => onResolve(false)}
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
