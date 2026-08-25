import { useState } from 'react'
import { claimCheckSummary, sourceCaveat, UNREACHABLE_NOTE, UNREACHABLE_REMEDY } from '../lib/claimCheck'
import { useAppStore } from '../stores/appStore'
import type { ClaimCheckRecord, ClaimVerdict } from '../types'

interface Props {
  check: ClaimCheckRecord
  /** True while the pass is still running (claims stream in one by one). */
  isStreaming: boolean
}

const VERDICT_STYLE: Record<ClaimVerdict, { icon: string; label: string; classes: string }> = {
  confirmed: {
    icon: '✓',
    label: 'Confirmed',
    classes: 'text-emerald-600 dark:text-emerald-400'
  },
  contradicted: {
    icon: '✗',
    label: 'Contradicted',
    classes: 'text-red-600 dark:text-red-400'
  },
  unverifiable: {
    icon: '?',
    label: 'Unverifiable',
    classes: 'text-amber-600 dark:text-amber-400'
  },
  // Not a verdict — an admission that no verdict was reached, and why.
  unchecked: {
    icon: '–',
    label: 'Not checked',
    // Quieter than a verdict, but still a statement about the answer's
    // standing, so it goes through the ink scale rather than a raw grey.
    classes: 'text-ink-secondary'
  }
}

/**
 * v1.2: the mechanical per-claim verification of a reply — each claim the
 * critic extracted, its verdict, and the source that settled it. Collapsible,
 * mirroring SecondOpinionBlock/ToolCallBlock so every disclosure in a message
 * reads as one system.
 *
 * The footer caveat is deliberate: a confirmation is only as good as the one
 * source that settled it. Click through before relying on it.
 */
export function ClaimCheckBlock({ check, isStreaming }: Props): JSX.Element {
  const [open, setOpen] = useState(true)
  const openSettingsAt = useAppStore((s) => s.openSettingsAt)
  // Both lines are decided in lib/claimCheck.ts, where node:test can read them.
  const summary = claimCheckSummary(check, isStreaming)
  const caveat = sourceCaveat(check.claims)
  // A critic's only complaint about UNREACHABLE_NOTE was that its remedy is
  // prose. It is offered as a control exactly where the app has proved the
  // remedy is the right one — every search this turn failed to connect — and
  // nowhere else, because a button that fixes the wrong thing is worse than a
  // sentence. The prose stays: an export, a screenshot and a copy-paste all
  // survive this component, and a button does not.
  const unreachable = check.budgetNote === UNREACHABLE_NOTE || summary === UNREACHABLE_NOTE

  return (
    <div className="my-2 overflow-hidden rounded-2xl border border-amber-400/25 bg-amber-400/[0.05] text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-amber-400/10"
      >
        <span className={isStreaming ? 'animate-pulse' : ''}>🧪</span>
        <span className="min-w-0 font-medium text-amber-700 dark:text-amber-300">{summary}</span>
        {check.modelId && (
          <span className="min-w-0 truncate font-mono text-[10px] text-ink-tertiary">
            {check.roleName} · {check.modelId}
          </span>
        )}
        <span className="ml-auto text-ink-tertiary">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1">
          <ul className="space-y-2">
            {check.claims.map((claim, idx) => {
              const style = VERDICT_STYLE[claim.verdict]
              return (
                <li key={idx} className="flex items-start gap-2">
                  <span className={`mt-px font-bold ${style.classes}`} title={style.label}>
                    {style.icon}
                  </span>
                  <div className="min-w-0">
                    <p className="text-ink-secondary">{claim.text}</p>
                    <p className="mt-0.5 text-[10px] text-ink-tertiary">
                      <span className={`font-medium ${style.classes}`}>{style.label}</span>
                      {claim.basis && <span> — {claim.basis}</span>}
                      {claim.source && (
                        <span className="ml-1 break-all font-mono">{claim.source}</span>
                      )}
                    </p>
                  </div>
                </li>
              )
            })}
          </ul>
          {check.budgetNote && check.budgetNote !== summary && (
            <p className="mt-2 text-[10px] text-ink-tertiary">{check.budgetNote}</p>
          )}
          {unreachable && (
            <button
              type="button"
              onClick={() => openSettingsAt(UNREACHABLE_REMEDY.tab)}
              className="mt-2 rounded-lg border border-amber-400/40 px-2 py-0.5 text-[10px] font-medium text-amber-700 hover:bg-amber-400/10 dark:text-amber-300"
            >
              Open {UNREACHABLE_REMEDY.label}
            </button>
          )}
          {!isStreaming && caveat && (
            <p className="mt-2 border-t border-amber-400/15 pt-1.5 text-[10px] text-ink-tertiary">
              {caveat}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
