import { useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../types'
import { webSource } from '../lib/citations'
import { UNCITED_MARK, UNSETTLED_MARK, contextItemLabel } from '../lib/libraryRecall'
import { Disclosure } from './Disclosure'

/**
 * One recalled passage in an expanded strip. Its own component since v1.17.2,
 * because a citation marker in the answer can now ask the strip to scroll to a
 * particular entry — which needs a ref and an effect per entry.
 *
 * `focus` is a nonce rather than a boolean: activating the same marker twice
 * has to scroll back to it, and a boolean that is already true fires nothing.
 */
function ContextEntry({
  item,
  focus
}: {
  item: NonNullable<ChatMessage['memoryContext']>[number]
  focus: number
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focus > 0) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [focus])
  const highlighted = focus > 0
  // The locator the app retrieved with the passage. Linked only when it is a
  // web URL — a folder pack's source is a path on disk — and a click leaves
  // through the window's own handler, the same route a link the model merely
  // typed already takes.
  const url = webSource(item.url)
  return (
    <div
      ref={ref}
      className={
        highlighted
          ? '-mx-1 rounded-lg bg-amber-400/15 px-1 ring-1 ring-amber-500/40 dark:bg-amber-300/10'
          : undefined
      }
    >
      <span className="font-medium text-ink-secondary">
        {item.index !== undefined && <span className="text-ink-tertiary">[{item.index}] </span>}
        {item.source} · relevance {item.score.toFixed(2)}
      </span>
      {item.cited === false && (
        <span
          className="ml-1 text-ink-tertiary"
          title="The app retrieved this passage and the model saw it, but the answer never cited its number — it is not a source for what was said."
        >
          {UNCITED_MARK}
        </span>
      )}
      {item.unsettled && (
        <span
          className="ml-1 text-ink-tertiary"
          title="The answer cites a number that names no passage this turn retrieved, so the app cannot account for every marker it used — and will not claim this passage went uncited on the strength of a map it knows is incomplete."
        >
          {UNSETTLED_MARK}
        </span>
      )}
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="ml-1 break-all text-sky-700 underline dark:text-sky-400"
          title={`Open the source of this passage: ${url}`}
        >
          {url}
        </a>
      )}
      <p className="whitespace-pre-wrap text-ink-secondary">{item.text}</p>
    </div>
  )
}

/**
 * v0.9 visible recall: which long-term memory chunks were injected into the
 * system prompt for this reply. The display is mechanical — the app shows
 * what it actually sent, it does not ask the model to footnote itself.
 */
export function MemoryContextLine({
  items,
  label = '📚 From memory:',
  title = 'The long-term memory chunks the model was reminded of before answering',
  detail,
  note,
  groups,
  open: controlledOpen,
  onOpenChange,
  highlight
}: {
  items: NonNullable<ChatMessage['memoryContext']>
  label?: string
  title?: string
  /** Replaces the citation list in the collapsed header, when listing sources would overclaim. */
  detail?: string
  /** A warning that follows the header's list or detail — currently the withheld "not cited". */
  note?: string
  /** v1.17.2: the entries split by the lookup that produced them, when there was more than one. */
  groups?: { heading: string; items: NonNullable<ChatMessage['memoryContext']> }[]
  /** v1.17.2: open state, lifted when an inline citation marker has to be able to open this. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** The passage the reader arrived at by activating its marker; `nonce` rises on every activation. */
  highlight?: { index: number; nonce: number } | null
}): JSX.Element {
  const [ownOpen, setOwnOpen] = useState(false)
  const open = controlledOpen ?? ownOpen
  const toggle = (): void => (onOpenChange ? onOpenChange(!open) : setOwnOpen(!open))
  // An unnumbered entry (memory, an attachment chunk) can never be the target:
  // it was never given a marker for anything to name it by.
  const focusOf = (item: NonNullable<ChatMessage['memoryContext']>[number]): number =>
    highlight && item.index !== undefined && highlight.index === item.index ? highlight.nonce : 0
  return (
    <div className="mt-2 text-[11px] text-ink-secondary">
      <button
        type="button"
        onClick={toggle}
        className="rounded px-1.5 py-0.5 hover:bg-black/5 dark:hover:bg-white/10 hover:text-ink-primary"
        title={title}
      >
        {label}{' '}
        {detail ?? items.map(contextItemLabel).join(', ')}{' '}
        {/* amber-700, not the amber-600 most of this app's warnings use: that
            one composites to 3.10:1 on the light panel and this line is the app
            saying it cannot vouch for the marks beside it. 4.89:1 / 11.66:1. */}
        {note && <span className="text-ink-warn">{note} </span>}
        <span>{open ? '▾' : '▸'}</span>
      </button>
      <Disclosure open={open} className="mt-1 space-y-1.5 rounded-xl border border-black/10 dark:border-white/10 bg-black/[0.03] dark:bg-white/[0.03] p-2.5">
          {groups
            ? groups.map((g, gi) => (
                <div key={gi} className="space-y-1.5">
                  <div className="text-ink-tertiary">{g.heading}</div>
                  {g.items.map((i, idx) => (
                    <ContextEntry key={idx} item={i} focus={focusOf(i)} />
                  ))}
                </div>
              ))
            : items.map((i, idx) => (
                <ContextEntry key={idx} item={i} focus={focusOf(i)} />
              ))}
      </Disclosure>
    </div>
  )
}
