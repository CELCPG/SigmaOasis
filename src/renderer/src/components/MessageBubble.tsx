import { useMemo, useState } from 'react'
import type { ChatMessage } from '../types'
import { ACCENT } from '../lib/colors'
import { renderMarkdown } from '../lib/markdown'
import { speak, stopSpeaking } from '../lib/voice'
import { describeOasisState } from '../lib/oasisRipple'
import { useAppStore } from '../stores/appStore'
import { useLMStudio } from '../hooks/useLMStudio'
import { ToolCallBlock } from './ToolCallBlock'
import { ReasoningBlock } from './ReasoningBlock'
import { SecondOpinionBlock } from './SecondOpinionBlock'
import { PlanBlock } from './PlanBlock'
import { OasisRipple } from './OasisRipple'
import { SigmaAvatar } from './SigmaAvatar'

interface Props {
  message: ChatMessage
  /** True while this message is the one currently streaming. */
  isStreaming: boolean
  /** True for the final message in the conversation (enables Regenerate). */
  isLast: boolean
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

export function MessageBubble({ message, isStreaming, isLast }: Props): JSX.Element {
  const html = useMemo(
    () => (message.role === 'assistant' ? renderMarkdown(message.content) : ''),
    [message.role, message.content]
  )
  // Declared before the user-message branch below: hooks must run in the same
  // order on every render, and an early return would skip this one.
  const [speaking, setSpeaking] = useState(false)
  const [copied, setCopied] = useState(false)
  const { regenerate, secondOpinion } = useLMStudio()
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

        {!hideToolCalls &&
          toolCalls.map((record) => <ToolCallBlock key={record.id} record={record} />)}

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

        {message.secondOpinion && (
          <SecondOpinionBlock opinion={message.secondOpinion} isStreaming={streaming && isLast} />
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
