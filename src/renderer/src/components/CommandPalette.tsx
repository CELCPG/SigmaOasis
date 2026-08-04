import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { useConversations } from '../hooks/useConversations'

interface CommandItem {
  id: string
  label: string
  shortcut?: string
  icon: string
  action: () => void
  category: 'navigation' | 'actions' | 'settings' | 'conversations'
}

/**
 * Command Palette (Cmd+K / Ctrl+K) - Quick access to all app features via keyboard.
 * Inspired by VS Code, Raycast, and Claude Desktop command palettes.
 */
export function CommandPalette(): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)

  const conversations = useAppStore((s) => s.conversations)
  const activeConversationId = useAppStore((s) => s.activeConversationId)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const setOnboardingOpen = useAppStore((s) => s.setOnboardingOpen(true))
  const connection = useAppStore((s) => s.connection)
  const streaming = useAppStore((s) => s.streaming)
  
  const { createConversation, removeConversation, selectConversation } = useConversations()

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setOpen(prev => !prev)
        setQuery('')
        setSelectedIndex(0)
      }
      if (e.key === 'Escape' && open) {
        setOpen(false)
        setQuery('')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open])

  const commands: CommandItem[] = useMemo(() => [
    // Navigation
    {
      id: 'new-chat',
      label: 'New Chat',
      shortcut: '⌘N',
      icon: '💬',
      action: () => { createConversation(); setOpen(false) },
      category: 'navigation'
    },
    {
      id: 'toggle-settings',
      label: 'Settings',
      shortcut: '⌘,',
      icon: '⚙️',
      action: () => { setSettingsOpen(true); setOpen(false) },
      category: 'settings'
    },
    {
      id: 'onboarding',
      label: 'Setup Checklist',
      icon: '🧭',
      action: () => { setOnboardingOpen(); setOpen(false) },
      category: 'settings'
    },
    // Conversations
    ...conversations.slice(0, 10).map(c => ({
      id: `conv-${c.id}`,
      label: c.title,
      icon: c.id === activeConversationId ? '✅' : '💭',
      action: () => { selectConversation(c.id); setOpen(false) },
      category: 'conversations' as const
    })),
    // Actions
    {
      id: 'clear-memory',
      label: 'Clear Long-term Memory',
      icon: '🧠',
      action: async () => {
        if (confirm('Clear all long-term memory? This cannot be undone.')) {
          await window.api.memoryForget?.()
        }
        setOpen(false)
      },
      category: 'actions'
    },
    {
      id: 'check-updates',
      label: 'Check for Updates',
      icon: '🔄',
      action: () => {
        window.dispatchEvent(new CustomEvent('check-updates'))
        setOpen(false)
      },
      category: 'actions'
    },
    {
      id: 'export-chat',
      label: 'Export Current Chat as Markdown',
      icon: '📥',
      action: async () => {
        await window.api.exportCurrentChat?.()
        setOpen(false)
      },
      category: 'actions'
    }
  ], [conversations, activeConversationId, createConversation, selectConversation, setSettingsOpen, setOnboardingOpen])

  const filteredCommands = useMemo(() => {
    const q = query.toLowerCase().trim()
    if (!q) return commands
    return commands.filter(cmd => 
      cmd.label.toLowerCase().includes(q) ||
      cmd.category.includes(q)
    )
  }, [commands, query])

  // Handle keyboard navigation
  useEffect(() => {
    const handleNav = (e: KeyboardEvent) => {
      if (!open) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(i => Math.min(i + 1, filteredCommands.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(i => Math.max(i - 1, 0))
      } else if (e.key === 'Enter' && filteredCommands[selectedIndex]) {
        e.preventDefault()
        filteredCommands[selectedIndex].action()
      }
    }
    window.addEventListener('keydown', handleNav)
    return () => window.removeEventListener('keydown', handleNav)
  }, [open, filteredCommands, selectedIndex])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]">
      <div className="w-full max-w-xl rounded-2xl border border-white/10 bg-white dark:bg-neutral-900 shadow-2xl overflow-hidden">
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-black/10 dark:border-white/10 p-4">
          <span className="text-lg">🔎</span>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Type a command or search..."
            autoFocus
            className="flex-1 bg-transparent text-base outline-none placeholder:text-neutral-400"
          />
          <kbd className="rounded-md bg-neutral-100 dark:bg-neutral-800 px-2 py-1 text-xs text-neutral-500">
            ESC
          </kbd>
        </div>

        {/* Results list */}
        <div className="max-h-[60vh] overflow-y-auto p-2">
          {filteredCommands.length === 0 ? (
            <p className="p-4 text-center text-sm text-neutral-500">No commands found</p>
          ) : (
            filteredCommands.map((cmd, idx) => (
              <button
                key={cmd.id}
                onClick={cmd.action}
                onMouseEnter={() => setSelectedIndex(idx)}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                  idx === selectedIndex
                    ? 'bg-accent/10 text-accent'
                    : 'hover:bg-black/5 dark:hover:bg-white/5'
                }`}
              >
                <span className="text-lg">{cmd.icon}</span>
                <div className="flex-1">
                  <div className="text-sm font-medium">{cmd.label}</div>
                  <div className="text-xs text-neutral-500 capitalize">{cmd.category}</div>
                </div>
                {cmd.shortcut && (
                  <kbd className="rounded-md bg-neutral-100 dark:bg-neutral-800 px-2 py-1 text-xs text-neutral-500">
                    {cmd.shortcut}
                  </kbd>
                )}
              </button>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div className="border-t border-black/10 dark:border-white/10 px-4 py-2 text-xs text-neutral-500">
          <span className="mr-3">↑↓ Navigate</span>
          <span className="mr-3">↵ Select</span>
          <span>ESC Close</span>
        </div>
      </div>
    </div>
  )
}
