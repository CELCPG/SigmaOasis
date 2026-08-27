import { useState } from 'react'
import type { ChatMessage, Conversation } from '../types'
import { useConversations } from '../hooks/useConversations'
import { useModalSurface } from '../hooks/useModalSurface'
import { useAppStore } from '../stores/appStore'

interface BranchMenuProps {
  message: ChatMessage
  conversation: Conversation
}

/**
 * Branch menu button - allows users to create alternative conversation paths.
 * Clicking creates a new branch from this message point.
 */
export function BranchMenu({ message, conversation }: BranchMenuProps): JSX.Element | null {
  const [isOpen, setIsOpen] = useState(false)
  const { createConversation, selectConversation } = useConversations()
  const conversations = useAppStore(s => s.conversations)

  // This menu is a covering surface too, and it is the one a check written
  // against `fixed inset-0 z-50` cannot see: the click-catcher below is z-40
  // and the menu itself is `absolute`, so the traversal instrument calls every
  // stop behind it a page stop. While it is open it covers the viewport, so
  // every control on the page is obscured and still tabbable — the same defect
  // the four modals had, in the form that was not on the list. It is a menu,
  // not a dialog, so it is announced as one.
  const { surfaceRef, dialogProps } = useModalSurface(isOpen, {
    onDismiss: () => setIsOpen(false),
    role: 'menu'
  })

  // Only show on assistant messages
  if (message.role !== 'assistant') return null

  const handleCreateBranch = (): void => {
    const msgIndex = conversation.messages.findIndex((m) => m.id === message.id)
    if (msgIndex === -1) return

    // createConversation returns the new record directly. Searching the store
    // for "a conversation with a branch from this message" would match the
    // first *earlier* branch once one exists.
    // A branch stays in its parent's project — it is the same line of work.
    const branch = createConversation({
      branchFromMessageId: message.id,
      projectId: conversation.projectId ?? null
    })
    const store = useAppStore.getState()

    // The branch starts as a copy of everything up to and including this reply;
    // the next turn diverges from there.
    const messagesUpToHere = conversation.messages.slice(0, msgIndex + 1).map((m) =>
      m.id === message.id
        ? { ...m, branchInfo: { branchId: branch.id, isBranch: true } }
        : { ...m }
    )

    // A branch of an ephemeral conversation stays ephemeral — copying its
    // messages into a persisted one would put them on disk by the back door.
    store.upsertConversation({
      ...branch,
      ...(conversation.ephemeral ? { ephemeral: true } : {}),
      memorySources: conversation.memorySources,
      mode: conversation.mode,
      activeModelSlotId: conversation.activeModelSlotId,
      orchestratorSlotId: conversation.orchestratorSlotId,
      messages: messagesUpToHere,
      title: `${conversation.title} (branch)`
    })

    // Record the branch on the parent so it can be navigated back to.
    store.upsertConversation({
      ...conversation,
      branches: [
        ...(conversation.branches ?? []),
        { messageId: message.id, branchId: branch.id, title: 'Alternative response' }
      ]
    })

    selectConversation(branch.id)
    setIsOpen(false)
  }

  // Find existing branches from this message
  const existingBranches = conversation.branches?.filter(b => b.messageId === message.id) || []

  return (
    <div className="relative inline-block">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="ml-2 rounded-md p-1 text-xs text-ink-secondary hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-accent-ink"
        title="Explore alternative response"
      >
        🌿
      </button>

      {isOpen && (
        // One wrapper around both halves, because the containment is computed
        // from this node outward: with the ref on the click-catcher instead,
        // the menu beside it would be a sibling and would inert itself.
        <div ref={surfaceRef}>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />
          <div
            {...dialogProps}
            aria-label="Alternative responses"
            className="absolute right-0 z-50 mt-1 w-48 rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-neutral-900 py-1 shadow-lg"
          >
            <button
              role="menuitem"
              onClick={handleCreateBranch}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5"
            >
              <span>🌱</span>
              <span>Create alternative</span>
            </button>
            
            {existingBranches.length > 0 && (
              <>
                <div className="my-1 border-t border-black/10 dark:border-white/10" />
                <div className="px-3 py-1 text-xs text-ink-secondary">Existing branches:</div>
                {existingBranches.map((branch, idx) => {
                  const branchConvo = conversations.find(c => c.id === branch.branchId)
                  return (
                    <button
                      key={idx}
                      role="menuitem"
                      onClick={() => {
                        if (branchConvo) selectConversation(branchConvo.id)
                        setIsOpen(false)
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5"
                    >
                      <span>🔀</span>
                      <span className="truncate">{branch.title}</span>
                    </button>
                  )
                })}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
