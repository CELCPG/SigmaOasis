import { useState } from 'react'
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
  const done = check.claims.filter((c) => c.verdict === 'confirmed').length
  const contradicted = check.claims.filter((c) => c.verdict === 'contradicted').length

  const summary =
    check.claims.length === 0
      ? isStreaming
        ? 'Extracting claims…'
        : 'Claim check'
      : `Claim check: ${check.claims.length} claim${check.claims.length === 1 ? '' : 's'}` +
        (isStreaming ? ' (running…)' : ` — ${done} confirmed, ${contradicted} contradicted`)

  return (
    <div className="my-2 overflow-hidden rounded-2xl border border-amber-400/25 bg-amber-400/[0.05] text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-amber-400/10"
      >
        <span className={isStreaming ? 'animate-pulse' : ''}>🧪</span>
        <span className="font-medium text-amber-700 dark:text-amber-300">{summary}</span>
        {check.modelId && (
          <span className="min-w-0 truncate font-mono text-[10px] text-neutral-400">
            {check.roleName} · {check.modelId}
          </span>
        )}
        <span className="ml-auto text-neutral-400">{open ? '▾' : '▸'}</span>
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
                    <p className="text-neutral-600 dark:text-neutral-300">{claim.text}</p>
                    <p className="mt-0.5 text-[10px] text-neutral-400">
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
          {check.budgetNote && (
            <p className="mt-2 text-[10px] text-neutral-400">{check.budgetNote}</p>
          )}
          {!isStreaming && check.claims.length > 0 && (
            <p className="mt-2 border-t border-amber-400/15 pt-1.5 text-[10px] text-neutral-400">
              Each verdict rests on the one source shown. A confirmation is only as good as that
              source — open it before relying on the claim.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
