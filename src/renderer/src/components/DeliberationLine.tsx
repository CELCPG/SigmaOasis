import { useState } from 'react'
import type { DeliberationRecord } from '../types'
import { Disclosure } from './Disclosure'
import { describeDeliberation, draftWentUnreviewed } from '../lib/deliberation'

/**
 * v1.5.1 think-harder disclosure: what the pass did, and the draft and review
 * on demand — the process, never a score.
 */
export function DeliberationLine({ record }: { record: DeliberationRecord }): JSX.Element {
  const [open, setOpen] = useState(false)
  const busy = record.status === 'reviewing' || record.status === 'revising'
  // v1.9.2: the reviewer returned nothing (or failed) — the tooltip must not
  // describe a review that did not happen. v1.17.3: and the question is asked
  // in lib/deliberation.ts, once, by the same predicate that gates the retry.
  const unreviewed = draftWentUnreviewed(record)
  return (
    <div className="mt-2 text-[11px] text-ink-secondary">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded px-1.5 py-0.5 text-left hover:bg-black/5 dark:hover:bg-white/10 hover:text-ink-primary"
        title={
          !busy && unreviewed
            ? `${record.reviewerRole} returned no review at all, so no reviewer read this reply. The figure checks above are a different pass and say nothing about it. Run Think harder again, or use 2nd opinion.`
            : record.self
              ? 'No second slot was enabled, so the same model reviewed its own draft — weaker than an independent review, and labelled as such (Settings → Roles → self-review).'
              : `A different role (${record.reviewerRole}) listed the problems in the draft; the answerer revised once with that list.`
        }
      >
        {describeDeliberation(record)} {busy ? '' : <span>{open ? '▾' : '▸'}</span>}
      </button>
      <Disclosure open={open && !busy} className="mt-1 space-y-2 rounded-xl border border-black/10 dark:border-white/10 bg-black/[0.03] dark:bg-white/[0.03] p-2.5">
          <div>
            <span className="font-medium text-ink-secondary">
              Review{record.self ? ' (self)' : ` by ${record.reviewerRole}`}
            </span>
            <p className="whitespace-pre-wrap text-ink-secondary">{record.review || '(empty)'}</p>
          </div>
          {record.revised && (
            <div>
              <span className="font-medium text-ink-secondary">Draft (before revision)</span>
              <p className="whitespace-pre-wrap text-ink-secondary">{record.draft}</p>
            </div>
          )}
      </Disclosure>
    </div>
  )
}
