import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { useConversations } from '../hooks/useConversations'
import { useUpdates } from '../hooks/useUpdates'
import { useProjects } from '../hooks/useProjects'
import { groupConversations, PROJECT_ACCENT } from '../lib/projects'
import type { Conversation, Project } from '../types'
import { Logo } from './Logo'

/**
 * Left rail: conversation search + list (grouped by project), new-chat button,
 * and the settings footer. Per-chat controls live in the right ChatPanel.
 */
export function Sidebar(): JSX.Element {
  const conversations = useAppStore((s) => s.conversations)
  const activeId = useAppStore((s) => s.activeConversationId)
  const connection = useAppStore((s) => s.connection)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const streaming = useAppStore((s) => s.streaming)
  const { createConversation, selectConversation, removeConversation, renameConversation } =
    useConversations()
  const { status: updateStatus, install: installUpdate } = useUpdates()
  const { createProject, renameProject, deleteProject, moveConversation } = useProjects()
  const settings = useAppStore((s) => s.settings)
  const collapsed = settings?.sidebarCollapsed ?? false
  const projects = settings?.projects ?? []

  /**
   * Persisted immediately rather than through the settings modal's draft: the
   * rail is a direct manipulation, and a layout that forgets itself on restart
   * is the kind of small betrayal people stop using a control over.
   */
  const setCollapsed = (next: boolean): void => {
    if (!settings) return
    const updated = { ...settings, sidebarCollapsed: next }
    useAppStore.getState().setSettings(updated)
    void window.api.setSettings(updated)
  }

  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [appVersion, setAppVersion] = useState('')
  // Project groups folded shut. Per-session: a fold is a reading aid, not layout.
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null)
  const [projectDraft, setProjectDraft] = useState('')
  // Which conversation has its "move to project" menu open.
  const [moveMenuId, setMoveMenuId] = useState<string | null>(null)

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

  const grouped = useMemo(() => groupConversations(filtered, projects), [filtered, projects])
  // While searching, every group is forced open: a hit hidden under a fold
  // reads as "no match".
  const searching = query.trim().length > 0

  const commitProjectRename = (id: string): void => {
    renameProject(id, projectDraft)
    setEditingProjectId(null)
  }

  const newProject = (): void => {
    const name = window.prompt('Project name')
    if (name === null) return
    createProject(name)
  }

  const confirmDeleteProject = (p: Project, count: number): void => {
    const detail =
      count > 0
        ? `Its ${count} chat${count === 1 ? '' : 's'} will be kept and moved out of the project.`
        : 'It has no chats.'
    if (window.confirm(`Delete project “${p.name}”?\n\n${detail}`)) deleteProject(p.id)
  }

  const dotClass =
    connection === 'online'
      ? 'bg-green-500 shadow-[0_0_8px_rgba(74,222,128,0.8)] animate-pulse'
      : connection === 'connecting'
        ? 'bg-amber-500'
        : 'bg-red-500'

  /** One row in the list. Used for both project groups and the unfiled tail. */
  const renderConversation = (c: Conversation): JSX.Element => (
    <div
      key={c.id}
      className={`group relative mb-1 flex items-center rounded-2xl px-2.5 py-2 text-sm transition-colors ${
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
          {projects.length > 0 && (
            <button
              type="button"
              onClick={() => setMoveMenuId(moveMenuId === c.id ? null : c.id)}
              className="ml-1 hidden shrink-0 rounded px-1 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 group-hover:block"
              title="Move to project"
              aria-haspopup="menu"
              aria-expanded={moveMenuId === c.id}
            >
              📁
            </button>
          )}
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
      {moveMenuId === c.id && (
        // Wrapped: .glass-panel pins position:relative, so the glass itself
        // cannot be the absolutely positioned element.
        <div className="absolute right-0 top-full z-20 mt-1 w-48" onMouseLeave={() => setMoveMenuId(null)}>
        <div
          role="menu"
          className="glass-panel glass-popover rounded-2xl p-1.5 text-[11px] shadow-xl"
        >
          <p className="px-2 pb-1 pt-0.5 font-medium text-ink-secondary">Move to project</p>
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitem"
              onClick={() => {
                moveConversation(c.id, p.id)
                setMoveMenuId(null)
              }}
              disabled={c.projectId === p.id}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40"
            >
              <span className={`h-2 w-2 rounded-full ${PROJECT_ACCENT[p.color].dot}`} />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
            </button>
          ))}
          {c.projectId && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                moveConversation(c.id, null)
                setMoveMenuId(null)
              }}
              className="mt-1 w-full rounded-lg border-t border-black/10 dark:border-white/10 px-2 py-1 text-left text-ink-tertiary hover:text-ink-primary"
            >
              Remove from project
            </button>
          )}
        </div>
        </div>
      )}
    </div>
  )

  if (collapsed) {
    // The rail keeps what someone collapses the sidebar *to keep*: a way back,
    // a new chat, and whether the model is reachable. Everything else is one
    // click away through the command palette, which search already routes to.
    return (
      <aside className="relative z-10 m-3 mr-0 flex w-[52px] shrink-0 flex-col items-center gap-2 py-4 glass-panel">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="rounded-lg p-1.5 text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
          title="Expand conversations (⌘B)"
          aria-label="Expand conversations"
          aria-expanded={false}
        >
          »
        </button>
        <Logo size={22} />
        <button
          type="button"
          onClick={() => createConversation()}
          disabled={streaming}
          className="mt-1 rounded-2xl border border-[rgba(0,212,170,0.3)] bg-[rgba(0,212,170,0.15)] px-2.5 py-1 text-sm text-accent-ink shadow-[0_0_16px_rgba(0,212,170,0.15)] hover:bg-[rgba(0,212,170,0.22)] disabled:opacity-50"
          title="New conversation (⌘N)"
          aria-label="New conversation"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="rounded-lg p-1.5 text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
          title="Search conversations"
          aria-label="Search conversations"
        >
          🔍
        </button>
        <div className="mt-auto flex flex-col items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${dotClass}`} title={`LM Studio: ${connection}`} />
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="rounded-lg p-1.5 text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
            title="Settings (⌘,)"
            aria-label="Settings"
          >
            ⚙️
          </button>
        </div>
      </aside>
    )
  }

  return (
    <aside className="relative z-10 m-3 mr-0 flex w-[280px] shrink-0 flex-col glass-panel">
      <div className="flex items-center gap-2 px-4 pb-1 pt-4">
        <Logo size={22} />
        <span className="text-[15px] font-semibold tracking-[-0.3px]">Sigma Oasis</span>
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
            className="rounded-2xl border border-[rgba(0,212,170,0.3)] bg-[rgba(0,212,170,0.15)] px-2.5 py-1 text-xs text-accent-ink shadow-[0_0_16px_rgba(0,212,170,0.15)] hover:bg-[rgba(0,212,170,0.22)] disabled:opacity-50"
            title="New conversation (⌘N)"
          >
            + New
          </button>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="rounded-lg px-1.5 py-1 text-xs text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
            title="Collapse conversations (⌘B)"
            aria-label="Collapse conversations"
            aria-expanded={true}
          >
            «
          </button>
        </div>
      </div>

      {/* Its own row — beside the two buttons it wrapped mid-phrase at 280px. */}
      <p className="px-4 pb-3 text-[10px] text-ink-muted">Private AI — you own your data</p>

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
        {sorted.length === 0 && projects.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-neutral-400">
            No conversations yet
          </p>
        ) : filtered.length === 0 && searching ? (
          <p className="px-2 py-4 text-center text-xs text-neutral-400">
            No matches for “{query.trim()}”
          </p>
        ) : (
          <>
            {grouped.groups.map(({ project, conversations: items }) => {
              const isOpen = searching || !folded[project.id]
              return (
                <div key={project.id} className="mb-1">
                  <div className="group/project flex items-center gap-1 rounded-xl px-1.5 py-1">
                    <button
                      type="button"
                      onClick={() =>
                        setFolded((f) => ({ ...f, [project.id]: !f[project.id] }))
                      }
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      aria-expanded={isOpen}
                      title={`${project.name} — ${items.length} chat${items.length === 1 ? '' : 's'}`}
                    >
                      <span className="w-3 text-[9px] text-ink-muted">{isOpen ? '▼' : '▶'}</span>
                      <span className={`h-2 w-2 shrink-0 rounded-full ${PROJECT_ACCENT[project.color].dot}`} />
                      {editingProjectId === project.id ? (
                        <input
                          type="text"
                          value={projectDraft}
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setProjectDraft(e.target.value)}
                          onBlur={() => commitProjectRename(project.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitProjectRename(project.id)
                            if (e.key === 'Escape') setEditingProjectId(null)
                          }}
                          className="min-w-0 flex-1 rounded border border-accent bg-transparent px-1 py-0.5 text-[11px] outline-none"
                        />
                      ) : (
                        <span
                          className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary"
                          onDoubleClick={(e) => {
                            e.stopPropagation()
                            setEditingProjectId(project.id)
                            setProjectDraft(project.name)
                          }}
                        >
                          {project.name}
                        </span>
                      )}
                      <span className="text-[10px] text-ink-muted">{items.length}</span>
                    </button>
                    {editingProjectId !== project.id && (
                      <span className="hidden shrink-0 items-center group-hover/project:flex">
                        <button
                          type="button"
                          onClick={() => createConversation({ projectId: project.id })}
                          disabled={streaming}
                          className="rounded px-1 text-xs text-accent-ink hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
                          title={`New chat in ${project.name}`}
                        >
                          +
                        </button>
                        <button
                          type="button"
                          onClick={() => useAppStore.getState().setProjectEditorId(project.id)}
                          className="rounded px-1 text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                          title="Project settings — instructions, pinned files, recall, defaults"
                        >
                          ⚙
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingProjectId(project.id)
                            setProjectDraft(project.name)
                          }}
                          className="rounded px-1 text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                          title="Rename project"
                        >
                          ✏️
                        </button>
                        <button
                          type="button"
                          onClick={() => confirmDeleteProject(project, items.length)}
                          className="rounded px-1 text-xs text-neutral-400 hover:text-red-500"
                          title="Delete project (keeps its chats)"
                        >
                          ✕
                        </button>
                      </span>
                    )}
                  </div>
                  {isOpen &&
                    (items.length === 0 ? (
                      <p className="px-6 py-1 text-[11px] text-ink-muted">
                        No chats yet — hover the project for +
                      </p>
                    ) : (
                      <div className="ml-3 border-l border-black/10 dark:border-white/10 pl-1.5">
                        {items.map((c) => renderConversation(c))}
                      </div>
                    ))}
                </div>
              )
            })}

            {projects.length > 0 && grouped.unfiled.length > 0 && (
              <p className="mt-2 px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
                Unfiled
              </p>
            )}
            {grouped.unfiled.map((c) => renderConversation(c))}

            <button
              type="button"
              onClick={newProject}
              className="mt-2 w-full rounded-xl px-2.5 py-1.5 text-left text-[11px] text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink-secondary"
              title="Group related chats under a name"
            >
              ＋ New project
            </button>
          </>
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
        <span className={`h-2 w-2 rounded-full ${dotClass}`} title={`LM Studio: ${connection}`} />
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
