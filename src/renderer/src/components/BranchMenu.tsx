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

  const handleCreateBranch = () => {
    // Create new conversation starting from messages up to this point
    const msgIndex = conversation.messages.findIndex(m => m.id === message.id)
    if (msgIndex === -1) return

    // Create branch conversation
    createConversation(message.id)
    
    // Get the newly created conversation
    const newConvo = useAppStore.getState().conversations.find(c => c.branches?.some(b => b.messageId === message.id))
    if (newConvo) {
      // Copy messages up to and including this one
      const messagesUpToHere = conversation.messages.slice(0, msgIndex + 1)
      
      // Update the new conversation with copied messages
      useAppStore.getState().upsertConversation({
        ...newConvo,
        messages: messagesUpToHere.map(m => ({
          ...m,
          parentMessageId: m.id === message.id ? undefined : m.parentMessageId,
          branchInfo: m.id === message.id ? { branchId: newConvo.id, isBranch: true } : m.branchInfo
        })),
        title: `${conversation.title} (Branch ${new Date().toLocaleTimeString()})`,
        branches: [
          ...(conversation.branches || []),
          { messageId: message.id, branchId: newConvo.id, title: 'Alternative response' }
        ],
        activeBranchId: newConvo.id
      })
      
      selectConversation(newConvo.id)
    }
    
    setIsOpen(false)
  }

  // Find existing branches from this message
  const existingBranches = conversation.branches?.filter(b => b.messageId === message.id) || []

  return (
    <div className="relative inline-block">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="ml-2 rounded-md p-1 text-xs text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-accent"
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
                <div className="px-3 py-1 text-xs text-neutral-500">Existing branches:</div>
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
