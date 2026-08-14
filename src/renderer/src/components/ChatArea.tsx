import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { stopSpeaking } from '../lib/voice'
import type { Conversation } from '../types'
import { MessageBubble } from './MessageBubble'
import { EmptyState } from './EmptyState'

/** Distance from the bottom (px) within which the scroll is still "pinned". */
const PIN_THRESHOLD_PX = 80

/**
 * Scrollable message list for the active conversation, with pin-to-bottom
 * auto-scroll.
 *
 * Three rules keep generation clean:
 * 1. Streaming growth scrolls INSTANTLY — a smooth animation restarted on
 *    every token never catches up with the content and reads as the text
 *    sliding away under the composer.
 * 2. Auto-scroll only while pinned. Scrolling up to read history unpins; the
 *    stream no longer yanks the view back down. Scrolling back near the
 *    bottom (or sending a message) re-pins.
 * 3. Generous bottom padding (pb-8) means the newest line comes to rest
 *    visibly above the input box instead of flush against it.
 */
export function ChatArea({ conversation }: { conversation: Conversation }): JSX.Element {
  const streaming = useAppStore((s) => s.streaming)
  const researchProgress = useAppStore((s) => s.researchProgress)
  const compacting = useAppStore((s) => s.compacting)
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const [pinned, setPinned] = useState(true)

  const lastMessage = conversation.messages[conversation.messages.length - 1]
  const lastContentLength = lastMessage?.content.length ?? 0
  const lastToolCount = lastMessage?.toolCalls?.length ?? 0

  // Stop any read-aloud from the previous conversation.
  useEffect(() => {
    stopSpeaking()
  }, [conversation.id])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const isPinned = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX
    pinnedRef.current = isPinned
    setPinned(isPinned)
  }

  const scrollToBottom = (smooth: boolean): void => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = true
    setPinned(true)
    // scrollTop on the container itself — scrollIntoView would also scroll any
    // scrollable ancestor, which is how the whole column can drift.
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }

  // A new conversation or a new message re-pins and glides to the bottom —
  // sending a message always means "take me to the reply".
  useEffect(() => {
    pinnedRef.current = true
    setPinned(true)
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [conversation.id, conversation.messages.length])

  // Streaming growth (tokens, tool calls, status lines): keep the bottom in
  // view instantly, and only while the user is pinned.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !pinnedRef.current) return
    el.scrollTop = el.scrollHeight
  }, [lastContentLength, lastToolCount, compacting, researchProgress?.detail])

  // Streamed tokens land in the streamingTail slice, which this component
  // deliberately does not subscribe to via a selector — that would re-render
  // the whole list per flush. A plain store subscription scrolls without
  // rendering; the layout read happens only while pinned and streaming.
  useEffect(() => {
    let lastLength = -1
    return useAppStore.subscribe((s) => {
      const length = s.streamingTail ? s.streamingTail.text.length : -1
      if (length === lastLength) return
      lastLength = length
      const el = scrollRef.current
      if (length < 0 || !el || !pinnedRef.current) return
      el.scrollTop = el.scrollHeight
    })
  }, [])

  if (conversation.messages.length === 0) {
    return (
      <EmptyState
        heading="Start a conversation"
        onPick={(prompt) => useAppStore.getState().setComposerPrefill(prompt)}
      />
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto pb-8 pt-4"
      >
        {conversation.ephemeral && (
          <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 rounded-2xl border border-violet-400/25 bg-violet-400/10 px-4 py-2 text-[11px] text-violet-600 dark:text-violet-300">
            <span>◌</span>
            <span>
              Ephemeral chat — nothing here is written to disk, and it disappears when you close it
              or quit. Notes or memories you explicitly save are still saved.
            </span>
          </div>
        )}
        {conversation.messages.map((m, idx) => (
          <MessageBubble
            key={m.id}
            message={m}
            isStreaming={streaming && idx === conversation.messages.length - 1 && m.role === 'assistant'}
            isLast={idx === conversation.messages.length - 1 && m.role === 'assistant'}
            conversation={conversation}
          />
        ))}
        {compacting && (
          <div
            className="mx-auto flex max-w-3xl items-center gap-2.5 px-4 py-2 text-xs"
            style={{ color: 'var(--accent-ink)' }}
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent shadow-[0_0_8px_rgba(0,212,170,0.8)]" />
            <span className="font-medium tracking-[0.08em]">Compacting earlier messages…</span>
            <span className="min-w-0 truncate text-neutral-400">
              summarizing what no longer fits the context window
            </span>
          </div>
        )}
        {streaming && researchProgress && (
          <div className="mx-auto flex max-w-3xl items-center gap-2.5 px-4 py-2 text-xs" style={{ color: 'var(--accent-ink)' }}>
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent shadow-[0_0_8px_rgba(0,212,170,0.8)]" />
            <span className="font-medium capitalize tracking-[0.08em]">{researchProgress.phase}</span>
            <span className="min-w-0 truncate text-neutral-400">{researchProgress.detail}</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {!pinned && (
        <button
          type="button"
          onClick={() => scrollToBottom(true)}
          className="glass-panel absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full px-3.5 py-1.5 text-xs text-ink-secondary shadow-lg transition-colors hover:text-ink-primary"
          title="Jump to the latest message"
        >
          ↓ {streaming ? 'New messages' : 'Back to bottom'}
        </button>
      )}
    </div>
  )
}
