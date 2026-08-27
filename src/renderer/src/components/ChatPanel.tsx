import { useMemo, type ReactNode } from 'react'
import { useAppStore } from '../stores/appStore'
import { useConversations } from '../hooks/useConversations'
import { useProjects } from '../hooks/useProjects'
import type { Conversation } from '../types'
import { PROJECT_ACCENT } from '../lib/projects'
import { projectInheritanceSummary } from '../lib/projectContext'
import { useProjectFileStatus } from '../hooks/useProjectFileStatus'
import { conversationStats, formatTokens, relativeTime } from '../lib/conversationStats'
import { SessionControls } from './SessionControls'
import { PanelSection } from './PanelSection'

/**
 * Toggle the right panel and persist it — a direct manipulation, same as the
 * left rail: a layout someone chose should still be there tomorrow.
 */
export function setRightPanelCollapsed(next: boolean): void {
  const current = useAppStore.getState().settings
  if (!current) return
  const updated = { ...current, rightPanelCollapsed: next }
  useAppStore.getState().setSettings(updated)
  void window.api.setSettings(updated)
}

/**
 * Right-hand chat panel (⌘J): everything scoped to the open conversation —
 * which project it files under, how it answers (strategy and roles), what it
 * may recall, and what has happened in it so far. Through v1.9 the controls
 * sat at the bottom of the conversation rail; the rail is now only a list of
 * chats, and the panel is where a chat is *configured*.
 */
export function ChatPanel(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const conversation = useAppStore((s) =>
    s.conversations.find((c) => c.id === s.activeConversationId)
  )
  const collapsed = settings?.rightPanelCollapsed ?? false

  // One shell, two faces. The width glides between them (.oasis-rail) while
  // the face that is leaving is replaced by one that fades in — see the note
  // on the left rail in Sidebar.tsx, which this mirrors. The `key` is what
  // makes the fade run: without it React reuses the div across the swap and
  // the mount animation never restarts.
  return (
    <aside
      className={`oasis-rail relative z-10 m-3 ml-0 flex shrink-0 flex-col overflow-hidden glass-panel ${
        collapsed ? 'w-[52px]' : 'w-[296px]'
      }`}
      aria-label={collapsed ? 'Chat panel (collapsed)' : 'Chat panel'}
    >
      {collapsed ? (
        <CollapsedStrip key="closed" conversation={conversation} />
      ) : (
        <div key="open" className="oasis-rail-face flex min-h-0 w-[296px] flex-1 flex-col">
          <div className="flex items-center gap-2 px-4 pb-2 pt-4">
            <button
              type="button"
              onClick={() => setRightPanelCollapsed(true)}
              className="rounded-lg px-1.5 py-1 text-xs text-ink-secondary hover:bg-black/5 dark:hover:bg-white/10"
              title="Collapse chat panel (⌘J)"
              aria-label="Collapse chat panel"
              aria-expanded={true}
            >
              »
            </button>
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.2px]">
              {conversation ? conversation.title : 'Chat'}
            </span>
            {conversation?.ephemeral && (
              <span
                className="rounded-full border border-violet-400/30 bg-violet-400/10 px-1.5 py-0.5 text-[10px] text-violet-500 dark:text-violet-300"
                title="This chat lives only in memory. Nothing is written to disk; it is gone when you close it or quit."
              >
                ◌ ephemeral
              </span>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {conversation && settings ? (
              <>
                <ProjectSection conversation={conversation} />
                <SessionControls conversation={conversation} />
                <DetailsSection conversation={conversation} />
              </>
            ) : (
              <p className="px-4 py-6 text-center text-xs text-ink-tertiary">
                Open or start a chat to see its settings here.
              </p>
            )}
          </div>
        </div>
      )}
    </aside>
  )
}

// ---- Collapsed strip --------------------------------------------------------

function CollapsedStrip({ conversation }: { conversation: Conversation | undefined }): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const project = settings?.projects.find((p) => p.id === conversation?.projectId)
  const modeGlyph =
    conversation?.mode === 'collaborative' ? '⛓' : conversation?.mode === 'orchestrated' ? '🎯' : '●'
  const modeLabel =
    conversation?.mode === 'collaborative'
      ? 'Pipeline'
      : conversation?.mode === 'orchestrated'
        ? 'Orchestrated'
        : 'Independent'
  // Full width of the shell rather than a fixed 52px: while the shell is still
  // gliding shut this face is already mounted, and centring on the live width
  // walks the glyphs into place instead of pinning them to the left edge.
  return (
    <div className="oasis-rail-face flex w-full flex-1 flex-col items-center gap-2 py-4">
      <button
        type="button"
        onClick={() => setRightPanelCollapsed(false)}
        className="rounded-lg p-1.5 text-ink-secondary hover:bg-black/5 dark:hover:bg-white/10"
        title="Expand chat panel (⌘J)"
        aria-label="Expand chat panel"
        aria-expanded={false}
      >
        «
      </button>
      {conversation && (
        <>
          <button
            type="button"
            onClick={() => setRightPanelCollapsed(false)}
            className="rounded-lg p-1.5 text-sm text-ink-tertiary hover:bg-black/5 dark:hover:bg-white/10"
            title={`Strategy: ${modeLabel}`}
            aria-label={`Strategy: ${modeLabel}`}
          >
            {modeGlyph}
          </button>
          {project && (
            <button
              type="button"
              onClick={() => setRightPanelCollapsed(false)}
              className="rounded-lg p-2"
              title={`Project: ${project.name}`}
              aria-label={`Project: ${project.name}`}
            >
              <span className={`block h-2.5 w-2.5 rounded-full ${PROJECT_ACCENT[project.color].dot}`} />
            </button>
          )}
          <span
            className="mt-auto text-[10px] text-ink-tertiary"
            title={`${conversation.messages.length} messages`}
          >
            {conversation.messages.length}
          </span>
        </>
      )}
    </div>
  )
}

