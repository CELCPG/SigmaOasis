import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../stores/appStore'
import { useLMStudio } from '../../hooks/useLMStudio'
import { useConversations } from '../../hooks/useConversations'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { modalSurfaceOpen } from '../../hooks/useModalSurface'
import { setVibeMode } from '../../hooks/vibeMode'
import { fadeStreamEdge, renderMarkdown, splitStreamingMarkdown } from '../../lib/markdown'
import { stripCitationMarkers, vibeLines, vibePhase, type VibeLine, type VibePhase } from '../../lib/vibe'
import type { PendingPatch } from '../../types'
import { handleCodeBlockClick } from '../MessageBubble'
import { DiffView } from '../PatchBlock'
import { LagoonCanvas } from './LagoonCanvas'

/**
 * VIBE (v3.0): the window is the conversation and nothing else.
 *
 * Everything the full view draws around a reply — role badges, tool-call
 * blocks, the ripple's status labels, provenance strips, check lines, stats,
 * the action row, the rail, the chat panel — is simply not rendered here. The
 * turn underneath is the same turn (hooks/useLMStudio.ts, unchanged but for
 * the brevity note in lib/vibe.ts), so leaving VIBE shows every one of those
 * things on the very messages written in it.
 *
 * Two things are never hidden, because hiding them would trade calm for
 * safety: a change to a file waits for the reader here as it would anywhere
 * (a quiet card with Apply and Discard), and a turn that ends with nothing
 * says why in one sentence rather than leaving a blank.
 *
 * The root carries `dark` so every token inside resolves to the night palette
 * whatever the app's theme is — the lagoon is always at night.
 */

/** Pin-to-bottom within this distance of the end, as the full view does. */
const PIN_THRESHOLD_PX = 96

/** Slow motes of light rising through the water — fixed, so they never jump on re-render. */
const MOTES = Array.from({ length: 14 }, (_, i) => ({
  left: (i * 37 + 11) % 100,
  size: 2 + ((i * 7) % 3),
  duration: 26 + ((i * 13) % 22),
  delay: -((i * 5.3) % 30),
  sway: ((i % 2 === 0 ? 1 : -1) * (10 + ((i * 11) % 30))).toString() + 'px'
}))

