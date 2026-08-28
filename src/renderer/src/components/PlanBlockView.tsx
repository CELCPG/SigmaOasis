import { useId, useState } from 'react'
import type { ChatPlan, ToolCallRecord } from '../types'
import { stepRecords } from '../hooks/planMode'
import { ToolCallBlock } from './ToolCallBlock'
import { Disclosure } from './Disclosure'
import {
  awaitingApproval,
  forecastDivergenceNote,
  planHeaderCount,
  planHeaderStatus,
  reconcileStepTools,
  STATUS_CLASS,
  STATUS_ICON,
  STATUS_LABEL,
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
  // The block names itself to a screen reader out of the header it already
  // shows — see the group below.
  const headerId = useId()

  const awaiting = awaitingApproval(plan)
  const status = planHeaderStatus(plan)
  // Reconciled against everything each step ran, never against the filtered
  // list: "Hide tool-call details" collapses the call blocks, and a step
  // misreporting what it reached for is not a detail.
  const reconciled = plan.steps.map((s) => reconcileStepTools(s, stepRecords(records, s.id)))
  const divergedCount = reconciled.filter(stepDiverged).length

  return (
    /* A named group, not a landmark: a conversation can hold many plans, and a
       region apiece would bury the document's real landmarks. The name is the
       header the sighted reader already gets — `aria-labelledby`, never a
       hand-written `aria-label`, so the two cannot drift and the count can
       never be announced without the outcome that qualifies it. */
    <div
      role="group"
      aria-labelledby={headerId}
      className="my-2 overflow-hidden rounded-2xl border border-black/10 dark:border-white/10 bg-black/[0.03] dark:bg-white/[0.03] text-xs"
    >
      <div id={headerId} className="flex items-center gap-2 px-3 py-1.5">
        <span aria-hidden="true">📋</span>
        {/* A progress fraction while the plan can still progress, and a census
            of what became of every step once it cannot — see
            `planHeaderCount`. The string is built there, beside the outcome
            labels it has to agree with, for the reason every other sentence in
            this app moved out of its component: a line with no test is how a
            dead checklist kept advertising three quarters of the work as still
            to come. */}
        <span className="font-medium text-ink-secondary">Plan — {planHeaderCount(plan)}</span>
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
        {/* The block's one live region, and deliberately the only one.
            `planHeaderStatus` keeps this element on screen in every state, so
            a plan that ends changes this element's CONTENTS — which is what a
            live region announces — rather than replacing one span with
            another, which announces nothing.

            Scoped to the status word alone, not to the block. A plan that runs
            step by step rewrites its rows and its count continuously; making
            those live would talk over the reader for the whole run and teach
            them to tune the region out. What they cannot discover by browsing,
            and must know, is the moment control comes back to them. So this
            speaks two or three times in a plan's life — awaiting approval,
            running, and how it ended — and the steps stay silent and
            browsable. */}
        <span role="status" aria-live="polite" aria-atomic="true" className={status.className}>
          {status.text}
        </span>
      </div>

      <ol className="border-t border-black/10 dark:border-white/10 px-3 py-1.5">
        {plan.steps.map((step, i) => {
          const calls = hideToolCalls ? [] : stepRecords(records, step.id)
          const { undisclosed, unrun, contradicted } = reconciled[i]!
          const expandable = Boolean(step.output) || calls.length > 0
          /* The step's identity: its number, its title, what it ran, and the
             note for a status a glyph underplays. This is the whole of what
             the disclosure button is named after — the row's prose sits below
             it, outside the control, for the reason given there. */
          const identity = (
            <>
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
                  before anything is expanded. The wrench is hidden from the
                  accessible name — "🔧" announces as "wrench" immediately
                  before the words "tool calls", which is the glyph noise this
                  round exists to remove. */}
              {calls.length > 0 && (
                <span className="ml-1.5 text-ink-tertiary">
                  <span aria-hidden="true">🔧</span> {calls.length} tool call
                  {calls.length === 1 ? '' : 's'}
                </span>
              )}
              {/* The space is load-bearing: without a whitespace text node
                  between the two spans, the accessible name computed
                  "Step 1never ran" — measured, not supposed. */}
              {STATUS_NOTE[step.status] && ' '}
              {STATUS_NOTE[step.status] && (
                <span className={`ml-2 ${STATUS_CLASS[step.status]}`}>
                  {STATUS_NOTE[step.status]}
                </span>
              )}
            </>
          )
          return (
          <li key={step.id} className="py-1">
            <div className="flex items-start gap-2">
              {/* role="img" + aria-label, not a hidden span beside a hidden
                  glyph: this pair is exactly what a meaningful icon takes, and
                  it puts the state FIRST in the row's reading order, which is
                  the order a checklist is scanned in. See STATUS_LABEL for
                  what the tree said before. */}
              <span
                role="img"
                aria-label={STATUS_LABEL[step.status]}
                className={`mt-px w-4 shrink-0 text-center ${STATUS_CLASS[step.status]}`}
              >
                {STATUS_ICON[step.status]}
              </span>
              <div className="min-w-0 flex-1">
                {/* A button only where there is something to open. Through
                    v1.17 every row was a `<button disabled>`, so a plan that
                    had been cancelled offered a screen reader five dimmed
                    controls that were never controls — `disabled` says "you
                    cannot press this yet", and the truthful thing was that
                    there was nothing to press. A dead row is now text, and the
                    rows that really do open are the only ones announced as
                    buttons. */}
                {expandable ? (
                  <button
                    type="button"
                    aria-expanded={Boolean(openSteps[step.id])}
                    onClick={() => setOpenSteps((o) => ({ ...o, [step.id]: !o[step.id] }))}
                    className="w-full text-left"
                  >
                    {identity}
                    {/* On the title line now that the prose has moved out from
                        under it, so it needs the gap the line break used to
                        give it. Hidden from the reader: `aria-expanded` above
                        says the same thing in a form a reader can act on. */}
                    <span aria-hidden="true" className="ml-1.5 text-ink-tertiary">
                      {openSteps[step.id] ? '▾' : '▸'}
                    </span>
                  </button>
                ) : (
                  <div className="w-full">{identity}</div>
                )}
                {/* The row's prose, deliberately OUTSIDE the button.
                    Text inside a control is swallowed into that control's
                    accessible name: the tree measured one row as the single
                    utterance "1. Step 1🔧 1 tool call detail 1 Tools — may
                    use: web_search Forecast web_search, which this step never
                    ran. ⚠️ Ran calculator, which this step did not disclose.
                    ▸". Every disclosure this block fought to add arrived as
                    one run-on breath with no structure and no way to stop on
                    the warning. Out here they are four navigable lines — and
                    selectable with a mouse, which text in a button is not. */}
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
                  <span className="block text-ink-warn">
                    {undisclosedRunNote(undisclosed, contradicted)}
                  </span>
                )}
                <Disclosure open={Boolean(openSteps[step.id])}>
                    {calls.map((record) => (
                      <ToolCallBlock key={record.id} record={record} />
                    ))}
                    {step.output && (
                      <pre
                        className={`mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg p-2 font-mono text-[11px] ${
                          step.status === 'failed'
                            ? 'bg-red-500/10 text-ink-danger'
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
            {/* Same rule as the wrench on a step row: a glyph that duplicates
                the words beside it is decoration, and "▶ Run this plan" was
                named to a reader as "black right-pointing triangle, Run this
                plan". */}
            <span aria-hidden="true" className="mr-1">▶</span>Run this plan
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
    </div>
  )
}
