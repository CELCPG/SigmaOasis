import { useMemo } from 'react'
import { useAppStore } from '../stores/appStore'
import type { ToolCallRecord } from '../types'
import { wasDeclined } from '../../../shared/tools/outcomes'
import { Disclosure } from './Disclosure'

/**
 * v2.8: a proposed patch. While the tool call waits, the diff the main
 * process computed is here with Apply and Discard — the model proposed, the
 * reader sees exactly what changes, nothing is written until Apply. After
 * the decision the record's result carries the same diff, so the block
 * reads the same on reload: what was proposed, and what happened to it.
 */

function DiffView({ diff }: { diff: string }): JSX.Element {
  const lines = useMemo(() => diff.split('\n'), [diff])
  return (
    <pre className="max-h-96 overflow-auto rounded bg-black/5 p-2 font-mono text-[11px] leading-snug dark:bg-white/5" data-testid="patch-diff">
      {lines.map((l, i) => (
        <div
          key={i}
          className={
            l.startsWith('+++') || l.startsWith('---')
              ? 'text-ink-tertiary'
              : l.startsWith('@@')
                ? 'text-ink-secondary'
                : l.startsWith('+')
                  ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300'
                  : l.startsWith('-')
                    ? 'bg-red-500/15 text-red-800 dark:text-red-300'
                    : undefined
          }
        >
          {l || ' '}
        </div>
      ))}
    </pre>
  )
}

/** The diff a finished record carries after its first blank line. */
function diffOf(result: string | undefined): { lead: string; diff: string } {
  const text = result ?? ''
  const at = text.indexOf('\n\n')
  return at < 0 ? { lead: text, diff: '' } : { lead: text.slice(0, at), diff: text.slice(at + 2) }
}

export function PatchBlock({ record }: { record: ToolCallRecord }): JSX.Element {
  const pending = useAppStore((s) => s.pendingPatches.find((p) => p.callId === record.id))
  const removePatchReview = useAppStore((s) => s.removePatchReview)
  const path = String(record.args.path ?? '')
  const decide = (approved: boolean): void => {
    if (!pending) return
    void window.api.patchDecide(pending.reviewId, approved)
    removePatchReview(pending.reviewId)
  }
  if (pending) {
    return (
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-xs" data-testid="patch-review">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="font-medium">
            📝 Proposed change to <span className="font-mono">{pending.path}</span>
          </span>
          <span className="text-ink-tertiary">
            {pending.isNew ? `new file, ${pending.stats.added} line${pending.stats.added === 1 ? '' : 's'}` : `+${pending.stats.added} −${pending.stats.removed} in ${pending.stats.hunks} hunk${pending.stats.hunks === 1 ? '' : 's'}`}
          </span>
          <span className="ml-auto flex gap-2">
            <button type="button" onClick={() => decide(true)} className="rounded-lg bg-accent px-3 py-1 text-xs text-white">
              Apply
            </button>
            <button type="button" onClick={() => decide(false)} className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10">
              Discard
            </button>
          </span>
        </div>
        <DiffView diff={pending.diff} />
        <p className="mt-2 text-ink-tertiary">Nothing is written until you press Apply. The model is told which you chose.</p>
      </div>
    )
  }
  const { lead, diff } = diffOf(record.result)
  const declined = record.status === 'error' && wasDeclined(record.result ?? '')
  const running = record.status === 'running'
  return (
    <div className="rounded-xl border border-black/10 dark:border-white/10 p-3 text-xs" data-testid="patch-block">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          {running ? '📝 Proposing a change to' : declined ? '↩ Discarded change to' : record.status === 'done' ? '✅ Applied change to' : '✗ Patch failed for'}{' '}
          <span className="font-mono">{path}</span>
        </span>
        {!running && lead && <span className="text-ink-tertiary">{lead.replace(/^Applied to [^:]+: /, '')}</span>}
      </div>
      {diff && (
        <Disclosure open={false} className="mt-2">
          <DiffView diff={diff} />
        </Disclosure>
      )}
    </div>
  )
}
