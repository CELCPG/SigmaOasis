import { useAppStore } from '../stores/appStore'
import { useConversations } from '../hooks/useConversations'
import { ChatArea } from './ChatArea'
import { EmptyState } from './EmptyState'
import { InputBar } from './InputBar'

/**
 * One column of the chat area. In single-pane mode this is the whole middle of
 * the window and renders exactly what v1.10 did; in split view (v1.11) two of
 * them sit side by side.
 *
 * Only the focused pane carries the composer. That is the point: everything
 * that acts — the composer, the chat panel, every turn entry point — reads
 * `activeConversationId`, which always names the focused pane, so there is
 * never a question of which chat a message is about to go to. The unfocused
 * pane is a reader, one click from becoming the writer.
 */
export function ChatPane({
  conversationId,
  focused,
  split
}: {
  conversationId: string | null
  /** This pane holds `activeConversationId` and owns the composer. */
  focused: boolean
  /** Split view is open — show the pane header and the focus affordance. */
  split: boolean
}): JSX.Element {
  const conversation = useAppStore((s) => s.conversations.find((c) => c.id === conversationId))
  const streaming = useAppStore((s) => s.streaming)
  const focusOtherPane = useAppStore((s) => s.focusOtherPane)
  const closeSplit = useAppStore((s) => s.closeSplit)
  const { createConversation } = useConversations()

  const focusThisPane = (): void => {
    if (!focused) focusOtherPane()
  }

  return (
    <section
      // A click anywhere in the unfocused pane moves the focus there. Capture
      // phase so it lands even when the click was on a message's own button —
      // focus first, then let the button do its thing against the right chat.
      onClickCapture={focusThisPane}
      className={`relative flex min-w-0 flex-1 flex-col ${
        split && !focused ? 'opacity-[0.72] transition-opacity hover:opacity-90' : ''
      }`}
      aria-label={conversation ? conversation.title : 'Empty pane'}
    >
      {split && (
        <PaneHeader
          title={conversation?.title ?? 'No chat'}
          focused={focused}
          onClose={() => {
            // Unconditional, and it has to be: the capture handler above has
            // already focused whichever pane was clicked, so by the time this
            // runs the pane being closed is always the focused one. (Branching
            // on the `focused` prop here read a value that was one event out of
            // date, and closing the pane you were dismissing kept *it* and
            // threw away the one you were reading.)
            focusOtherPane()
            closeSplit()
          }}
        />
      )}

      {conversation && conversationId ? (
        <ChatArea conversation={conversation} />
      ) : (
        <EmptyState
          heading="Welcome to Sigma Oasis"
          onPick={(prompt) => {
            createConversation()
            useAppStore.getState().setComposerPrefill(prompt)
          }}
        />
      )}

      {focused ? (
        <InputBar />
      ) : (
        <div className="p-4 pt-1">
          <div className="mx-auto max-w-3xl">
            <button
              type="button"
              onClick={focusThisPane}
              className="w-full rounded-3xl border border-dashed border-black/10 dark:border-white/10 px-4 py-3 text-xs text-ink-muted transition-colors hover:border-[rgba(0,212,170,0.35)] hover:text-ink-secondary"
              title="Focus this pane to reply in it"
            >
              {streaming
                ? 'A reply is streaming in the other pane — click here to reply in this one when it finishes'
                : 'Click to reply in this chat'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

function PaneHeader({
  title,
  focused,
  onClose
}: {
  title: string
  focused: boolean
  onClose: () => void
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 px-4 pt-3 pb-1">
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          focused ? 'bg-[#00d4aa] shadow-[0_0_8px_rgba(0,212,170,0.6)]' : 'bg-neutral-400/50'
        }`}
        title={focused ? 'Focused — your message goes here' : 'Click the pane to focus it'}
      />
      <span
        className={`min-w-0 flex-1 truncate text-[11px] ${
          focused ? 'font-medium text-ink-secondary' : 'text-ink-muted'
        }`}
        title={title}
      >
        {title}
      </span>
      <button
        type="button"
        onClick={onClose}
        className="shrink-0 rounded-lg px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10 hover:text-neutral-600 dark:hover:text-neutral-300"
        title="Close this pane (⌘\\ closes the split)"
        aria-label="Close this pane"
      >
        ✕
      </button>
    </div>
  )
}
