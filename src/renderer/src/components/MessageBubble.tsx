import { memo, useMemo, useState } from 'react'
import type { ChatMessage, Conversation } from '../types'
import { attributionLabel, composeFailure, readingLine } from '../../../shared/failure'
import { ACCENT } from '../lib/colors'
import { turnCitations } from '../lib/citations'
import { libraryStrip } from '../lib/libraryRecall'
import { fadeStreamEdge, handleCodeBlockClick, renderMarkdown, renderStreamingMarkdown, splitStreamingMarkdown } from '../lib/markdown'
import { speak, stopSpeaking } from '../lib/voice'
import { describeOasisState } from '../lib/oasisRipple'
import { FIRST_BYTE_TIMEOUT_MS, STREAM_STALL_MS } from '../hooks/chatTransport'
import { emptyReplyFailure, regenerateBlocked, replyAffordances } from '../lib/replyRecovery'
import { turnContextUsage } from '../hooks/turnHelpers'
import { formatTurnCost } from '../lib/turnCost'
import { ESCALATION_REASON_TEXT } from '../lib/routing'
import { useAppStore } from '../stores/appStore'
import { useLMStudio } from '../hooks/useLMStudio'
import { ToolCallBlock } from './ToolCallBlock'
import { BlockEnter } from './Disclosure'
import { RanCodeBlock } from './RanCodeBlock'
import { PatchBlock } from './PatchBlock'
import { AgentTurn } from './agent/AgentTurn'
import { ReasoningBlock } from './ReasoningBlock'
import { SecondOpinionBlock } from './SecondOpinionBlock'
import { draftWentUnreviewed, thinkHarderNote } from '../lib/deliberation'
import { ClaimCheckBlock } from './ClaimCheckBlock'
import { PlanBlock } from './PlanBlock'
import { answerRecords, childRecords } from '../hooks/planMode'
import { OasisRipple } from './OasisRipple'
import { SigmaAvatar } from './SigmaAvatar'
import { BranchMenu } from './BranchMenu'
// v4.2 (R3): the self-contained pieces of a reply, moved out verbatim.
import { ToolImageGallery } from './ToolImageGallery'
import { GroundingWarning } from './GroundingWarning'
import { RevisedLine } from './RevisedLine'
import { DeliberationLine } from './DeliberationLine'
import { MemoryContextLine } from './MemoryContextLine'
import { TurnPhaseLine } from './TurnPhaseLine'
import { SlowReadingLine } from './SlowReadingLine'

