import { memo, useMemo, useState } from 'react'
import type { ChatMessage, Conversation, DeliberationRecord, GroundingReport, ToolCallRecord } from '../types'
import { describeRevisionOutcome } from '../lib/toolGrounding'
import { ACCENT } from '../lib/colors'
import { retrievedCitations, webSource } from '../lib/citations'
import { contextItemLabel } from '../lib/libraryRecall'
import { renderMarkdown, splitStreamingMarkdown } from '../lib/markdown'
import { speak, stopSpeaking } from '../lib/voice'
import { describeOasisState } from '../lib/oasisRipple'
import { FIRST_BYTE_TIMEOUT_MS, STREAM_STALL_MS } from '../hooks/chatTransport'
import { replyAffordances } from '../lib/replyRecovery'
import { type TurnPhase } from '../lib/turnPhase'
import { ESCALATION_REASON_TEXT } from '../lib/routing'
import { LIBRARY_MISS_LABEL, LIBRARY_STRIP_LABEL, libraryMissDetail } from '../lib/libraryRecall'
import { useAppStore } from '../stores/appStore'
import { useLMStudio } from '../hooks/useLMStudio'
import { ToolCallBlock } from './ToolCallBlock'
import { RanCodeBlock } from './RanCodeBlock'
import { ReasoningBlock } from './ReasoningBlock'
import { SecondOpinionBlock } from './SecondOpinionBlock'
import { classifyReview, describeDeliberation, thinkHarderNote } from '../lib/deliberation'
import { ClaimCheckBlock } from './ClaimCheckBlock'
import { PlanBlock } from './PlanBlock'
import { answerRecords } from '../hooks/planMode'
import { OasisRipple } from './OasisRipple'
import { SigmaAvatar } from './SigmaAvatar'
import { BranchMenu } from './BranchMenu'

interface Props {
  message: ChatMessage
  /** True while this message is the one currently streaming. */
  isStreaming: boolean
  /** True for the final message in the conversation (enables Regenerate). */
  isLast: boolean
  /** The conversation this message belongs to — enables v1.4 branching. */
  conversation?: Conversation
}

