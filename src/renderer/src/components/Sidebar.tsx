import { useAppStore } from '../stores/appStore'
import { useConversations } from '../hooks/useConversations'

/** Left rail: conversation list, new-chat button, settings + connection footer. */
export function Sidebar(): JSX.Element {
  const conversations = useAppStore((s) => s.conversations)
  const activeId = useAppStore((s) => s.activeConversationId)
  const connection = useAppStore((s) => s.connection)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const streaming = useAppStore((s) => s.streaming)
  const { createConversation, selectConversation, removeConversation } = useConversations()

  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-black/10 dark:border-white/10 bg-panel-light dark:bg-panel-dark">
      <div className="flex items-center gap-2 p-3">
        <span className="text-lg">🧠</span>
        <span className="text-sm font-semibold">OpenMind</span>
        <button
          type="button"
          onClick={createConversation}
          disabled={streaming}
          className="ml-auto rounded-lg border border-black/10 dark:border-white/15 px-2.5 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-50"
          title="New conversation"
        >
          + New
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {sorted.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-neutral-400">
            No conversations yet
          </p>
        ) : (
          sorted.map((c) => (
            <div
              key={c.id}
              className={`group mb-0.5 flex items-center rounded-lg px-2.5 py-2 text-sm ${
                c.id === activeId
                  ? 'bg-accent/15 font-medium'
                  : 'hover:bg-black/5 dark:hover:bg-white/5'
              }`}
            >
              <button
                type="button"
                onClick={() => selectConversation(c.id)}
                className="min-w-0 flex-1 truncate text-left"
                title={c.title}
              >
                {c.title}
                {c.mode === 'collaborative' && (
                  <span className="ml-1.5 text-xs text-neutral-400">⛓</span>
                )}
              </button>
              <button
                type="button"
                onClick={() => void removeConversation(c.id)}
                className="ml-1 hidden shrink-0 rounded px-1 text-neutral-400 hover:text-red-500 group-hover:block"
                title="Delete conversation"
              >
                ✕
              </button>
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
          onClick={() => setSettingsOpen(true)}
          className="ml-auto rounded-lg p-1.5 text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
          title="Settings"
        >
          ⚙️
        </button>
      </div>
    </aside>
  )
}
