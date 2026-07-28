import { useMemo, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { useConversations } from '../hooks/useConversations'

/** Left rail: conversation search + list, new-chat button, settings footer. */
export function Sidebar(): JSX.Element {
  const conversations = useAppStore((s) => s.conversations)
  const activeId = useAppStore((s) => s.activeConversationId)
  const connection = useAppStore((s) => s.connection)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const streaming = useAppStore((s) => s.streaming)
  const { createConversation, selectConversation, removeConversation, renameConversation } =
    useConversations()

  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const sorted = useMemo(
    () => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations]
  )

  // Title match first, then fall back to message-content match.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sorted
    return sorted.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.messages.some((m) => m.content.toLowerCase().includes(q))
    )
  }, [sorted, query])

  const commitRename = (id: string): void => {
    void renameConversation(id, draft)
    setEditingId(null)
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-black/10 dark:border-white/10 bg-panel-light dark:bg-panel-dark">
      <div className="flex items-center gap-2 p-3 pb-2">
        <span className="text-lg">🧠</span>
        <span className="text-sm font-semibold">FunkinAI</span>
        <button
          type="button"
          onClick={createConversation}
          disabled={streaming}
          className="ml-auto rounded-lg border border-black/10 dark:border-white/15 px-2.5 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-50"
          title="New conversation (⌘N)"
        >
          + New
        </button>
      </div>

      {conversations.length > 0 && (
        <div className="px-3 pb-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations…"
            className="w-full rounded-lg border border-black/10 dark:border-white/15 bg-transparent px-2.5 py-1.5 text-xs outline-none placeholder:text-neutral-400 focus:border-accent"
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {sorted.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-neutral-400">
            No conversations yet
          </p>
        ) : filtered.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-neutral-400">
            No matches for “{query.trim()}”
          </p>
        ) : (
          filtered.map((c) => (
            <div
              key={c.id}
              className={`group mb-0.5 flex items-center rounded-lg px-2.5 py-2 text-sm ${
                c.id === activeId
                  ? 'bg-accent/15 font-medium'
                  : 'hover:bg-black/5 dark:hover:bg-white/5'
              }`}
            >
              {editingId === c.id ? (
                <input
                  type="text"
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commitRename(c.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(c.id)
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  className="min-w-0 flex-1 rounded border border-accent bg-transparent px-1 py-0.5 text-sm outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => selectConversation(c.id)}
                  onDoubleClick={() => {
                    setEditingId(c.id)
                    setDraft(c.title)
                  }}
                  className="min-w-0 flex-1 truncate text-left"
                  title={`${c.title} (double-click to rename)`}
                >
                  {c.title}
                  {c.mode === 'collaborative' && (
                    <span className="ml-1.5 text-xs text-neutral-400">⛓</span>
                  )}
                </button>
              )}
              {editingId !== c.id && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(c.id)
                      setDraft(c.title)
                    }}
                    className="ml-1 hidden shrink-0 rounded px-1 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 group-hover:block"
                    title="Rename conversation"
                  >
                    ✏️
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeConversation(c.id)}
                    className="ml-1 hidden shrink-0 rounded px-1 text-neutral-400 hover:text-red-500 group-hover:block"
                    title="Delete conversation"
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          ))
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-black/10 dark:border-white/10 p-3">
        <span
          className={`h-2 w-2 rounded-full ${
            connection === 'online'
              ? 'bg-green-500'
              : connection === 'connecting'
                ? 'bg-amber-500'
                : 'bg-red-500'
          }`}
          title={`LM Studio: ${connection}`}
        />
        <span className="text-xs text-neutral-500">
          {connection === 'online' ? 'LM Studio connected' : connection}
        </span>
        <button
          type="button"
          onClick={() => useAppStore.getState().setOnboardingOpen(true)}
          className="ml-auto rounded-lg p-1.5 text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
          title="Setup checklist"
        >
          🧭
        </button>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="rounded-lg p-1.5 text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
          title="Settings (⌘,)"
        >
          ⚙️
        </button>
      </div>
    </aside>
  )
}
