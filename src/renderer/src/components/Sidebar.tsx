import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { useConversations } from '../hooks/useConversations'
import { useUpdates } from '../hooks/useUpdates'
import { Logo } from './Logo'

/** Left rail: conversation search + list, new-chat button, settings footer. */
export function Sidebar(): JSX.Element {
  const conversations = useAppStore((s) => s.conversations)
  const activeId = useAppStore((s) => s.activeConversationId)
  const connection = useAppStore((s) => s.connection)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const streaming = useAppStore((s) => s.streaming)
  const { createConversation, selectConversation, removeConversation, renameConversation } =
    useConversations()
  const { status: updateStatus, install: installUpdate } = useUpdates()

  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    let cancelled = false
    window.api
      .getAppVersion()
      .then((v) => {
        if (!cancelled) setAppVersion(v)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

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
    <aside className="relative z-10 m-3 mr-0 flex w-[280px] shrink-0 flex-col glass-panel">
      <div className="flex items-center gap-2 p-4 pb-2">
        <Logo size={22} />
        <div className="flex flex-col">
          <span className="text-[15px] font-semibold tracking-[-0.3px]">Sigma Oasis</span>
          <span className="text-[10px] text-neutral-400 dark:text-white/35">Private AI — you own your data</span>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => createConversation({ ephemeral: true })}
            disabled={streaming}
            className="rounded-2xl border border-violet-400/30 bg-violet-400/10 px-2 py-1 text-xs text-violet-500 dark:text-violet-400 hover:bg-violet-400/20 disabled:opacity-50"
            title="New ephemeral chat — nothing is written to disk; gone when you close it or quit"
          >
            ◌
          </button>
          <button
            type="button"
            onClick={() => createConversation()}
            disabled={streaming}
            className="rounded-2xl border border-[rgba(0,212,170,0.3)] bg-[rgba(0,212,170,0.15)] px-2.5 py-1 text-xs text-accent-glow shadow-[0_0_16px_rgba(0,212,170,0.15)] hover:bg-[rgba(0,212,170,0.22)] disabled:opacity-50"
            title="New conversation (⌘N)"
          >
            + New
          </button>
        </div>
      </div>

      {conversations.length > 0 && (
        <div className="px-4 pb-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations…"
            className="w-full rounded-2xl border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 px-3 py-1.5 text-xs outline-none placeholder:text-neutral-400 focus:border-accent"
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 pb-2">
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
              className={`group mb-1 flex items-center rounded-2xl px-2.5 py-2 text-sm transition-colors ${
                c.id === activeId
                  ? 'border border-[rgba(0,212,170,0.35)] bg-[rgba(0,212,170,0.1)] font-medium shadow-[inset_0_1px_0_rgba(0,212,170,0.25)]'
                  : 'border border-transparent hover:bg-black/5 dark:hover:bg-white/5'
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
                  {c.ephemeral && (
                    <span
                      className="ml-1.5 text-xs text-violet-500 dark:text-violet-400"
                      title="Ephemeral — never written to disk"
                    >
                      ◌
                    </span>
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

      {(updateStatus?.state === 'downloaded' || updateStatus?.state === 'downloading') && (
        <div className="border-t border-black/10 dark:border-white/10 px-4 py-2">
          {updateStatus.state === 'downloaded' ? (
            <button
              type="button"
              onClick={installUpdate}
              className="w-full rounded-2xl bg-green-500/15 px-3 py-1.5 text-xs font-medium text-green-600 dark:text-green-400 hover:bg-green-500/25"
              title={`Sigma Oasis ${updateStatus.version} is ready to install`}
            >
              ⬇ Restart to update to {updateStatus.version}
            </button>
          ) : (
            <p className="px-1 text-xs text-neutral-500">
              ⬇ Downloading update… {updateStatus.percent ?? 0}%
            </p>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-black/10 dark:border-white/10 p-4">
        <span
          className={`h-2 w-2 rounded-full ${
            connection === 'online'
              ? 'bg-green-500 shadow-[0_0_8px_rgba(74,222,128,0.8)] animate-pulse'
              : connection === 'connecting'
                ? 'bg-amber-500'
                : 'bg-red-500'
          }`}
          title={`LM Studio: ${connection}`}
        />
        <span className="text-xs text-neutral-500">
          {connection === 'online' ? 'LM Studio connected' : connection}
        </span>
        {appVersion && (
          <span className="text-[10px] text-neutral-400 dark:text-neutral-600" title="Sigma Oasis build version">
            v{appVersion}
          </span>
        )}
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
