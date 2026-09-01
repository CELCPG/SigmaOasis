import { useState } from 'react'
import { reviewCameBack, secondOpinionLabel } from '../lib/secondOpinion'
import type { SecondOpinionRecord } from '../types'
import { Disclosure } from './Disclosure'

interface Props {
  opinion: SecondOpinionRecord
  /** True while the review is still streaming in. */
  isStreaming: boolean
}

/**
 * v0.9: a different role's review of a reply — which claims it could not
 * verify, and the check that would settle each. Collapsible, mirroring
 * ReasoningBlock/ToolCallBlock so every disclosure in a message reads as one
 * system.
 *
 * The footer caveat is deliberate: a clean review from another local model is
 * a second guess from a different angle, not verification.
 */
export function SecondOpinionBlock({ opinion, isStreaming }: Props): JSX.Element {
  const [open, setOpen] = useState(true)

  // v1.9.2: a review that never arrived is not a review. The byline and the
  // "a different model reviewed this" footer both hang off whether one did.
  const reviewed = reviewCameBack(opinion.text)
  const label = secondOpinionLabel(opinion, isStreaming)

  return (
    <div className="my-2 overflow-hidden rounded-2xl border border-violet-400/25 bg-violet-400/[0.06] text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-violet-400/10"
      >
        <span className={isStreaming ? 'animate-pulse' : ''}>🔍</span>
        <span className="font-medium text-violet-600 dark:text-violet-300">{label}</span>
        {opinion.automatic && (
          <span
            className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-ink-warn"
            title="Triggered automatically because this factual-looking answer consulted no web sources"
          >
            auto — unverified answer
          </span>
        )}
        {opinion.modelId && (
          <span className="min-w-0 truncate font-mono text-[10px] text-ink-tertiary">
            {opinion.modelId}
          </span>
        )}
        <span className="ml-auto text-ink-tertiary">{open ? '▾' : '▸'}</span>
      </button>
      <Disclosure open={open} className="px-3 pb-3 pt-1">
          <p className="whitespace-pre-wrap text-ink-secondary">
            {opinion.text}
            {isStreaming && <span className="animate-pulse">▌</span>}
          </p>
          {opinion.roleName && !isStreaming && reviewed && (
            <p className="mt-2 border-t border-violet-400/15 pt-1.5 text-[10px] text-ink-tertiary">
              A different local model reviewed this answer. A clean review is a second guess from
              another angle — not verification. Run the checks it names to be sure.
            </p>
          )}
      </Disclosure>
    </div>
  )
}