/** The two controls in a code block's header: Wrap and Copy, both delegated. */
function handleCodeBlockClick(event: React.MouseEvent<HTMLDivElement>): void {
  const target = event.target as HTMLElement
  const wrap = target.closest('.code-wrap-btn')
  if (wrap) {
    const block = wrap.closest('.code-block')
    if (!block) return
    wrap.setAttribute('aria-pressed', String(block.classList.toggle('code-wrapped')))
    return
  }
  const button = target.closest('.code-copy-btn')
  if (!button) return
  const code = button.closest('.code-block')?.querySelector('code')?.textContent ?? ''
  void navigator.clipboard.writeText(code).then(() => {
    const original = button.textContent
    button.textContent = 'Copied!'
    setTimeout(() => {
      button.textContent = original
    }, 1500)
  })
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * Thumbnails a tool asked to show (image_search). These are data: URLs the main
 * process already fetched and downscaled — never remote URLs — so rendering one
 * makes no network request at all. Each thumbnail links to the page the image
 * came from.
 */
function ToolImageGallery({ records }: { records: ToolCallRecord[] }): JSX.Element | null {
  const withImages = records.filter((r) => r.status === 'done' && r.images && r.images.length > 0)
  if (withImages.length === 0) return null
  return (
    <>
      {withImages.map((record) => {
        // v1.6: an image the Workbench produced (a matplotlib figure) has no
        // source page — it is shown larger, unlinked, and captioned as computed.
        const produced = record.name === 'run_python'
        return (
          <div key={`${record.id}-images`} className="mt-2">
            <div className={produced ? 'flex flex-wrap gap-2' : 'grid grid-cols-3 gap-2'}>
              {record.images!.map((img, i) =>
                produced || !img.pageUrl ? (
                  <img
                    key={i}
                    src={img.dataUrl}
                    alt={img.title}
                    title={img.title}
                    loading="lazy"
                    className="max-h-72 max-w-full rounded-xl border border-black/10 object-contain dark:border-white/15"
                  />
                ) : (
                  <a
                    key={i}
                    href={img.pageUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={`${img.title}\n${img.pageUrl}`}
                    className="block overflow-hidden rounded-xl border border-black/10 transition-transform hover:scale-[1.02] dark:border-white/15"
                  >
                    <img src={img.dataUrl} alt={img.title} loading="lazy" className="h-24 w-full object-cover" />
                  </a>
                )
              )}
            </div>
            <div className="mt-1 text-[10px] text-ink-tertiary">
              {produced
                ? `📈 ${record.images!.length} figure(s) produced by the code that ran: ${record.images!.map((i) => i.title).join(', ')}`
                : `🖼️ ${record.images!.length} image(s) for “${String(record.args.query ?? '')}” — click a thumbnail to open its source page.`}
            </div>
          </div>
        )
      })}
    </>
  )
}

/**
 * v1.3: figures or links the reply asserted that its own tools did not
 * support. Distinct from the `unverified` badge, which means "no source was
 * consulted at all" — this one fires when sources *were* consulted and the
 * answer went past them, which is the harder failure to notice by eye.
 */
function GroundingWarning({ report }: { report: GroundingReport }): JSX.Element {
  const parts: string[] = []
  if (report.figures.length > 0) {
    parts.push(
      `${report.figures.length} figure${report.figures.length === 1 ? '' : 's'} (${report.figures.join(', ')})`
    )
  }
  if (report.links.length > 0) {
    parts.push(`${report.links.length} link${report.links.length === 1 ? '' : 's'}`)
  }
  // v1.9.2: named in full rather than counted. A quantity is only ever flagged
  // when something computed or retrieved this turn, so the reply is stating a
  // distance, a duration or a dose against arithmetic the app itself did or a
  // passage it just read — and which of them disagrees is the only thing worth
  // reading.
  const quantities = report.quantities ?? []
  if (quantities.length > 0) {
    parts.push(
      `${quantities.length} measurement${quantities.length === 1 ? '' : 's'} (${quantities.join(', ')})`
    )
  }
  const origins = report.origins ?? []
  const contacts = report.contacts ?? []
  const addresses = report.addresses ?? []
  const toolClaims = report.toolClaims ?? []
  const toolDisclosure = report.toolDisclosure ?? []
  const citations = report.citations ?? []
  const quotes = report.quotes ?? []
  const attributions = report.attributions ?? []
  return (
    <div
      className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-400"
      title={
        'These came from the model, not from the tools this turn actually ran ' +
        `(${report.checkedAgainst.join(', ')}). Numbers a calculator did not return, and links ` +
        'that appeared in no search result, are the two things most worth re-checking yourself.'
      }
    >
      {parts.length > 0 && (
        <div>
          ⚠️ {parts.join(' and ')} in this reply {parts.length > 1 ? 'are' : 'is'} not backed by the
          tool output.
        </div>
      )}
      {/*
        v1.12.1: the reply's account of its own process. First, because a
        reader who believes "I searched the web for this" reads everything
        under it as sourced.
      */}
      {toolClaims.length > 0 && (
        <div className={parts.length > 0 ? 'mt-1' : undefined}>
          ⚠️ This reply says it used {toolClaims.join(', ')}, which did not run this turn.
        </div>
      )}
      {/*
        v1.14: the same disclosure read the other way round. A "Tools used"
        section that names documents instead of calls answers the reader's
        question with something that is not a tool, and no name in it is wrong
        — so only the omission gives it away.
      */}
      {toolDisclosure.length > 0 && (
        <div className={parts.length > 0 || toolClaims.length > 0 ? 'mt-1' : undefined}>
          ⚠️ This reply lists the tools it used without naming{' '}
          {toolDisclosure.join(', ')}, which {toolDisclosure.length === 1 ? 'is' : 'are'} what
          actually ran this turn.
        </div>
      )}
      {/*
        v1.14: quotation fidelity. The user asked for a verbatim line and the
        app held the passage it came from; a quotation that is not in it is an
        invented source in the notation the reader trusts most.
      */}
      {quotes.length > 0 && (
        <div className="mt-1">
          ⚠️ Quoted as exact but in no tool output this turn:{' '}
          {quotes.map((q) => `“${q}”`).join('; ')}.
        </div>
      )}
      {attributions.length > 0 && (
        <div className="mt-1">
          ⚠️ {attributions.join('; ')} — that passage came from a different document than the one
          named here.
        </div>
      )}
      {/*
        Called out separately from figures and links because it is a different
        kind of wrong: not an unsupported number but a contradicted fact, and
        the one most likely to be repeated out loud to someone else.
      */}
      {origins.length > 0 && (
        <div className={parts.length > 0 || toolClaims.length > 0 ? 'mt-1' : undefined}>
          ⚠️ This reply places the subject in {origins.join(', ')}, which the sources it consulted
          never mention.
        </div>
      )}
      {/*
        Listed in full rather than counted: a phone number is checked by
        looking at it, and this is the one item here that a reader may be
        about to put in front of customers.
      */}
      {contacts.length > 0 && (
        <div
          className={
            parts.length > 0 || toolClaims.length > 0 || origins.length > 0 ? 'mt-1' : undefined
          }
        >
          ⚠️ Contact details no tool returned: {contacts.join(', ')}. Verify before sending these
          anywhere.
        </div>
      )}
      {/* Listed in full for the same reason as contacts: someone drives there. */}
      {addresses.length > 0 && (
        <div className="mt-1">
          ⚠️ Addresses no tool returned: {addresses.join('; ')}. Check these before travelling.
        </div>
      )}
      {/* Named in full: a marker pointing at a passage that was never
          retrieved is a source the reader cannot open, however plainly it is
          written — and the numbered passages that WERE retrieved are listed
          under this reply, so the mismatch is checkable by eye. */}
      {citations.length > 0 && (
        <div className="mt-1">
          ⚠️ {citations.join(', ')} {citations.length === 1 ? 'cites' : 'cite'} no passage the
          library returned this turn — that citation points at nothing.
        </div>
      )}
      {report.links.length > 0 && (
        <ul className="mt-1 list-disc pl-4 opacity-90">
          {report.links.map((link) => (
            <li key={link} className="break-all">
              {link}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1 opacity-75">
        Checked against: {report.checkedAgainst.join(', ')}.
      </div>
    </div>
  )
}

/**
 * The answer on screen is not the one the model first produced. Saying so is
 * not optional: a correction the user cannot see is the app quietly editing the
 * record, which is exactly what every other check here exists to prevent.
 *
 * But saying it is not enough on its own. Through v1.14 this line read "N
 * unsupported items were sent back for verification or removal" — a request,
 * described in green as though it were an outcome — and a revision is kept
 * whenever it *reduces* the findings, so it sat over answers where the finding
 * was still standing. See `describeRevisionOutcome`; the wording, the count and
 * the tone are all its verdict, and this component only paints it.
 *
 * `after` on the record is authoritative. `grounding` is the same report and is
 * the fallback for messages persisted before `after` was stored.
 */
function RevisedLine({ message }: { message: ChatMessage }): JSX.Element | null {
  const revision = describeRevisionOutcome(
    message.corrected?.before ?? null,
    message.corrected?.after ?? message.grounding ?? null
  )
  if (!revision.text) return null
  return (
    <div
      className={
        revision.resolved
          ? 'mt-2 text-[11px] text-emerald-700 dark:text-emerald-400'
          : 'mt-2 text-[11px] text-amber-700 dark:text-amber-300'
      }
      title={
        revision.resolved
          ? 'A mechanical check found specifics the turn\'s tools did not support, and the ' +
            'model was asked to verify or remove them. What you are reading is the revision, ' +
            're-checked: none of the named items is still faulted.'
          : 'A mechanical check found specifics the turn\'s tools did not support, and the ' +
            'model was asked to verify or remove them. What you are reading is the revision — ' +
            'and the items named here survived it, so they are still unsupported.'
      }
    >
      ✎ {revision.text}
    </div>
  )
}

/**
 * v1.5.1 think-harder disclosure: what the pass did, and the draft and review
 * on demand — the process, never a score.
 */
function DeliberationLine({ record }: { record: DeliberationRecord }): JSX.Element {
  const [open, setOpen] = useState(false)
  const busy = record.status === 'reviewing' || record.status === 'revising'
  // v1.9.2: the reviewer returned nothing (or failed) — the tooltip must not
  // describe a review that did not happen.
  const unreviewed = record.status === 'error' || classifyReview(record.review) === 'none'
  return (
    <div className="mt-2 text-[11px] text-ink-secondary">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded px-1.5 py-0.5 text-left hover:bg-black/5 dark:hover:bg-white/10 hover:text-ink-primary"
        title={
          !busy && unreviewed
            ? `${record.reviewerRole} returned no review at all, so nothing here checked this reply. Run Think harder again, or use 2nd opinion.`
            : record.self
              ? 'No second slot was enabled, so the same model reviewed its own draft — weaker than an independent review, and labelled as such (Settings → Models → self-review).'
              : `A different role (${record.reviewerRole}) listed the problems in the draft; the answerer revised once with that list.`
        }
      >
        {describeDeliberation(record)} {busy ? '' : <span>{open ? '▾' : '▸'}</span>}
      </button>
      {open && !busy && (
        <div className="mt-1 space-y-2 rounded-xl border border-black/10 dark:border-white/10 bg-black/[0.03] dark:bg-white/[0.03] p-2.5">
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
        </div>
      )}
    </div>
  )
}

/**
 * v0.9 visible recall: which long-term memory chunks were injected into the
 * system prompt for this reply. The display is mechanical — the app shows
 * what it actually sent, it does not ask the model to footnote itself.
 */
function MemoryContextLine({
  items,
  label = '📚 From memory:',
  title = 'The long-term memory chunks the model was reminded of before answering',
  detail
}: {
  items: NonNullable<ChatMessage['memoryContext']>
  label?: string
  title?: string
  /** Replaces the citation list in the collapsed header, when listing sources would overclaim. */
  detail?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-2 text-[11px] text-ink-secondary">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded px-1.5 py-0.5 hover:bg-black/5 dark:hover:bg-white/10 hover:text-ink-primary"
        title={title}
      >
        {label}{' '}
        {detail ?? items.map(contextItemLabel).join(', ')}{' '}
        <span>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="mt-1 space-y-1.5 rounded-xl border border-black/10 dark:border-white/10 bg-black/[0.03] dark:bg-white/[0.03] p-2.5">
          {items.map((i, idx) => {
            // The locator the app retrieved with the passage. Linked only when
            // it is a web URL — a folder pack's source is a path on disk — and
            // a click leaves through the window's own handler, the same route
            // a link the model merely typed already takes.
            const url = webSource(i.url)
            return (
              <div key={idx}>
                <span className="font-medium text-ink-secondary">
                  {i.index !== undefined && <span className="text-ink-tertiary">[{i.index}] </span>}
                  {i.source} · relevance {i.score.toFixed(2)}
                </span>
                {url && (
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-1 break-all text-sky-600 underline dark:text-sky-400"
                    title={`Open the source of this passage: ${url}`}
                  >
                    {url}
                  </a>
                )}
                <p className="whitespace-pre-wrap text-ink-secondary">{i.text}</p>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * The named wait. Before the model is asked, a context provider can hold the
 * turn open on the network; after the last token, the checks run for seconds
 * more. Both used to be a spinner over an unexplained pause — this says which
 * one it is, and (while verifying) that the answer above is already yours to
 * use. Same shape as the compaction line in ChatArea, deliberately.
 */
function TurnPhaseLine({ phase }: { phase: TurnPhase }): JSX.Element {
  return (
    <div
      className="mt-2 flex items-center gap-2 text-[11px]"
      style={{ color: 'var(--accent-ink)' }}
      role="status"
      aria-live="polite"
      title={
        phase.stage === 'verifying'
          ? 'The reply is complete and you can copy, read or branch it now. These checks run on top of it; if one finds something, the reply is revised and the change is disclosed.'
          : 'The app is gathering context for this turn. The model has not been asked yet.'
      }
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent shadow-[0_0_8px_rgba(0,212,170,0.8)]" />
      <span className="font-medium tracking-[0.08em]">{phase.label}…</span>
      <span className="min-w-0 truncate text-ink-secondary">{phase.detail}</span>
    </div>
  )
}

/**
 * The performance readout under a reply. Token figures appear only when the
 * server reported them — timing is always measured, token counts never
 * estimated, so nothing here is a guess dressed up as a measurement.
 */
function formatStats(stats: NonNullable<ChatMessage['stats']>): string {
  const parts: string[] = []
  if (stats.completionTokens) parts.push(`${stats.completionTokens.toLocaleString()} tok`)
  if (stats.tokensPerSecond) parts.push(`${stats.tokensPerSecond.toFixed(1)} tok/s`)
  if (stats.ttftMs) parts.push(`${(stats.ttftMs / 1000).toFixed(2)}s to first token`)
  parts.push(`${(stats.totalMs / 1000).toFixed(1)}s total`)
  return parts.join(' · ')
}

export const MessageBubble = memo(function MessageBubble({
  message,
  isStreaming,
  isLast,
  conversation
}: Props): JSX.Element {
  // While this message streams, its live text arrives via the streamingTail
  // slice, not the message object — one token re-renders this bubble alone
  // (see appStore.streamingTail). The selector returns null for every other
  // message, so finished bubbles never re-render on a token.
  const tailText = useAppStore((s) =>
    s.streamingTail && s.streamingTail.messageId === message.id ? s.streamingTail.text : null
  )
  const displayContent = tailText ?? message.content

  // Finished messages parse once, memoized on their content. The streaming
  // one parses its stable prefix only when a block completes, and re-parses
  // just the growing tail per flush — the O(n²) whole-reply re-parse was the
  // single heaviest per-token cost in the app.
  const [stablePart, livePart] =
    tailText !== null && message.role === 'assistant'
      ? splitStreamingMarkdown(displayContent)
      : [displayContent, '']
  // v1.13: the passages this turn's library lookups returned, so an inline
  // [1] renders as the passage it names rather than as three dead characters.
  const citations = useMemo(
    () => (message.role === 'assistant' ? retrievedCitations(message.toolCalls ?? []) : []),
    [message.role, message.toolCalls]
  )
  const stableHtml = useMemo(
    () => (message.role === 'assistant' && stablePart ? renderMarkdown(stablePart, citations) : ''),
    [message.role, stablePart, citations]
  )
  // Both halves are DOMPurify-sanitized in renderMarkdown; concatenating two
  // sanitized block-level fragments is still sanitized.
  const html =
    livePart && message.role === 'assistant'
      ? stableHtml + renderMarkdown(livePart, citations)
      : stableHtml
  // Declared before the marker/user branches below: hooks must run in the same
  // order on every render, and an early return would skip them. That includes
  // the three settings subscriptions — they were once below the early returns,
  // which made the hook count differ between user and assistant messages.
  const [speaking, setSpeaking] = useState(false)
  const [copied, setCopied] = useState(false)
  const { regenerate, secondOpinion, escalate, deliberate } = useLMStudio()
  const streaming = useAppStore((s) => s.streaming)
  // The turn's named stage (lib/turnPhase.ts): what the wait is called while
  // it lasts, and — once the checks start — the signal that this message's
  // text is final enough to copy, read aloud or branch.
  const turnPhase = useAppStore((s) => s.turnPhase)
  const secondOpinionEnabled = useAppStore((s) => s.settings?.secondOpinion.enabled) ?? false
  const hideToolCalls = useAppStore((s) => s.settings?.hideToolCalls) ?? false
  const reasoningDisplay = useAppStore((s) => s.settings?.reasoningDisplay) ?? 'collapsed'
  const showStats = useAppStore((s) => s.settings?.showResponseStats) ?? true

  const copyMessage = (): void => {
    void navigator.clipboard.writeText(displayContent).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  // Marker messages (v0.9) are in-chat dividers, not bubbles — they are never
  // sent to a model, so they render as a quiet centered note.
  if (message.marker) {
    return (
      <div className="flex items-center gap-3 px-4 py-2">
        <div className="mx-auto flex max-w-3xl flex-1 items-center gap-3">
          <span className="h-px flex-1 bg-black/10 dark:bg-white/10" />
          <span className="text-[11px] text-ink-tertiary">{message.content}</span>
          <span className="h-px flex-1 bg-black/10 dark:bg-white/10" />
        </div>
      </div>
    )
  }

  if (message.role === 'user') {
    const images = (message.attachments ?? []).filter((a) => a.kind === 'image' && a.dataUrl)
    const files = (message.attachments ?? []).filter((a) => a.kind === 'file')
    return (
      <div className="flex flex-col items-end gap-2 px-4 py-2">
        {images.length > 0 && (
          <div className="flex max-w-[80%] flex-wrap justify-end gap-2">
            {images.map((a) => (
              <img
                key={a.id}
                src={a.dataUrl}
                alt={a.name}
                title={a.name}
                className="max-h-52 rounded-xl border border-black/10 dark:border-white/15 object-contain"
              />
            ))}
          </div>
        )}
        {files.map((a) => (
          <span
            key={a.id}
            className="rounded-lg border border-black/10 dark:border-white/15 px-2.5 py-1.5 text-xs"
            title={
              a.indexed
                ? `${a.name} — ${(a.totalChars ?? 0).toLocaleString()} characters, indexed: relevant passages are retrieved for each question`
                : a.name
            }
          >
            📄 {a.name}
            {a.indexed && <span className="ml-1 text-ink-tertiary">(indexed)</span>}
          </span>
        ))}
        {/* break-words: a pasted path or key has no break opportunity of its
            own and would otherwise run straight out of the bubble. */}
        {message.content && (
          <div className="oasis-enter max-w-[80%] whitespace-pre-wrap break-words rounded-3xl rounded-br-md px-4 py-2.5 text-sm border border-[rgba(0,212,170,0.18)] bg-[rgba(0,212,170,0.12)] backdrop-blur-xl">
            {message.content}
          </div>
        )}
        <span
          className="text-[10px] text-ink-tertiary"
          title={new Date(message.createdAt).toLocaleString()}
        >
          {formatTime(message.createdAt)}
        </span>
      </div>
    )
  }

  const accent = message.color ? ACCENT[message.color] : null
  const toolCalls = message.toolCalls ?? []
  // The Oasis Ripple is the single thinking indicator: ambient pool while the
  // model composes, droplet + colored wave when a tool fires — regardless of
  // the hideToolCalls setting, since the ripple *is* the disclosure.
  const oasisState = describeOasisState(isStreaming, displayContent, toolCalls)
  // Everything that would count as output arriving. While any of it moves the
  // ripple's silence clock keeps resetting; when it stops, the clock runs and
  // the disc starts saying how long it has been and what it is waiting on.
  const streamActivity = `${displayContent.length}:${(message.reasoning ?? '').length}:${toolCalls
    .map((t) => `${t.id}${t.status}`)
    .join(',')}`
  // Which of the transport's two deadlines is actually counting down: a stream
  // that has already produced something is under the stall timeout, one that
  // has produced nothing at all is still under the first-byte ceiling.
  const streamStarted = (message.reasoning ?? '') !== '' || toolCalls.length > 0
  // The action row follows the ANSWER, not the turn. Verification keeps
  // `streaming` true for seconds after the last token, and none of it can
  // change whether a finished reply may be copied, spoken or branched — so
  // the row opens as soon as the text is complete, and also when the turn
  // ended with nothing at all (lib/replyRecovery.ts). Only the buttons that
  // would START a turn wait, and they say so.
  const phaseHere = turnPhase?.messageId === message.id ? turnPhase : null
  const affordances = replyAffordances(message, isLast, isStreaming, phaseHere)
  const busyTitle = streaming ? '\n\nAvailable once this turn’s checks finish.' : ''

  const toggleSpeak = (): void => {
    if (speaking) {
      stopSpeaking()
      setSpeaking(false)
      return
    }
    if (!('speechSynthesis' in window)) return
    const voice = useAppStore.getState().settings?.voice
    speak(message.content, voice?.voiceURI ?? '', voice?.rate ?? 1, () => setSpeaking(false))
    setSpeaking(true)
  }

  return (
    <div className="px-4 py-2">
      <div className="mx-auto flex max-w-3xl items-start gap-3">
        <SigmaAvatar size={32} active={isStreaming} />
        <div
          className={`glass-panel reply-surface min-w-0 flex-1 rounded-3xl rounded-tl-md px-4 py-3 ${isStreaming ? 'bubble-live' : ''}`}
        >
        {message.roleName && (
          <div className="mb-1.5 flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                accent?.badge ?? 'bg-black/10 dark:bg-white/10'
              }`}
            >
              {accent && <span className={`h-1.5 w-1.5 rounded-full ${accent.dot}`} />}
              {message.roleName}
            </span>
            <span className="font-mono text-xs text-ink-tertiary">{message.modelId}</span>
          </div>
        )}

        {affordances.actions && (
          // flex-wrap, because in split view (v1.11) a bubble is half as wide
          // and this row of actions used to run off the edge of the pane.
          <div className="mb-1 flex flex-wrap items-center gap-1 text-xs text-ink-secondary">
            {affordances.onText && (
              <>
                <button
                  type="button"
                  onClick={copyMessage}
                  className="rounded px-1.5 py-0.5 hover:bg-black/5 dark:hover:bg-white/10 hover:text-ink-primary"
                  title="Copy message"
                >
                  {copied ? '✓ Copied' : '📋 Copy'}
                </button>
                <button
                  type="button"
                  onClick={toggleSpeak}
                  className="rounded px-1.5 py-0.5 hover:bg-black/5 dark:hover:bg-white/10 hover:text-ink-primary"
                  title={speaking ? 'Stop reading' : 'Read aloud'}
                >
                  {speaking ? '⏹ Stop' : '🔊 Listen'}
                </button>
              </>
            )}
            {isLast && (
              <button
                type="button"
                onClick={() => void regenerate()}
                disabled={streaming}
                className="rounded px-1.5 py-0.5 hover:bg-black/5 dark:hover:bg-white/10 hover:text-ink-primary disabled:opacity-40"
                title={`Re-answer the last message${busyTitle}`}
              >
                ↻ Regenerate
              </button>
            )}
            {secondOpinionEnabled && affordances.onText && !message.secondOpinion && (
              <button
                type="button"
                onClick={() => void secondOpinion(message.id)}
                disabled={streaming}
                className="rounded px-1.5 py-0.5 hover:bg-black/5 dark:hover:bg-white/10 hover:text-violet-600 dark:hover:text-violet-300 disabled:opacity-40"
                title={`Have a different role review this reply and name the claims it could not verify${busyTitle}`}
              >
                🔍 2nd opinion
              </button>
            )}
            {affordances.onText && !message.deliberation && (
              <button
                type="button"
                onClick={() => void deliberate(message.id)}
                disabled={streaming}
                className="rounded px-1.5 py-0.5 hover:bg-black/5 dark:hover:bg-white/10 hover:text-ink-primary disabled:opacity-40"
                title={
                  'Think harder: have another role review this reply for errors and gaps, then revise it once. The draft and the review stay visible.' +
                  // v1.9.1: on a model that already reasons internally, say what
                  // the reasoning suite measured rather than implying a benefit.
                  (thinkHarderNote(message.modelId ?? '') ? `\n\n${thinkHarderNote(message.modelId ?? '')}` : '') +
                  busyTitle
                }
              >
                🧠 Think harder
              </button>
            )}
            {conversation && <BranchMenu message={message} conversation={conversation} />}
            <span
              className="ml-auto px-1.5 text-[10px]"
              title={new Date(message.createdAt).toLocaleString()}
            >
              {formatTime(message.createdAt)}
            </span>
          </div>
        )}

        {oasisState.mode !== 'hidden' && (
          <OasisRipple
            state={oasisState}
            activity={streamActivity}
            deadlineMs={streamStarted ? STREAM_STALL_MS : FIRST_BYTE_TIMEOUT_MS}
          />
        )}

        {message.plan && (
          <PlanBlock messageId={message.id} plan={message.plan} records={toolCalls} />
        )}

        {message.reasoning && reasoningDisplay !== 'hidden' && (
          <ReasoningBlock
            reasoning={message.reasoning}
            reasoningMs={message.reasoningMs}
            isStreaming={isStreaming && displayContent === ''}
            defaultOpen={reasoningDisplay === 'expanded'}
          />
        )}

        {displayContent !== '' && (
          <div
            className="markdown-body oasis-enter text-sm leading-relaxed"
            onClick={handleCodeBlockClick}
            // Sanitized by DOMPurify in renderMarkdown.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}

        {/*
          Nothing streamed, and nothing else to show for the turn either.
          Through v1.12.1 that rendered as a blank panel — the failure with its
          cause and its next step stripped out of it. Whatever the transport
          managed to diagnose is in the ⚠️ message after this one; the action
          row above carries Regenerate for the same reason this line exists.
        */}
        {!isStreaming && affordances.empty && (
          <div
            className="text-[11px] text-amber-600 dark:text-amber-400"
            title="The turn ended without producing any text. If the server said why, the reason is in the next message."
          >
            ⚠️ Empty reply — nothing came back from the model. Use ↻ Regenerate to ask again.
          </div>
        )}

        {/* Tool-provided pictures are content, not diagnostics — they render
            even when the user hides tool-call blocks. */}
        <ToolImageGallery records={toolCalls} />

        {/* A plan step's calls render inside the plan block, under their step. */}
        {!hideToolCalls &&
          answerRecords(toolCalls).map((record) =>
            record.name === 'run_python' ? (
              <RanCodeBlock key={record.id} record={record} onCodeBlockClick={handleCodeBlockClick} />
            ) : (
              <ToolCallBlock key={record.id} record={record} />
            )
          )}

        {message.routingNote && (
          <div
            className="mt-2 text-[11px] text-ink-tertiary"
            title="The pre-flight router sent this message to a specialty slot based on its content. @mention a role name to override routing."
          >
            🔀 {message.routingNote} — override with @RoleName
          </div>
        )}

        {!isStreaming && message.memoryContext && message.memoryContext.length > 0 && (
          <MemoryContextLine items={message.memoryContext} />
        )}

        {!isStreaming && message.checks && message.checks.length > 0 && (
          <div className="mt-2 space-y-0.5 text-[11px]">
            {message.checks.map((c, i) => (
              <div
                key={i}
                className={c.ok ? 'text-ink-tertiary' : 'text-amber-600 dark:text-amber-400'}
                title="Workbench verification: the app ran Python in the sandbox to check this reply — recomputing its figures, or running the code it contains. Settings → Models → Workbench checks."
              >
                {c.summary}
              </div>
            ))}
          </div>
        )}

        {!isStreaming && message.playbook && (
          <div
            className="mt-2 text-[11px] text-ink-tertiary"
            title="The app added a short numbered method for this kind of question to the turn — the model was asked to follow it. Settings → Models → Playbooks."
          >
            📋 Method: {message.playbook} playbook
          </div>
        )}

        {!isStreaming && message.ledger && (
          <div
            className="mt-2 text-[11px] text-ink-tertiary"
            title="The app handed the model a mechanical record of what this conversation has established — computed figures, files, session variables, your stated constraints — built from tool results and your own words, never from earlier replies. Settings → Models → Conversation ledger."
          >
            {message.ledger}
          </div>
        )}

        {!isStreaming && message.libraryContext && message.libraryContext.length > 0 && (
          <MemoryContextLine
            items={message.libraryContext}
            label={message.libraryMiss ? LIBRARY_MISS_LABEL : LIBRARY_STRIP_LABEL}
            detail={message.libraryMiss ? libraryMissDetail(message.libraryContext.length) : undefined}
            title={
              message.libraryMiss
                ? 'The app searched your local reference library before the model answered. None of the passages it returned is about this question — the retrieval score is relative to the result set, so a weak best match still scores high. They are shown because the model saw them, not because they support the answer.'
                : 'Passages the app retrieved from your local reference library before the model answered — the model saw exactly these, with their citations'
            }
          />
        )}

        {!isStreaming && message.projectContext && message.projectContext.length > 0 && (
          <MemoryContextLine
            items={message.projectContext}
            label="🗂 From this project's other chats:"
            title="Passages the app recalled from other conversations in the same project before the model answered — the model saw exactly these. Turn off per project in its settings."
          />
        )}

        {!isStreaming && message.attachmentContext && message.attachmentContext.length > 0 && (
          <MemoryContextLine
            items={message.attachmentContext}
            label="📄 From the attached document(s):"
            title="The passages of the attached document(s) retrieved for this question — the model saw exactly these"
          />
        )}

        {!isStreaming && message.unverified && (
          <div
            className="mt-2 text-[11px] text-amber-600 dark:text-amber-400"
            title={
              message.offline
                ? 'This looked like a factual question, the app was offline so no web source could be consulted, and the local reference library had nothing on it — the answer comes entirely from the model\'s memory.'
                : "This looked like a factual question, but no web source was consulted — the answer comes entirely from the model's memory, which can invent plausible-sounding names, dates, and numbers."
            }
          >
            {message.offline
              ? '⚠️ Answered from model memory while offline — no web source could be reached and the reference library had nothing on this. Treat names, dates, and numbers as unverified.'
              : '⚠️ Answered from model memory — no sources consulted. Treat names, dates, and numbers as unverified.'}
          </div>
        )}

        {/*
          A reply that ran out of budget ends mid-thought. Without this it is
          indistinguishable from one that simply finished badly, and the user
          has no way to know the cap — not the model — ended it.
        */}
        {!isStreaming && message.truncated && (
          <div
            className="mt-2 text-[11px] text-amber-600 dark:text-amber-400"
            title="The reply reached this role's max tokens and was cut off. Raise it under Settings → Models → Sampling, or ask for the rest."
          >
            ✂️ Cut off at the length cap — this reply is unfinished. Raise max tokens in Settings
            → Models, or ask it to continue.
          </div>
        )}

        {!isStreaming && message.corrected && <RevisedLine message={message} />}

        {!isStreaming && message.grounding && <GroundingWarning report={message.grounding} />}

        {message.secondOpinion && (
          <SecondOpinionBlock opinion={message.secondOpinion} isStreaming={streaming && isLast} />
        )}

        {message.deliberation && (
          <DeliberationLine record={message.deliberation} />
        )}

        {message.claimCheck && (
          <ClaimCheckBlock check={message.claimCheck} isStreaming={streaming && isLast} />
        )}

        {!isStreaming && message.escalation && (
          <button
            type="button"
            disabled={streaming}
            onClick={() => void escalate(message.id)}
            title="Re-run this turn on a bigger slot. The original reply stays; the new answer is appended."
            className="mt-2 rounded-lg border border-black/10 px-2.5 py-1 text-[11px] text-ink-secondary transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/5"
          >
            ↗ Try again on {message.escalation.roleName} —{' '}
            {ESCALATION_REASON_TEXT[message.escalation.reason]}
          </button>
        )}

        {phaseHere && <TurnPhaseLine phase={phaseHere} />}

        {showStats && !isStreaming && message.stats && (
          <div
            className="mt-2 text-[10px] text-ink-tertiary"
            title={
              message.stats.completionTokens
                ? 'Measured from the server’s own token accounting.'
                : 'This server did not report token counts, so only timing is shown.'
            }
          >
            {formatStats(message.stats)}
          </div>
        )}
        </div>
      </div>
    </div>
  )
})
