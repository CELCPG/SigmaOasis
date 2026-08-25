import { useState, type CSSProperties } from 'react'
import type { ToolCallRecord } from '../types'
import { declinedToCall, foundNothing } from '../lib/grounding'
import { readToolFailure } from '../../../shared/tools/outcomes'
import { composeFailure, copyableFailure } from '../../../shared/failure'
import { toolVisualForName } from '../lib/oasisRipple'

const STATUS_ICON: Record<ToolCallRecord['status'], string> = {
  running: '⏳',
  done: '✓',
  error: '✗'
}

/**
 * A call that worked and came back with nothing is neither ✓ nor ✗.
 *
 * Measured (TH2, `.h2h-runs/judge-r4/TH2/run-1`): a green ✓ on
 * `reference_lookup` whose result read "No reference passages found … The
 * reference library is empty" — the same success mark as a lookup that
 * returned passages, over a lookup that supplied none. Collapsed, the header
 * is the whole of what a reader sees, so the distinction has to live there.
 */
const EMPTY_ICON = '∅'
export const EMPTY_RESULT_NOTE = 'found nothing'

/**
 * And a call the app declined to make is not a failure either.
 *
 * Measured (TH2, `.h2h-runs/judge-r5/TH2/run-1`): the turn's first web_search
 * row reads `✗ 🔍 web_search`, the same mark as the fixture's HTTP 500 two rows
 * below it, over a result that begins "That query is a sentence about you, not
 * search terms, so it was not sent". Nothing broke; the app made a judgement,
 * and the reader was shown a breakage.
 *
 * Measured (TTU3, `.h2h-runs/judge-r5/TTU3/run-1`): seven rows of bare
 * `✗ 🔍 web_search`, with `net::ERR_UNSAFE_PORT` — the reason for all seven —
 * only readable once a disclosure is opened. Collapsed, the row said something
 * went wrong and nothing else, so it earns a reason next to the glyph the way
 * `∅` earns "— found nothing".
 */
const DECLINED_ICON = '↩'
export const DECLINED_NOTE = 'declined'