export function VibeView(): JSX.Element {
  const conversation = useAppStore((s) => s.conversations.find((c) => c.id === s.activeConversationId))
  const streaming = useAppStore((s) => s.streaming)
  const connection = useAppStore((s) => s.connection)
  const pendingPatches = useAppStore((s) => s.pendingPatches)
  const { sendMessage, stopStreaming } = useLMStudio()
  const { createConversation } = useConversations()
  const reducedMotion = useReducedMotion()

  const messages = useMemo(() => conversation?.messages ?? [], [conversation?.messages])
  const last = messages[messages.length - 1]
  // The same reading the full view makes (ChatArea): the turn in flight is the
  // active conversation's last assistant message.
  const streamingId = streaming && last?.role === 'assistant' ? last.id : null
  // A boolean, not the text: the view only needs to know that words have
  // surfaced. The words themselves re-render the one live reply (VibeReply),
  // never this whole view per token.
  const surfaced = useAppStore((s) =>
    Boolean(streamingId && s.streamingTail?.messageId === streamingId && s.streamingTail.text.trim())
  )
  const phase = vibePhase(streaming, surfaced || Boolean(streamingId && last?.content.trim()))
  const lines = useMemo(() => vibeLines(messages, streamingId), [messages, streamingId])

  // Escape leaves — unless a covering surface is open, which owns Escape.
  // Capture phase, so this reads the stack before that surface closes itself
  // and one key press does not end both.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented || modalSurfaceOpen()) return
      e.preventDefault()
      setVibeMode(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Pin-to-bottom: a new line or new words keep the newest text in view while
  // the reader is at the end; scrolling up to reread releases it.
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const onScroll = (): void => {
    const el = scrollRef.current
    if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX
  }
  useEffect(() => {
    pinnedRef.current = true
  }, [conversation?.id, lines.length])
  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTo({ top: el.scrollHeight, behavior: reducedMotion ? 'auto' : 'smooth' })
  }, [lines.length, phase, reducedMotion])
  // The streaming tail grows below the fold between those changes; follow it
  // once per frame from a plain store subscription, as ChatArea does.
  useEffect(() => {
    let raf = 0
    const follow = (): void => {
      raf = 0
      const el = scrollRef.current
      if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
    }
    const unsubscribe = useAppStore.subscribe((s, prev) => {
      if (s.streamingTail !== prev.streamingTail && !raf) raf = requestAnimationFrame(follow)
    })
    return () => {
      unsubscribe()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  const removePatchReview = useAppStore((s) => s.removePatchReview)
  return (
    <VibeScene
      lines={lines}
      phase={phase}
      streaming={streaming}
      streamingId={streamingId}
      offline={connection === 'offline'}
      ephemeral={conversation?.ephemeral === true}
      pendingPatches={pendingPatches}
      reducedMotion={reducedMotion}
      scrollRef={scrollRef}
      onScroll={onScroll}
      onSend={(text) => void sendMessage(text)}
      onStop={stopStreaming}
      onNewChat={() => createConversation()}
      onLeave={() => setVibeMode(false)}
      onDecide={(reviewId, approved) => {
        void window.api.patchDecide(reviewId, approved)
        removePatchReview(reviewId)
      }}
    />
  )
}

export interface VibeSceneProps {
  lines: VibeLine[]
  phase: VibePhase
  streaming: boolean
  streamingId: string | null
  offline: boolean
  /** The chat lives only in RAM (v0.9). VIBE draws no banner, so it says so in the footer. */
  ephemeral: boolean
  pendingPatches: PendingPatch[]
  reducedMotion: boolean
  scrollRef?: React.RefObject<HTMLDivElement>
  onScroll?: () => void
  onSend: (text: string) => void
  onStop: () => void
  onNewChat: () => void
  onLeave: () => void
  onDecide: (reviewId: string, approved: boolean) => void
}

/**
 * The whole of VIBE's markup, from props — the store and the engine stay in
 * VibeView above, so this renders in plain Node (test/vibe.test.ts), the way
 * OasisRippleView and PlanBlockView do. It is handed lines of text and
 * nothing else, which is the structural half of "nothing but the
 * conversation": there is no tool record here to draw.
 */
export function VibeScene({
  lines,
  phase,
  streaming,
  streamingId,
  offline,
  ephemeral,
  pendingPatches,
  reducedMotion,
  scrollRef,
  onScroll,
  onSend,
  onStop,
  onNewChat,
  onLeave,
  onDecide
}: VibeSceneProps): JSX.Element {
  return (
    <div className="vibe-root dark relative flex h-screen w-full flex-col overflow-hidden" data-phase={phase}>
      <LagoonCanvas phase={phase} still={reducedMotion} />
      <div className="vibe-aurora" aria-hidden="true" />
      {!reducedMotion && (
        <div className="vibe-motes" aria-hidden="true">
          {MOTES.map((m, i) => (
            <span
              key={i}
              className="vibe-mote"
              style={{
                left: `${m.left}%`,
                width: m.size,
                height: m.size,
                animationDuration: `${m.duration}s`,
                animationDelay: `${m.delay}s`,
                ['--vibe-sway' as string]: m.sway
              }}
            />
          ))}
        </div>
      )}

      <main className="relative z-10 flex min-h-0 flex-1 flex-col" aria-label="VIBE conversation">
        <div ref={scrollRef} onScroll={onScroll} className="vibe-scroll min-h-0 flex-1 overflow-y-auto">
          {lines.length === 0 ? (
            <VibeEmpty />
          ) : (
            <div className="mx-auto flex max-w-[680px] flex-col gap-7 px-6 pb-10 pt-[16vh]">
              {lines.map((line) =>
                line.role === 'user' ? (
                  <p key={line.id} className={`vibe-user vibe-line-enter ${line.queued ? 'opacity-60' : ''}`}>
                    {line.text}
                  </p>
                ) : (
                  <VibeReply key={line.id} line={line} live={line.id === streamingId} />
                )
              )}
              {phase === 'breathing' && (
                <div className="vibe-breath" role="status" aria-label="Thinking">
                  <span />
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="px-6 pb-5 pt-2">
          <div className="mx-auto flex max-w-[680px] flex-col gap-3">
            {pendingPatches.map((p) => (
              <VibeApproval key={p.reviewId} patch={p} onDecide={onDecide} />
            ))}
            {offline && (
              <p className="text-center text-xs text-ink-secondary">
                LM Studio isn’t answering — start its local server, and the water will wait.
              </p>
            )}
            <VibeComposer streaming={streaming} onSend={onSend} onStop={onStop} />
            <div className="flex justify-center gap-5 text-[11px] text-ink-tertiary">
              {ephemeral && (
                <span title="Ephemeral chat — nothing is written to disk; it is gone when you close it or quit">
                  ◌ not saved
                </span>
              )}
              <button
                type="button"
                onClick={onNewChat}
                disabled={streaming}
                className="vibe-link disabled:opacity-40"
                title="Start a new conversation (⌘N)"
              >
                new chat
              </button>
              <button type="button" onClick={onLeave} className="vibe-link" title="Leave VIBE (Esc or ⌘⇧L)">
                leave vibe · esc
              </button>
            </div>
          </div>
        </footer>
      </main>
    </div>
  )
}

function VibeEmpty(): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="vibe-glyph" aria-hidden="true">
        〰
      </div>
      <h1 className="mt-5 text-[26px] font-light tracking-[-0.01em] text-ink-primary">Still water.</h1>
      <p className="mt-2 max-w-sm text-sm text-ink-secondary">Nothing here but the conversation. Say anything.</p>
    </div>
  )
}

/**
 * One reply, in the lagoon's light. The live one reads the streaming tail the
 * way the full bubble does (a token re-renders this line alone), parses its
 * stable prefix once per completed block, and fades its newest word in.
 */
const VibeReply = memo(function VibeReply({ line, live }: { line: VibeLine; live: boolean }): JSX.Element {
  const tail = useAppStore((s) => (live && s.streamingTail?.messageId === line.id ? s.streamingTail.text : null))
  const text = stripCitationMarkers(tail ?? line.text)
  const [stable, rest] = tail !== null ? splitStreamingMarkdown(text) : [text, '']
  const stableHtml = useMemo(() => (stable ? renderMarkdown(stable) : ''), [stable])
  if (line.quiet) {
    return <p className="vibe-quiet vibe-line-enter">{line.text}</p>
  }
  // Both halves are DOMPurify-sanitized in renderMarkdown; fadeStreamEdge only
  // wraps already-sanitized text in a span of our own.
  const html = rest ? stableHtml + fadeStreamEdge(renderMarkdown(rest)) : stableHtml
  return (
    <div
      className="markdown-body vibe-prose vibe-line-enter"
      onClick={handleCodeBlockClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})

/**
 * A file change waiting for the reader. The one piece of the machinery VIBE
 * always shows: nothing is written until Apply, and a review nobody could see
 * would sit for ten minutes and then quietly become a discard.
 */
function VibeApproval({
  patch,
  onDecide
}: {
  patch: PendingPatch
  onDecide: (reviewId: string, approved: boolean) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const decide = (approved: boolean): void => onDecide(patch.reviewId, approved)
  const size = patch.isNew ? `new file, ${patch.stats.added} lines` : `+${patch.stats.added} −${patch.stats.removed}`
  return (
    <div className="vibe-approval vibe-line-enter" role="group" aria-label={`Proposed change to ${patch.path}`}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-0 flex-1 text-sm text-ink-primary">
          A change to <span className="font-mono text-[13px]">{patch.path}</span>{' '}
          <span className="text-ink-tertiary">({size})</span> is waiting for you.
        </span>
        <button type="button" onClick={() => setOpen((o) => !o)} className="vibe-link text-xs" aria-expanded={open}>
          {open ? 'hide' : 'look'}
        </button>
        <button type="button" onClick={() => decide(true)} className="vibe-button">
          Apply
        </button>
        <button type="button" onClick={() => decide(false)} className="vibe-button vibe-button--quiet">
          Discard
        </button>
      </div>
      {open && (
        <div className="mt-3">
          <DiffView diff={patch.diff} />
        </div>
      )}
    </div>
  )
}

/**
 * One line to type in. Enter sends, Shift+Enter breaks the line; typing while
 * a reply is being written steers it (v2.7), exactly as the full composer
 * does, because sendMessage decides that and not this component.
 */
function VibeComposer({
  streaming,
  onSend,
  onStop
}: {
  streaming: boolean
  onSend: (text: string) => void
  onStop: () => void
}): JSX.Element {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  // Focus on arrival and whenever a reply finishes: in VIBE the composer is
  // the only thing there is to do.
  useEffect(() => {
    if (!streaming) ref.current?.focus()
  }, [streaming])

  // Grow with the text up to eight lines, then scroll.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [text])

  const submit = (): void => {
    const value = text.trim()
    if (!value) return
    onSend(value)
    setText('')
  }

  return (
    <form
      className="vibe-composer"
      data-live={streaming ? 'true' : 'false'}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <textarea
        ref={ref}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder={streaming ? 'add a thought — it reaches the reply as it’s written…' : 'say anything…'}
        aria-label="Message"
        className="vibe-input"
      />
      {streaming && !text.trim() ? (
        <button type="button" onClick={onStop} className="vibe-send" aria-label="Stop" title="Stop">
          <span className="vibe-stop-glyph" />
        </button>
      ) : (
        <button type="submit" disabled={!text.trim()} className="vibe-send" aria-label="Send" title="Send (Enter)">
          ↑
        </button>
      )}
    </form>
  )
}