// ---- Project ----------------------------------------------------------------

function ProjectSection({ conversation }: { conversation: Conversation }): JSX.Element {
  const projects = useAppStore((s) => s.settings?.projects ?? [])
  const { createProject, moveConversation } = useProjects()
  const current = projects.find((p) => p.id === conversation.projectId) ?? null
  const missing = useProjectFileStatus(current).missing

  const onChange = (value: string): void => {
    if (value === '__new__') {
      // No window.prompt here — Electron throws on it. Create, file the chat,
      // and open the editor with the name field selected for renaming.
      const project = createProject('New project')
      if (project) {
        moveConversation(conversation.id, project.id)
        useAppStore.getState().setProjectEditorId(project.id)
      }
      return
    }
    moveConversation(conversation.id, value === '' ? null : value)
  }

  return (
    <PanelSection
      title="Project"
      hint="Group this chat with related ones in the rail"
      right={
        current && (
          <span className={`h-2 w-2 rounded-full ${PROJECT_ACCENT[current.color].dot}`} />
        )
      }
    >
      <select
        value={current?.id ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 px-2.5 py-1.5 text-xs outline-none focus:border-accent"
        title="Which project this chat files under"
      >
        <option value="">No project</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        <option value="__new__">＋ New project…</option>
      </select>
      {current && (
        <div className="mt-2 flex items-start gap-2 text-[11px]">
          <p className="min-w-0 flex-1 leading-relaxed text-ink-tertiary">
            {current.instructions.trim() ? (
              <span title={current.instructions} className="block truncate">
                📝 {current.instructions.trim().split('\n')[0]}
              </span>
            ) : null}
            <span className="block text-ink-tertiary">
              Inherits: {projectInheritanceSummary(current).join(' · ')}
            </span>
            {missing.length > 0 && (
              <span
                className="block text-amber-600 dark:text-amber-400"
                title={missing.map((f) => f.sourcePath).join('\n')}
              >
                ⚠ {missing.length} pinned file{missing.length === 1 ? '' : 's'} not found on disk
              </span>
            )}
          </p>
          <button
            type="button"
            onClick={() => useAppStore.getState().setProjectEditorId(current.id)}
            className="shrink-0 rounded-lg px-2 py-1 text-accent-ink hover:bg-black/5 dark:hover:bg-white/10"
            title="Instructions, pinned files, recall and defaults for this project"
          >
            Edit project…
          </button>
        </div>
      )}
    </PanelSection>
  )
}

// ---- Details ----------------------------------------------------------------

function Row({ label, value, title }: { label: string; value: ReactNode; title?: string }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5 text-[11px]" title={title}>
      <span className="text-ink-tertiary">{label}</span>
      <span className="min-w-0 truncate text-right text-ink-secondary">{value}</span>
    </div>
  )
}

