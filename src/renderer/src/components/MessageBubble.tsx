import { useMemo, useState } from 'react'
import type { ChatMessage } from '../types'
import { ACCENT } from '../lib/colors'
import { renderMarkdown } from '../lib/markdown'
import { speak, stopSpeaking } from '../lib/voice'
import { useAppStore } from '../stores/appStore'
import { ToolCallBlock } from './ToolCallBlock'

interface Props {
  message: ChatMessage
  /** True while this message is the one currently streaming. */
  isStreaming: boolean
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

export function MessageBubble({ message, isStreaming }: Props): JSX.Element {
  const html = useMemo(
    () => (message.role === 'assistant' ? renderMarkdown(message.content) : ''),
    [message.role, message.content]
  )
  // Declared before the user-message branch below: hooks must run in the same
  // order on every render, and an early return would skip this one.
  const [speaking, setSpeaking] = useState(false)

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
          <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-accent/15 px-4 py-2.5 text-sm">
            {message.content}
          </div>
        )}
      </div>
    )
  }

  const accent = message.color ? ACCENT[message.color] : null
  const showTyping = isStreaming && message.content === '' && (message.toolCalls?.length ?? 0) === 0

  const toggleSpeak = (): void => {
    if (speaking) {
      stopSpeaking()
      setSpeaking(false)
      return
    }
    const voice = useAppStore.getState().settings?.voice
    speak(message.content, voice?.voiceURI ?? '', voice?.rate ?? 1, () => setSpeaking(false))
    setSpeaking(true)
  }

  return (
    <div className="px-4 py-2">
      <div className="mx-auto max-w-3xl">
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
            {!isStreaming && message.content && (
              <button
                type="button"
                onClick={toggleSpeak}
                className="ml-auto rounded px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10 hover:text-neutral-600 dark:hover:text-neutral-300"
                title={speaking ? 'Stop reading' : 'Read aloud'}
              >
                {speaking ? '⏹ Stop' : '🔊 Listen'}
              </button>
            )}
          </div>
        )}

        {showTyping ? (
          <div className="typing-indicator flex gap-1 py-2">
            <span />
            <span />
            <span />
          </div>
        ) : (
          <div
            className="markdown-body text-sm leading-relaxed"
            onClick={handleCopyClick}
            // Sanitized by DOMPurify in renderMarkdown.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}

        {message.toolCalls?.map((record) => <ToolCallBlock key={record.id} record={record} />)}
      </div>
    </div>
  )
}
