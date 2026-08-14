import { useMemo, useState } from 'react'
import type { ChatMessage, Conversation, GroundingReport, ToolCallRecord } from '../types'
import { groundingFindingCount } from '../lib/toolGrounding'
import { ACCENT } from '../lib/colors'
import { renderMarkdown } from '../lib/markdown'
import { speak, stopSpeaking } from '../lib/voice'
import { describeOasisState } from '../lib/oasisRipple'
import { ESCALATION_REASON_TEXT } from '../lib/routing'
import { useAppStore } from '../stores/appStore'
import { useLMStudio } from '../hooks/useLMStudio'
import { ToolCallBlock } from './ToolCallBlock'
import { ReasoningBlock } from './ReasoningBlock'
import { SecondOpinionBlock } from './SecondOpinionBlock'
import { ClaimCheckBlock } from './ClaimCheckBlock'
import { PlanBlock } from './PlanBlock'
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

function handleCopyClick(event: React.MouseEvent<HTMLDivElement>): void {
  const button = (event.target as HTMLElement).closest('.code-copy-btn')
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
      {withImages.map((record) => (
        <div key={`${record.id}-images`} className="mt-2">
          <div className="grid grid-cols-3 gap-2">
            {record.images!.map((img, i) => (
              <a
                key={i}
                href={img.pageUrl}
                target="_blank"
                rel="noreferrer"
                title={`${img.title}\n${img.pageUrl}`}
                className="block overflow-hidden rounded-xl border border-black/10 transition-transform hover:scale-[1.02] dark:border-white/15"
              >
                <img
                  src={img.dataUrl}
                  alt={img.title}
                  loading="lazy"
                  className="h-24 w-full object-cover"
                />
              </a>
            ))}
          </div>
          <div className="mt-1 text-[10px] text-neutral-400">
            🖼️ {record.images!.length} image(s) for “{String(record.args.query ?? '')}” — click a
            thumbnail to open its source page.
          </div>
        </div>
      ))}
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
  const origins = report.origins ?? []
  const contacts = report.contacts ?? []
  const addresses = report.addresses ?? []
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
        Called out separately from figures and links because it is a different
        kind of wrong: not an unsupported number but a contradicted fact, and
        the one most likely to be repeated out loud to someone else.
      */}
      {origins.length > 0 && (
        <div className={parts.length > 0 ? 'mt-1' : undefined}>
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
        <div className={parts.length > 0 || origins.length > 0 ? 'mt-1' : undefined}>
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
 * v0.9 visible recall: which long-term memory chunks were injected into the
 * system prompt for this reply. The display is mechanical — the app shows
 * what it actually sent, it does not ask the model to footnote itself.
 */
function MemoryContextLine({ items }: { items: NonNullable<ChatMessage['memoryContext']> }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-2 text-[11px] text-neutral-400">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded px-1.5 py-0.5 hover:bg-black/5 dark:hover:bg-white/10 hover:text-neutral-600 dark:hover:text-neutral-300"
        title="The long-term memory chunks the model was reminded of before answering"
      >
        📚 From memory:{' '}
        {items.map((i) => `${i.source} (${i.score.toFixed(2)})`).join(', ')}{' '}
        <span>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="mt-1 space-y-1.5 rounded-xl border border-black/10 dark:border-white/10 bg-black/[0.03] dark:bg-white/[0.03] p-2.5">
          {items.map((i, idx) => (
            <div key={idx}>
              <span className="font-medium text-neutral-500">
                {i.source} · relevance {i.score.toFixed(2)}
              </span>
              <p className="whitespace-pre-wrap text-neutral-500">{i.text}</p>
            </div>
          ))}
        </div>
      )}
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

export function MessageBubble({
  message,
  isStreaming,
  isLast,
  conversation
}: Props): JSX.Element {
  const html = useMemo(
    () => (message.role === 'assistant' ? renderMarkdown(message.content) : ''),
    [message.role, message.content]
  )
  // Declared before the user-message branch below: hooks must run in the same
  // order on every render, and an early return would skip this one.
  const [speaking, setSpeaking] = useState(false)
  const [copied, setCopied] = useState(false)
  const { regenerate, secondOpinion, escalate } = useLMStudio()
  const streaming = useAppStore((s) => s.streaming)
  const secondOpinionEnabled = useAppStore((s) => s.settings?.secondOpinion.enabled) ?? false

  const copyMessage = (): void => {
    void navigator.clipboard.writeText(message.content).then(() => {
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
          <span className="text-[11px] text-neutral-400">{message.content}</span>
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
            title={a.name}
          >
            📄 {a.name}
          </span>
        ))}
        {message.content && (
          <div className="oasis-enter max-w-[80%] whitespace-pre-wrap rounded-3xl rounded-br-md px-4 py-2.5 text-sm border border-[rgba(0,212,170,0.18)] bg-[rgba(0,212,170,0.12)] backdrop-blur-xl">
            {message.content}
          </div>
        )}
        <span
          className="text-[10px] text-neutral-400"
          title={new Date(message.createdAt).toLocaleString()}
        >
          {formatTime(message.createdAt)}
        </span>
      </div>
    )
  }

  const accent = message.color ? ACCENT[message.color] : null
  const hideToolCalls = useAppStore((s) => s.settings?.hideToolCalls) ?? false
  const reasoningDisplay = useAppStore((s) => s.settings?.reasoningDisplay) ?? 'collapsed'
  const showStats = useAppStore((s) => s.settings?.showResponseStats) ?? true
  const toolCalls = message.toolCalls ?? []
  // The Oasis Ripple is the single thinking indicator: ambient pool while the
  // model composes, droplet + colored wave when a tool fires — regardless of
  // the hideToolCalls setting, since the ripple *is* the disclosure.
  const oasisState = describeOasisState(isStreaming, message.content, toolCalls)

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
        <SigmaAvatar size={32} />
        <div className="glass-panel min-w-0 flex-1 rounded-3xl rounded-tl-md px-4 py-3">
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
            <span className="font-mono text-xs text-neutral-400">{message.modelId}</span>
          </div>
        )}

        {!isStreaming && message.content && (
          <div className="mb-1 flex items-center gap-1 text-xs text-neutral-400">
            <button
              type="button"
              onClick={copyMessage}
              className="rounded px-1.5 py-0.5 hover:bg-black/5 dark:hover:bg-white/10 hover:text-neutral-600 dark:hover:text-neutral-300"
              title="Copy message"
            >
              {copied ? '✓ Copied' : '📋 Copy'}
            </button>
            <button
              type="button"
              onClick={toggleSpeak}
              className="rounded px-1.5 py-0.5 hover:bg-black/5 dark:hover:bg-white/10 hover:text-neutral-600 dark:hover:text-neutral-300"
              title={speaking ? 'Stop reading' : 'Read aloud'}
            >
              {speaking ? '⏹ Stop' : '🔊 Listen'}
            </button>
            {isLast && !streaming && (
              <button
                type="button"
                onClick={() => void regenerate()}
                className="rounded px-1.5 py-0.5 hover:bg-black/5 dark:hover:bg-white/10 hover:text-neutral-600 dark:hover:text-neutral-300"
                title="Re-answer the last message"
              >
                ↻ Regenerate
              </button>
            )}
            {secondOpinionEnabled && !isStreaming && !message.secondOpinion && (
              <button
                type="button"
                onClick={() => void secondOpinion(message.id)}
                disabled={streaming}
                className="rounded px-1.5 py-0.5 hover:bg-black/5 dark:hover:bg-white/10 hover:text-violet-600 dark:hover:text-violet-300 disabled:opacity-40"
                title="Have a different role review this reply and name the claims it could not verify"
              >
                🔍 2nd opinion
              </button>
            )}
            {!isStreaming && conversation && (
              <BranchMenu message={message} conversation={conversation} />
            )}
            <span
              className="ml-auto px-1.5 text-[10px]"
              title={new Date(message.createdAt).toLocaleString()}
            >
              {formatTime(message.createdAt)}
            </span>
          </div>
        )}

        {oasisState.mode !== 'hidden' && <OasisRipple state={oasisState} />}

        {message.plan && <PlanBlock messageId={message.id} plan={message.plan} />}

        {message.reasoning && reasoningDisplay !== 'hidden' && (
          <ReasoningBlock
            reasoning={message.reasoning}
            reasoningMs={message.reasoningMs}
            isStreaming={isStreaming && message.content === ''}
            defaultOpen={reasoningDisplay === 'expanded'}
          />
        )}

        {message.content !== '' && (
          <div
            className="markdown-body oasis-enter text-sm leading-relaxed"
            onClick={handleCopyClick}
            // Sanitized by DOMPurify in renderMarkdown.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}

        {/* Tool-provided pictures are content, not diagnostics — they render
            even when the user hides tool-call blocks. */}
        <ToolImageGallery records={toolCalls} />

        {!hideToolCalls &&
          toolCalls.map((record) => <ToolCallBlock key={record.id} record={record} />)}

        {message.routingNote && (
          <div
            className="mt-2 text-[11px] text-gray-500 dark:text-gray-400"
            title="The pre-flight router sent this message to a specialty slot based on its content. @mention a role name to override routing."
          >
            🔀 {message.routingNote} — override with @RoleName
          </div>
        )}

        {!isStreaming && message.memoryContext && message.memoryContext.length > 0 && (
          <MemoryContextLine items={message.memoryContext} />
        )}

        {!isStreaming && message.unverified && (
          <div
            className="mt-2 text-[11px] text-amber-600 dark:text-amber-400"
            title="This looked like a factual question, but no web source was consulted — the answer comes entirely from the model's memory, which can invent plausible-sounding names, dates, and numbers."
          >
            ⚠️ Answered from model memory — no sources consulted. Treat names, dates, and
            numbers as unverified.
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

        {/*
          The answer on screen is not the one the model first produced. Saying
          so is not optional: a correction the user cannot see is the app
          quietly editing the record, which is exactly what every other check
          here exists to prevent.
        */}
        {!isStreaming && message.corrected && (
          <div
            className="mt-2 text-[11px] text-emerald-700 dark:text-emerald-400"
            title={
              'A mechanical check found specifics the turn\'s tools did not support, and the ' +
              'model was asked to verify or remove them. What you are reading is the revision.'
            }
          >
            ✎ Revised: {groundingFindingCount(message.corrected.before)} unsupported item
            {groundingFindingCount(message.corrected.before) === 1 ? '' : 's'} were sent back for
            verification or removal.
          </div>
        )}

        {!isStreaming && message.grounding && <GroundingWarning report={message.grounding} />}

        {message.secondOpinion && (
          <SecondOpinionBlock opinion={message.secondOpinion} isStreaming={streaming && isLast} />
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
            className="mt-2 rounded-lg border border-black/10 px-2.5 py-1 text-[11px] text-neutral-600 transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5"
          >
            ↗ Try again on {message.escalation.roleName} —{' '}
            {ESCALATION_REASON_TEXT[message.escalation.reason]}
          </button>
        )}

        {showStats && !isStreaming && message.stats && (
          <div
            className="mt-2 text-[10px] text-neutral-400"
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
}