function DetailsSection({ conversation }: { conversation: Conversation }): JSX.Element {
  const conversations = useAppStore((s) => s.conversations)
  const { selectConversation } = useConversations()
  const stats = useMemo(() => conversationStats(conversation), [conversation])

  // Branches are separate conversations; show the ones that still exist, plus
  // the parent when this chat *is* a branch.
  const branchTargets = (conversation.branches ?? [])
    .map((b) => ({ ...b, target: conversations.find((c) => c.id === b.branchId) }))
    .filter((b) => b.target && b.branchId !== conversation.id)
  const parent = conversation.activeBranchId
    ? conversations.find(
        (c) => c.id !== conversation.id && c.branches?.some((b) => b.branchId === conversation.id)
      )
    : undefined

  return (
    <>
      <PanelSection title="Details" hint="What has happened in this chat">
        <Row
          label="Messages"
          value={`${stats.userMessages} sent · ${stats.assistantMessages} replies`}
        />
        {stats.toolCalls > 0 && (
          <Row
            label="Tool calls"
            value={
              stats.declinedCalls > 0
                ? `${stats.toolCalls} · ${stats.declinedCalls} declined`
                : stats.toolCalls
            }
            title={
              stats.declinedCalls > 0
                ? `${stats.declinedCalls} of ${stats.toolCalls} were declined by the app and never ran — ` +
                  'a refused search query, or a confirmation that was cancelled.'
                : undefined
            }
          />
        )}
        {stats.roles.length > 0 && (
          <Row label="Answered by" value={stats.roles.join(', ')} title={stats.roles.join(', ')} />
        )}
        {stats.lastPromptTokens !== null && (
          <Row
            label="Context in use"
            value={`${formatTokens(stats.lastPromptTokens)} tokens`}
            title="Prompt tokens the server reported for the last reply — roughly how much of the window this chat fills"
          />
        )}
        {stats.lastProjectTokens &&
          stats.lastProjectTokens.instructions + stats.lastProjectTokens.recall + stats.lastProjectTokens.files > 0 && (
            <Row
              label="↳ project share"
              value={`~${formatTokens(
                stats.lastProjectTokens.instructions + stats.lastProjectTokens.recall + stats.lastProjectTokens.files
              )} tokens`}
              title={`Estimated tokens the project added to the last reply's prompt — ${[
                `instructions ${formatTokens(stats.lastProjectTokens.instructions)}`,
                `pinned files ${formatTokens(stats.lastProjectTokens.files)}`,
                `recall ${formatTokens(stats.lastProjectTokens.recall)}`
              ].join(' · ')}`}
            />
          )}
        {stats.completionTokens > 0 && (
          <Row
            label="Generated"
            value={`${formatTokens(stats.completionTokens)} tokens${
              stats.avgTokensPerSecond ? ` · ~${stats.avgTokensPerSecond} tok/s` : ''
            }`}
          />
        )}
        <Row
          label="Context"
          value={
            stats.compacted ? (
              <span title="Earlier messages were summarized to fit the window. Rollback drops that summary.">
                compacted {relativeTime(stats.compacted.updatedAt)}
              </span>
            ) : (
              'full history'
            )
          }
        />
        <Row label="Started" value={relativeTime(conversation.createdAt)} title={new Date(conversation.createdAt).toLocaleString()} />
        <Row label="Last activity" value={relativeTime(conversation.updatedAt)} title={new Date(conversation.updatedAt).toLocaleString()} />
      </PanelSection>

      {stats.attachments.length > 0 && (
        <PanelSection title={`Files (${stats.attachments.length})`} hint="Attachments shared in this chat" defaultOpen={false}>
          <ul className="space-y-0.5">
            {stats.attachments.map((a) => (
              <li key={`${a.kind}:${a.name}`} className="truncate text-[11px] text-ink-secondary" title={a.name}>
                {a.kind === 'image' ? '🖼' : '📄'} {a.name}
              </li>
            ))}
          </ul>
        </PanelSection>
      )}

      {(branchTargets.length > 0 || parent) && (
        <PanelSection title="Branches" hint="Alternative paths explored from this chat">
          {parent && (
            <button
              type="button"
              onClick={() => selectConversation(parent.id)}
              className="mb-1 block w-full truncate rounded-lg px-2 py-1 text-left text-[11px] text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5"
              title={`Back to ${parent.title}`}
            >
              ↰ {parent.title}
            </button>
          )}
          {branchTargets.map((b) => (
            <button
              key={b.branchId}
              type="button"
              onClick={() => selectConversation(b.branchId)}
              className="block w-full truncate rounded-lg px-2 py-1 text-left text-[11px] text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5"
              title={b.target!.title}
            >
              ⑂ {b.target!.title}
            </button>
          ))}
        </PanelSection>
      )}
    </>
  )
}
