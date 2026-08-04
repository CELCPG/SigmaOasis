import { useMemo, useState } from 'react'
import type { ChatMessage, Conversation } from '../types'
import { ACCENT } from '../lib/colors'
import { renderMarkdown } from '../lib/markdown'
import { speak, stopSpeaking } from '../lib/voice'
import { describeOasisState } from '../lib/oasisRipple'
import { useAppStore } from '../stores/appStore'
import { useLMStudio } from '../hooks/useLMStudio'
import { useConversations } from '../hooks/useConversations'
import { ToolCallBlock } from './ToolCallBlock'
import { OasisRipple } from './OasisRipple'
import { SigmaAvatar } from './SigmaAvatar'
import { BranchMenu } from './BranchMenu'

interface Props {
  message: ChatMessage
  /** True while this message is the one currently streaming. */
  isStreaming: boolean
  /** True for the final message in the conversation (enables Regenerate). */
  isLast: boolean
  /** The current conversation (for branching support) */
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

export function MessageBubble({ message, isStreaming, isLast, conversation }: Props): JSX.Element {
  const html = useMemo(
    () => (message.role === 'assistant' ? renderMarkdown(message.content) : ''),
    [message.role, message.content]
  )
  // Declared before the user-message branch below: hooks must run in the same
  // order on every render, and an early return would skip this one.
  const [speaking, setSpeaking] = useState(false)
  const [copied, setCopied] = useState(false)
  const regenerate = useLMStudio().regenerate
  const streaming = useAppStore((s) => s.streaming)
  const conversations = useAppStore((s) => s.conversations)
  const activeConversationId = useAppStore((s) => s.activeConversationId)
  const activeConvo = conversations.find(c => c.id === activeConversationId)

  const copyMessage = (): void => {
    void navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
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
            <span
              className="ml-auto px-1.5 text-[10px]"
              title={new Date(message.createdAt).toLocaleString()}
            >
              {formatTime(message.createdAt)}
            </span>
          </div>
        )}

        {oasisState.mode !== 'hidden' && <OasisRipple state={oasisState} />}

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
        
        {/* Branch menu for assistant messages */}
        {message.role === 'assistant' && conversation && (
          <BranchMenu message={message} conversation={conversation} />
        )}
      </div>
    </div>
  )
}
