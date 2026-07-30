import { useEffect, useRef } from 'react'
import { useAppStore } from '../stores/appStore'
import { stopSpeaking } from '../lib/voice'
import type { Conversation } from '../types'
import { MessageBubble } from './MessageBubble'
import { Logo } from './Logo'

/** Scrollable message list for the active conversation, with auto-scroll. */
export function ChatArea({ conversation }: { conversation: Conversation }): JSX.Element {
  const streaming = useAppStore((s) => s.streaming)
  const researchProgress = useAppStore((s) => s.researchProgress)
  const compacting = useAppStore((s) => s.compacting)
  const bottomRef = useRef<HTMLDivElement>(null)

  const lastMessage = conversation.messages[conversation.messages.length - 1]
  const lastContentLength = lastMessage?.content.length ?? 0
  const lastToolCount = lastMessage?.toolCalls?.length ?? 0

  // Stop any read-aloud from the previous conversation.
  useEffect(() => {
    stopSpeaking()
  }, [conversation.id])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [conversation.id, conversation.messages.length, lastContentLength, lastToolCount])

  if (conversation.messages.length === 0) {
    const suggestions = [
      'Explain a concept I can double-check against local files',
      'Summarize the document I drag in here',
      'Help me debug an error message',
      'Draft an email in my voice'
    ]
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-md text-center text-sm text-neutral-500">
          <p className="mb-2 flex justify-center"><Logo size={44} /></p>
          <p className="font-medium text-neutral-700 dark:text-neutral-300">
            Start a conversation
          </p>
          <p className="mt-2">
            Everything runs locally through LM Studio — no cloud, no telemetry. Route with{' '}
            <code>@RoleName</code>, drop files to attach, or hold 🎙️ to talk.
          </p>
          <div className="mt-5 grid grid-cols-2 gap-2">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => useAppStore.getState().setComposerPrefill(s)}
                className="glass-panel glass-panel--hover rounded-2xl px-3 py-2.5 text-left text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto py-4">
      {conversation.messages.map((m, idx) => (
        <MessageBubble
          key={m.id}
          message={m}
          isStreaming={streaming && idx === conversation.messages.length - 1 && m.role === 'assistant'}
          isLast={idx === conversation.messages.length - 1 && m.role === 'assistant'}
        />
      ))}
      {compacting && (
        <div
          className="mx-auto flex max-w-3xl items-center gap-2.5 px-4 py-2 text-xs"
          style={{ color: 'var(--accent-teal-glow)' }}
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent shadow-[0_0_8px_rgba(0,212,170,0.8)]" />
          <span className="font-medium tracking-[0.08em]">Compacting earlier messages…</span>
          <span className="min-w-0 truncate text-neutral-400">
            summarizing what no longer fits the context window
          </span>
        </div>
      )}
      {streaming && researchProgress && (
        <div className="mx-auto flex max-w-3xl items-center gap-2.5 px-4 py-2 text-xs" style={{ color: 'var(--accent-teal-glow)' }}>
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent shadow-[0_0_8px_rgba(0,212,170,0.8)]" />
          <span className="font-medium capitalize tracking-[0.08em]">{researchProgress.phase}</span>
          <span className="min-w-0 truncate text-neutral-400">{researchProgress.detail}</span>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  )
}