interface Props {
  message: ChatMessage
  /** True while this message is the one currently streaming. */
  isStreaming: boolean
  /** True for the final message in the conversation (enables Regenerate). */
  isLast: boolean
  /** The conversation this message belongs to — enables v1.4 branching. */
  conversation?: Conversation
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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
  // v4.1 (S3): and its reasoning, on the same terms — committed to the message
  // only at round and stream boundaries (hooks/chatTransport.ts makeTailStream).
  const tailReasoning = useAppStore((s) =>
    s.streamingTail && s.streamingTail.messageId === message.id ? (s.streamingTail.reasoning ?? null) : null
  )
  const tailReasoningMs = useAppStore((s) =>
    s.streamingTail && s.streamingTail.messageId === message.id ? s.streamingTail.reasoningMs : undefined
  )
  const displayReasoning = tailReasoning ?? message.reasoning
  const displayReasoningMs = tailReasoning !== null ? tailReasoningMs : message.reasoningMs

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
    // v4.1 (G3): and the web results and pages the turn numbered with them.
    () => (message.role === 'assistant' ? turnCitations(message.toolCalls ?? []) : []),
    [message.role, message.toolCalls]
  )
  // v1.13.1: the strip lists what the app retrieved before the model spoke;
  // only the finished answer says which of it the answer used. An entry the
  // reply never cited is marked, not dropped — the model did see it.
  //
  // v1.17.2: built from the same records as `citations` above, so the strip and
  // the inline marker binder cannot disagree about which passages exist.
  // `libraryContext` is still the record of the app's own pre-flight lookup,
  // which is the only thing `libraryMiss` is a finding about.
  const strip = useMemo(
    () =>
      message.role === 'assistant'
        ? libraryStrip({
            records: message.toolCalls ?? [],
            answer: message.content,
            miss: message.libraryMiss === true,
            preflight: message.libraryContext?.length ?? 0
          })
        : null,
    [message.role, message.toolCalls, message.content, message.libraryMiss, message.libraryContext]
  )
  const stableHtml = useMemo(
    () => (message.role === 'assistant' && stablePart ? renderMarkdown(stablePart, citations) : ''),
    [message.role, stablePart, citations]
  )
  // Both halves are DOMPurify-sanitized in renderMarkdown; concatenating two
  // sanitized block-level fragments is still sanitized, and fadeStreamEdge
  // only wraps already-sanitized text in a span of our own.
  const html =
    livePart && message.role === 'assistant'
      ? stableHtml + fadeStreamEdge(renderStreamingMarkdown(livePart, citations))
      : stableHtml
  // Declared before the marker/user branches below: hooks must run in the same
  // order on every render, and an early return would skip them. That includes
  // the three settings subscriptions — they were once below the early returns,
  // which made the hook count differ between user and assistant messages.
  const [speaking, setSpeaking] = useState(false)
  const [copied, setCopied] = useState(false)
  // v1.17.2: the provenance strip's open state and the entry a marker asked
  // for. Lifted out of MemoryContextLine because an inline `[7]` in the answer
  // now opens it — a marker whose passage has no web page to link to used to be
  // a `title` attribute and nothing else, which is no affordance at all for a
  // reader who is not holding a mouse over exactly three characters.
  const [stripOpen, setStripOpen] = useState(false)
  const [markerFollowed, setMarkerFollowed] = useState<{ index: number; nonce: number } | null>(null)
  const { regenerate, secondOpinion, escalate, deliberate } = useLMStudio()
  const streaming = useAppStore((s) => s.streaming)
  // The turn's named stage (lib/turnPhase.ts): what the wait is called while
  // it lasts, and — once the checks start — the signal that this message's
  // text is final enough to copy, read aloud or branch.
  const turnPhase = useAppStore((s) => s.turnPhase)
  // What the transport has seen of the request in flight — the two facts the
  // wait line is entitled to speak from. Null for every message but the one
  // streaming, and null while no request is open.
  const streamWitness = useAppStore((s) => s.streamWitness)
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

  /** A citation marker the reader activated: open the strip on that passage. */
  const followMarker = (target: EventTarget): boolean => {
    const marker = (target as HTMLElement).closest?.('[data-citation]')
    if (!marker) return false
    const index = Number(marker.getAttribute('data-citation'))
    if (!Number.isFinite(index)) return false
    setStripOpen(true)
    // The nonce rises on every activation, so activating the same marker twice
    // scrolls back to it rather than doing nothing the second time.
    setMarkerFollowed((m) => ({ index, nonce: (m?.nonce ?? 0) + 1 }))
    return true
  }

  const handleBodyClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (followMarker(event.target)) return
    handleCodeBlockClick(event)
  }

  // The marker span carries role="button" and tabindex, so it has to answer to
  // the keys a button answers to.
  const handleBodyKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    if (followMarker(event.target)) event.preventDefault()
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
        {/* v2.7: a message typed while a turn ran — where it landed, or that it waits. */}
        {message.delivery && (
          <span className="text-[11px] text-ink-tertiary" data-testid="steer-delivery">
            {message.delivery.state === 'queued'
              ? '⏳ queued — handed to the model at its next round'
              : message.delivery.round
                ? `↪ steered in mid-turn, before round ${message.delivery.round + 1}`
                : '↪ steered in after the turn ended — answered next'}
          </span>
        )}
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

  // v3.0: an agent turn is drawn as its timeline (agent/AgentTurn.tsx) —
  // its steps in the order they happened, not text above tools.
  if (message.agent) return <AgentTurn message={message} conversation={conversation} />

  const accent = message.color ? ACCENT[message.color] : null
  const toolCalls = message.toolCalls ?? []
  // The Oasis Ripple is the single thinking indicator: ambient pool while the
  // model composes, droplet + colored wave when a tool fires — regardless of
  // the hideToolCalls setting, since the ripple *is* the disclosure.
  const oasisState = describeOasisState(isStreaming, displayContent, toolCalls)
  // Everything that would count as output arriving. While any of it moves the
  // ripple's silence clock keeps resetting; when it stops, the clock runs and
  // the disc starts saying how long it has been and what it is waiting on.
  const streamActivity = `${displayContent.length}:${(displayReasoning ?? '').length}:${toolCalls
    .map((t) => `${t.id}${t.status}`)
    .join(',')}`
  /**
   * Which of the transport's two deadlines is actually counting down, and what
   * the wait line is allowed to say about the silence.
   *
   * v1.17.4: read from the transport, not inferred from the message. This was
   * `(message.reasoning ?? '') !== '' || toolCalls.length > 0` — a fact about
   * the TURN standing in for a fact about the REQUEST — and after any tool call
   * it stayed true for the rest of the turn. Every later round arms the
   * five-minute first-byte ceiling afresh, so from the first tool call onward
   * the line promised `gives up at 1:00` against a deadline four minutes
   * further out. The transport now publishes what it has actually seen of the
   * request in flight, and this reads it.
   */
  const seen = streamWitness?.messageId === message.id ? streamWitness : null
  const streamStarted = seen?.streamed ?? false
  // The action row follows the ANSWER, not the turn. Verification keeps
  // `streaming` true for seconds after the last token, and none of it can
  // change whether a finished reply may be copied, spoken or branched — so
  // the row opens as soon as the text is complete, and also when the turn
  // ended with nothing at all (lib/replyRecovery.ts). Only the buttons that
  // would START a turn wait, and they say so.
  const phaseHere = turnPhase?.messageId === message.id ? turnPhase : null
  const affordances = replyAffordances(message, isLast, isStreaming, phaseHere)
  const busyTitle = streaming ? '\n\nAvailable once this turn’s checks finish.' : ''
  /**
   * v1.17.3: would asking again send a request the app has already measured as
   * too large? Live, not a snapshot of the failed turn — the reader's remedy is
   * to shrink something, and the button has to notice when they have.
   *
   * Only asked on the last message, which is the only one that renders it.
   */
  // Not while a turn is in flight: the button is already disabled and busy-
  // titled, and this reduces over every message in the conversation on a
  // component that re-renders per streamed frame.
  const cannotRegenerate =
    isLast && !streaming ? regenerateBlocked(turnContextUsage(conversation?.id ?? null)) : null
  /** Who fell silent, when the turn produced nothing at all. */
  const nothingCame = affordances.empty ? emptyReplyFailure(message) : null

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
                disabled={streaming || cannotRegenerate !== null}
                className="rounded px-1.5 py-0.5 hover:bg-black/5 dark:hover:bg-white/10 hover:text-ink-primary disabled:opacity-40"
                // Disabled with its reason attached, never silently: a control
                // that greys out and says nothing is the same dead end as one
                // that replays a failure (lib/replyRecovery.ts).
                title={cannotRegenerate ?? `Re-answer the last message${busyTitle}`}
              >
                ↻ Regenerate
              </button>
            )}
            {/* The reason is on the button's title for the detail, and on
                screen for everything a title does not reach — a screenshot, an
                export, a reader who never hovers. */}
            {cannotRegenerate && (
              <span className="text-ink-warn" title={cannotRegenerate}>
                — this request is over the window
              </span>
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
            {/*
              v1.17.3: the retry the prose already promised.

              The gate was `!message.deliberation` — any record at all removed
              the button — so a pass that FAILED took its own retry away with
              it, while the disclosure beside it said "Run Think harder again,
              or use 2nd opinion." That is round 8's finding in its purest
              form: a remedy in words with no control behind it, and here the
              control existed and was being hidden by the failure it was for.
            */}
            {affordances.onText &&
              (!message.deliberation || draftWentUnreviewed(message.deliberation)) && (
                <button
                  type="button"
                  onClick={() => void deliberate(message.id)}
                  disabled={streaming}
                  className="rounded px-1.5 py-0.5 hover:bg-black/5 dark:hover:bg-white/10 hover:text-ink-primary disabled:opacity-40"
                  title={
                    (message.deliberation
                      ? 'Retry: the last review came back empty, so no reviewer has read this reply. '
                      : '') +
                    'Think harder: have another role review this reply for errors and gaps, then revise it once. The draft and the review stay visible.' +
                    // v1.9.1: on a model that already reasons internally, say what
                    // the reasoning suite measured rather than implying a benefit.
                    (thinkHarderNote(message.modelId ?? '') ? `\n\n${thinkHarderNote(message.modelId ?? '')}` : '') +
                    busyTitle
                  }
                >
                  {message.deliberation ? '🧠 Think harder again' : '🧠 Think harder'}
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
            seen={seen}
          />
        )}

        {message.plan && (
          <PlanBlock messageId={message.id} plan={message.plan} records={toolCalls} />
        )}

        {displayReasoning && reasoningDisplay !== 'hidden' && (
          <ReasoningBlock
            reasoning={displayReasoning}
            reasoningMs={displayReasoningMs}
            isStreaming={isStreaming && displayContent === ''}
            defaultOpen={reasoningDisplay === 'expanded'}
          />
        )}

        {displayContent !== '' && (
          <div
            className="markdown-body oasis-enter text-sm leading-relaxed"
            onClick={handleBodyClick}
            onKeyDown={handleBodyKeyDown}
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

          v1.17.3: and it names the right party. This was one constant sentence
          about "the model" standing over three different events — a model that
          said nothing, a server that hung up without writing, and a turn the
          user stopped after 90 s of silence. The transport records which
          (ChatMessage.ending); shared/failure.ts turns that into the sentence.
        */}
        {!isStreaming && affordances.empty && nothingCame && (
          <div className="text-[11px] text-ink-warn" title={composeFailure(nothingCame)}>
            ⚠️ {nothingCame.sentence}
            {nothingCame.remedy && (
              <span className="text-ink-tertiary"> {nothingCame.remedy.text}</span>
            )}
          </div>
        )}

        {/* Tool-provided pictures are content, not diagnostics — they render
            even when the user hides tool-call blocks. */}
        <ToolImageGallery records={toolCalls} />

        {/*
          A plan step's calls render inside the plan block, under their step.

          Each block grows into place (.block-enter) rather than appearing at
          its full height: these land mid-reply, often several in a row, and
          an instant 60px block shoves everything under it down in one frame.
          The wrapper is keyed on the record, so the animation runs once when
          the call first appears and not again as its status goes
          running → done.
        */}
        {!hideToolCalls &&
          answerRecords(toolCalls).map((record) => (
            <BlockEnter key={record.id}>
              {record.name === 'run_python' || record.name === 'run_code' ? (
                <RanCodeBlock record={record} onCodeBlockClick={handleCodeBlockClick} children={record.name === 'run_code' ? childRecords(toolCalls, record.id) : undefined} />
              ) : record.name === 'propose_patch' ? (
                <PatchBlock record={record} />
              ) : (
                <ToolCallBlock record={record} />
              )}
            </BlockEnter>
          ))}

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

        {/* v2.6: outline-then-fill — the shape the document was written from, section by section. */}
        {message.outline && (
          <div className="mt-1 text-xs text-ink-tertiary" data-testid="outline-block">
            📑 Outlined first: {message.outline.title} —{' '}
            {message.outline.sections.map((s, i) => (
              <span key={i}>
                {i > 0 ? ' · ' : ''}
                {s.heading}
                {s.done ? ` (${s.words} words${s.truncated ? ', cut short' : ''})` : ' (writing…)'}
              </span>
            ))}
          </div>
        )}

        {/* v2.6: the fact ledger — what was handed over, and what this reply changed. */}
        {!isStreaming && message.ledgerContext && message.ledgerContext.hits > 0 && (
          <div className="mt-1 text-xs text-ink-tertiary" data-testid="ledger-context">
            📌 {message.ledgerContext.expired ? 'A claim verified earlier had expired and was re-checked' : `Answered from ${message.ledgerContext.hits} claim${message.ledgerContext.hits === 1 ? '' : 's'} this app verified earlier`}
            {message.ledgerContext.checkedAt ? ` (checked ${message.ledgerContext.checkedAt})` : ''}
          </div>
        )}
        {!isStreaming && message.ledgerUpdate && message.ledgerUpdate.superseded.length > 0 && (
          <div className="mt-1 text-xs text-ink-warn" data-testid="ledger-update">
            {message.ledgerUpdate.superseded.map((s, i) => (
              <div key={i}>⚠️ Changed since it was last verified: was {s.previous}, now {s.next}.</div>
            ))}
          </div>
        )}

        {/*
          v2.3: a pass that did NOT happen goes above every line describing one
          that did.

          Measured (FR3, `.h2h-runs/B10/FR3-20260827-224622`): `⚠️ Not
          deliberated — … the draft was not checked` was the last line of the
          bubble, under `🧮 Recomputed the stated figures in Python`, under
          `Checked against: run_python`. Read downward — which is the only way
          it is read — an unreviewed reply arrived as a checked one, and the
          warning turned up after the reader had already been reassured.

          Rank is not the fix here; round 10 settled that a warning has one ink
          and provenance has another, and promoting these lines to match would
          spend the contrast that distinction runs on. Order is the fix, and it
          is conditional on purpose: a review that DID happen ran after the
          checks and revised the text they read, so its line stays below them.
          A review that did not happen changed nothing, so nothing is misplaced
          by putting it first.
        */}
        {message.deliberation && draftWentUnreviewed(message.deliberation) && (
          <DeliberationLine record={message.deliberation} />
        )}

        {!isStreaming && message.checks && message.checks.length > 0 && (
          <div className="mt-2 space-y-0.5 text-[11px]">
            {message.checks.map((c, i) => (
              <div
                key={i}
                className={c.ok ? 'text-ink-tertiary' : 'text-ink-warn'}
                title="Workbench verification: the app ran Python in the sandbox to check this reply — recomputing its figures, or running the code it contains. Settings → Roles → Workbench checks."
              >
                {c.summary}
                {/* This line used to BE the runtime string — measured,
                    `🧮 Recompute skipped — BodyStreamBuffer was aborted`. The
                    summary is now a reading, and the words the runtime actually
                    used live here, one click away, attributed to it.

                    v2.4: `attributionLabel`, not `attribution`. The colon form
                    is written to be read with the text on the next line, and
                    this is the one caller where that line is folded away — so
                    the default view read `The runtime reported:` and stopped,
                    a label introducing nothing. A `<summary>` names what is
                    inside it; it does not introduce it. */}
                {c.detail && (
                  <details className="mt-0.5">
                    <summary className="cursor-pointer text-ink-tertiary">
                      {attributionLabel(c.detail)}
                    </summary>
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-black/5 p-1.5 font-mono text-ink-secondary dark:bg-white/5">
                      {c.detail.text}
                    </pre>
                    {/* v2.5: and what those words mean. This is the surface
                        round 13's critic opened, and the ONE that renders a
                        `detail` with no sentence anywhere near it — the banner
                        keeps `headline` and `detail` and drops `sentence`, so
                        opening the disclosure used to buy the reader a fetch's
                        name for its own response buffer and nothing else.

                        Outside the `<pre>` and in the app's ordinary ink, so
                        the quote stays visibly the quote: the monospace block
                        is what the runtime said, this line is what the app made
                        of it, and `readingLine` names whose wording is being
                        read so the summary's promise still holds over both. */}
                    {readingLine(c.detail) && (
                      <p className="mt-1 text-ink-tertiary">{readingLine(c.detail)}</p>
                    )}
                  </details>
                )}
              </div>
            ))}
          </div>
        )}

        {!isStreaming && message.playbook && (
          <div
            className="mt-2 text-[11px] text-ink-tertiary"
            title="The app added a short numbered method for this kind of question to the turn — the model was asked to follow it. Settings → Roles → Playbooks."
          >
            📋 Method: {message.playbook} playbook
          </div>
        )}

        {!isStreaming && message.skill && (
          <div
            className="mt-2 text-[11px] text-ink-tertiary"
            title="One of your installed skills matched a trigger phrase in your message; its method was handed to the model in place of the built-in playbook. Settings → Skills."
            data-testid="skill-applied"
          >
            🧩 Skill: {message.skill}
          </div>
        )}

        {!isStreaming && message.rulesApplied && (
          <div
            className="mt-2 text-[11px] text-ink-tertiary"
            title="This role has standing rules (Settings → Roles) — they were part of its system prompt for this turn, after its persona and before any project instructions."
            data-testid="rules-applied"
          >
            📐 Standing rules applied
          </div>
        )}

        {!isStreaming && message.ledger && (
          <div
            className="mt-2 text-[11px] text-ink-tertiary"
            title="The app handed the model a mechanical record of what this conversation has established — computed figures, files, session variables, your stated constraints — built from tool results and your own words, never from earlier replies. It is the record as this turn began, because it had to be written before the model answered: a call in this reply that defines a new Python variable is not in these counts, which is why the “Session variables” list above can be longer. It joins the ledger for the next turn. Settings → Roles → Conversation ledger."
          >
            {message.ledger}
          </div>
        )}

        {!isStreaming && strip && (
          <MemoryContextLine
            items={strip.items}
            groups={strip.groups}
            label={strip.label}
            detail={strip.detail}
            note={strip.note}
            title={strip.title}
            open={stripOpen}
            onOpenChange={setStripOpen}
            highlight={markerFollowed}
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
            className="mt-2 text-[11px] text-ink-warn"
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
            className="mt-2 text-[11px] text-ink-warn"
            title="The reply reached this role's max tokens and was cut off. Raise it under Settings → Roles › Sampling, or ask for the rest."
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

        {/* The other half of the rule above: a pass that reviewed the draft,
            or is reviewing it now, is provenance and belongs down here with
            the rest of it. `draftWentUnreviewed` is false while the pass is
            still running, so the live line does not jump on its way to a
            verdict — only a settled failure moves. */}
        {message.deliberation && !draftWentUnreviewed(message.deliberation) && (
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
              (message.stats.completionTokens
                ? 'Measured from the server’s own token accounting. '
                : 'This server did not report token counts, so only timing is shown. ') +
              '“Gathering” is what the app did before the model was asked — its own web search, the reference library, the playbook; “answer” is the token stream, and “to first token” is measured from the start of it, not from your send; “checking” is the verification that ran after it, with the composer still held; “total” is the whole turn, which is what you waited, and the three add up to it.'
            }
          >
            {formatTurnCost(message.stats)}
          </div>
        )}

        {!isStreaming && <SlowReadingLine stats={message.stats} modelId={message.modelId} />}
        </div>
      </div>
    </div>
  )
})
