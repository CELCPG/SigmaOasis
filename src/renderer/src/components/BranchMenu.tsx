import { useState } from 'react'
import type { ChatMessage, Conversation } from '../types'
import { useConversations } from '../hooks/useConversations'
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
        <>
          <div 
            className="fixed inset-0 z-40" 
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute right-0 z-50 mt-1 w-48 rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-neutral-900 py-1 shadow-lg">
            <button
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
        </>
      )}
    </div>
  )
}