/** Collapsible block for a tool call — or a model-to-model consultation. */
export function ToolCallBlock({ record }: { record: ToolCallRecord }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const isConsult = record.name === 'consult_model'
  const visual = toolVisualForName(record.name)
  const empty = record.status === 'done' && foundNothing(record)
  const declined = declinedToCall(record)
  // A failure the reader cannot name is a failure they have to open a
  // disclosure to understand. Both broken states carry their reason; a decline
  // has no provider error to quote, so the reason is the app's own sentence.
  //
  // v1.17.2: and neither state carries a runtime identifier any more. TTU3's
  // rows read `✗ 🔍 web_search — net::ERR_UNSAFE_PORT`, twice in one turn, over
  // a failure the reader had no way to interpret. `readToolFailure` decides
  // what the row says; `record.result` is untouched, so the model and the audit
  // log still get the code, and the disclosure below quotes it as the network
  // layer's words rather than the app's.
  const failure = record.status === 'error' ? readToolFailure(record.result ?? '') : null
  const reason = failure?.headline ?? ''
  const label = isConsult
    ? `🤝 Consulted ${String(record.args.role ?? 'specialist')}`
    : `${visual.icon} ${record.name}`

  return (
    <div
      className="my-2 overflow-hidden rounded-2xl border text-xs"
      style={{ borderColor: `${visual.color}30`, background: `${visual.color}08` }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-black/10 dark:hover:bg-white/5"
      >
        <span
          className={
            declined
              ? 'text-ink-secondary'
              : record.status === 'error'
                ? 'text-red-500'
                : empty
                  ? 'text-amber-600 dark:text-amber-400'
                  : record.status === 'done'
                    ? 'text-green-500'
                    : ''
          }
          title={
            declined
              ? 'The app declined this call — it never ran, so nothing failed and nothing was sent.'
              : empty
                ? 'The call worked and returned nothing — this reply is not backed by it.'
                : undefined
          }
        >
          {declined ? DECLINED_ICON : empty ? EMPTY_ICON : STATUS_ICON[record.status]}
        </span>
        {/*
          min-w-0 truncate, like the reason span below it: this is a flex item,
          so without min-w-0 its width is its own longest word. Measured in a
          198px split-view row, on `🔎 reference_lookup_home_safety_corpus`:
          under the old `overflow-wrap: anywhere` the identifier broke across
          two lines inside itself, in a span squeezed to 138.3px; under
          `break-word` it instead wants 229px, pushes the 196px row past the
          wrapper's overflow-hidden, and is silently clipped. Neither is a name.
          An ellipsis, with the whole of it in the tooltip, is.
        */}
        <span
          className="min-w-0 truncate font-medium"
          title={label}
          style={{ color: record.status === 'running' ? visual.color : undefined }}
        >
          {label}
        </span>
        {empty && <span className="text-amber-600 dark:text-amber-400">— {EMPTY_RESULT_NOTE}</span>}
        {/* The row states the state in words too: a glyph is not a reading. */}
        {reason && failure && (
          <span
            className={declined ? 'min-w-0 truncate text-ink-secondary' : 'min-w-0 truncate text-red-500'}
            // The hover text is the same reading the disclosure gives, evidence
            // and all — not the raw result, which also carries the model's
            // coaching and has no business in a tooltip.
            title={composeFailure(failure)}
          >
            — {declined ? `${DECLINED_NOTE}: ` : ''}
            {reason}
          </span>
        )}
        <span className="ml-auto text-ink-tertiary">{open ? '▾' : '▸'}</span>
      </button>
      {record.preamble && (
        <div className="px-3 pb-1.5 italic text-ink-secondary">
          “{record.preamble}”
        </div>
      )}
      {/* v1.7: while the tool runs, a light travels its base in the tool's color. */}
      {record.status === 'running' && (
        <div className="tool-scanline" style={{ '--scan-color': visual.color } as CSSProperties} />
      )}
      {open && (
        <div className="space-y-2 p-3">
          <div>
            <div className="mb-1 font-medium text-ink-secondary">
              {isConsult ? 'Task delegated' : 'Arguments'}
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-black/5 dark:bg-white/5 p-2 font-mono">
              {isConsult ? String(record.args.task ?? '') : JSON.stringify(record.args, null, 2)}
            </pre>
          </div>
          {record.result !== undefined && failure === null && (
            <div>
              <div className="mb-1 font-medium text-ink-secondary">
                {isConsult ? 'Specialist reply' : 'Result'}
              </div>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-black/5 dark:bg-white/5 p-2 font-mono">
                {record.result}
              </pre>
            </div>
          )}
          {/* A failure's disclosure is not a dump of the error text. TTU3 put
              `net::ERR_UNSAFE_PORT` here as the ENTIRE body — the whole of what
              opening the row bought. It now leads with what happened, says what
              to do where there is anything to do, and only then quotes the
              runtime, attributed, so a reader can tell whose words are whose. */}
          {failure && (
            <div>
              <div className="mb-1 font-medium text-ink-secondary">What happened</div>
              <p className="text-ink-secondary">{failure.sentence}</p>
              {failure.remedy && <p className="mt-1 text-ink-secondary">{failure.remedy.text}</p>}
              {failure.detail && (
                <>
                  <div className="mb-1 mt-2 font-medium text-ink-tertiary">
                    {failure.detail.source} reported
                  </div>
                  <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-black/5 dark:bg-white/5 p-2 font-mono text-ink-secondary">
                    {failure.detail.text}
                  </pre>
                </>
              )}
              {/* The identifier is one keystroke away for whoever needs it —
                  which is the person filing the bug, not the person reading
                  the answer. */}
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(copyableFailure(failure, `${record.name} failed`))
                    .then(() => {
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    })
                    .catch(() => setCopied(false))
                }}
                className="mt-2 rounded-lg border border-black/10 px-2 py-0.5 text-ink-secondary hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
              >
                {copied ? 'Copied' : 'Copy details'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
