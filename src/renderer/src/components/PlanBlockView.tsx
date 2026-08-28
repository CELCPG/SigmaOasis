import { useState } from 'react'
import type { ChatPlan, ToolCallRecord } from '../types'
import { stepRecords } from '../hooks/planMode'
import { ToolCallBlock } from './ToolCallBlock'
import { Disclosure } from './Disclosure'
import {
  abandonedNote,
  awaitingApproval,
  forecastDivergenceNote,
  OUTCOME_BADGE,
  OUTCOME_CLASS,
  OUTCOME_LABEL,
  reconcileStepTools,
  STATUS_CLASS,
  STATUS_ICON,
  STATUS_NOTE,
  stepBodyClass,
  stepDiverged,
  toolPreview,
  undisclosedRunNote,
  unrunForecastNote
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
  // Reconciled against everything each step ran, never against the filtered
  // list: "Hide tool-call details" collapses the call blocks, and a step
  // misreporting what it reached for is not a detail.
  const reconciled = plan.steps.map((s) => reconcileStepTools(s, stepRecords(records, s.id)))
  const divergedCount = reconciled.filter(stepDiverged).length

  return (
    <div className="my-2 overflow-hidden rounded-2xl border border-black/10 dark:border-white/10 bg-black/[0.03] dark:bg-white/[0.03] text-xs">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span>📋</span>
        <span className="font-medium text-ink-secondary">
          Plan — {doneCount}/{plan.steps.length} steps done
        </span>
        {/* The count alone read as a clean bill on a run where half the
            forecast was fiction. Same ink and weight as the count it qualifies
            — the reader must not be able to take the one without the other —
            and still lighter than the outcome, which stays the loudest thing
            in the block. */}
        {divergedCount > 0 && (
          <span className="font-medium text-ink-secondary">
            · {forecastDivergenceNote(divergedCount, plan.steps.length)}
          </span>
        )}
        {awaiting && <span className="text-amber-600 dark:text-amber-500">awaiting approval</span>}
        {/* Approved and no outcome yet is the only live state; say so, so the
            header alone tells the seven states apart. */}
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
          const { undisclosed, unrun, contradicted } = reconciled[i]!
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
                        ? 'font-medium text-ink-tertiary line-through'
                        : 'font-medium text-ink-secondary'
                    }
                  >
                    {i + 1}. {step.title}
                  </span>
                  {/* The count is the disclosure: a step that ran tools says so
                      before anything is expanded. */}
                  {calls.length > 0 && (
                    <span className="ml-1.5 text-ink-tertiary">
                      🔧 {calls.length} tool call{calls.length === 1 ? '' : 's'}
                    </span>
                  )}
                  {STATUS_NOTE[step.status] && (
                    <span className={`ml-2 ${STATUS_CLASS[step.status]}`}>
                      {STATUS_NOTE[step.status]}
                    </span>
                  )}
                  {/* stepBodyClass, not a flat token: a step that never ran has
                      to read as never-run, which is a per-status decision. */}
                  <span className={`block ${stepBodyClass(step.status)}`}>{step.detail}</span>
                  {/* What the step will reach for, stated while approving it is
                      still a decision — not disclosed afterwards by the calls. */}
                  <span className={`block ${stepBodyClass(step.status)}`}>{toolPreview(step)}</span>
                  {/* The line above, read back. A forecast tool that never ran
                      is not misconduct — the step may simply not have needed
                      it — but it is the difference between an approval that
                      was informed and one that was not, so it is stated as
                      fact in the step's own ink rather than warned about. */}
                  {unrun.length > 0 && (
                    <span className={`block ${stepBodyClass(step.status)}`}>
                      {unrunForecastNote(unrun)}
                    </span>
                  )}
                  {/* The other half of that disclosure. The forecast above is
                      not binding — it is a forecast — so it is checked instead:
                      a tool the step ran without naming is said here, in the
                      same plain voice as the grounding checks under a reply.
                      Amber like those, but a rung darker in light: they sit on
                      their own amber tint, this sits on the plan block's grey,
                      where amber-700 measures 4.28:1 and misses AA. */}
                  {undisclosed.length > 0 && (
                    <span className="block text-amber-800 dark:text-amber-500">
                      {undisclosedRunNote(undisclosed, contradicted)}
                    </span>
                  )}
                  {expandable && (
                    <span className="text-ink-tertiary">{openSteps[step.id] ? '▾' : '▸'}</span>
                  )}
                </button>
                <Disclosure open={Boolean(openSteps[step.id])}>
                    {calls.map((record) => (
                      <ToolCallBlock key={record.id} record={record} />
                    ))}
                    {step.output && (
                      <pre
                        className={`mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg p-2 font-mono text-[11px] ${
                          step.status === 'failed'
                            ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                            : 'bg-black/5 dark:bg-white/5 text-ink-secondary'
                        }`}
                      >
                        {step.output}
                      </pre>
                    )}
                </Disclosure>
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
            className="rounded-xl border border-black/10 dark:border-white/10 px-3 py-1 text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5"
          >
            Cancel
          </button>
          <span className="ml-auto self-center text-[10px] text-ink-tertiary">
            {streaming ? '' : 'Nothing has run yet. Tools each step may use are the ones enabled in Settings → Tools.'}
          </span>
        </div>
      )}

      {/* The same strip, for the plan the app walked out on. It is the one
          outcome that takes away something the reader was looking at — the
          approval buttons, or a step that was moving — so it is the one that
          owes them a sentence in its place; the others are explained by the
          reader's own action or by a step that says it failed. Not a warning
          and not struck through: the plan is over, the reason is nobody's
          fault, and the next move is theirs. */}
      {plan.outcome === 'abandoned' && (
        <div className="border-t border-black/10 dark:border-white/10 px-3 py-2 text-ink-secondary">
          {abandonedNote(plan)}
        </div>
      )}
    </div>
  )
}
