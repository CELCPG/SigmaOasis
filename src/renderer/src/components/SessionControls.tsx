import { useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { useConversations } from '../hooks/useConversations'
import type { ChatMode, Conversation, ModelConfig } from '../types'
import { ACCENT } from '../lib/colors'
import { conversationToMarkdown } from '../lib/exportMarkdown'

interface Props {
  conversation: Conversation
}

const MODE_LABELS: Record<ChatMode, string> = {
  independent: 'Independent',
  collaborative: 'Pipeline',
  orchestrated: 'Orchestrated'
}

const MODE_HINTS: Record<ChatMode, string> = {
  independent: 'One role answers. Pick which, or route a single message with @RoleName.',
  collaborative: 'Every enabled role answers in turn, each building on the last.',
  orchestrated: 'One role leads and delegates to the others as it needs them.'
}

/**
 * The "This chat" section of the sidebar: everything scoped to the open
 * conversation rather than the app. Through v0.9 these lived in a bar above the
 * chat; they sit here now so the message list runs full height and the controls
 * you change between chats are next to the chats themselves.
 */
export function SessionControls({ conversation }: Props): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const streaming = useAppStore((s) => s.streaming)
  const { rollbackContext, patchConversation } = useConversations()
  const [exported, setExported] = useState(false)
  const [memoryPickerOpen, setMemoryPickerOpen] = useState(false)
  const [availableSources, setAvailableSources] = useState<string[] | null>(null)

  if (!settings) return null

  const enabledModels = settings.models.filter((m) => m.enabled)
  const scopedSources = conversation.memorySources ?? null

  const patch = (partial: Partial<Conversation>): void =>
    patchConversation(conversation.id, partial)

  const setMode = (mode: ChatMode): void => {
    if (streaming) return
    // Default the orchestrator to the first enabled slot when switching in.
    if (mode === 'orchestrated' && !conversation.orchestratorSlotId) {
      patch({ mode, orchestratorSlotId: enabledModels[0]?.id })
    } else {
      patch({ mode })
    }
  }

  /** Load the memory source list the first time the picker opens. */
  const toggleMemoryPicker = (): void => {
    const next = !memoryPickerOpen
    setMemoryPickerOpen(next)
    if (next && availableSources === null) {
      void window.api
        .memoryStats()
        .then((stats) => setAvailableSources(stats.sources.map((s) => s.source)))
        .catch(() => setAvailableSources([]))
    }
  }

  /** Toggle one source. `null` means all; unchecking from null materializes the list. */
  const toggleSource = (source: string): void => {
    const current = scopedSources ?? availableSources ?? []
    const next = current.includes(source)
      ? current.filter((s) => s !== source)
      : [...current, source]
    // Selecting everything available is the same as no scope at all — store null.
    const allSelected = (availableSources ?? []).every((s) => next.includes(s))
    patch({ memorySources: allSelected ? null : next })
  }

  const confirmRollback = (): void => {
    const willDrop = [
      conversation.summary ? 'the summary of earlier messages' : null,
      'any fetched web pages held in memory'
    ]
      .filter(Boolean)
      .join(' and ')
    if (
      window.confirm(
        `Roll back the model's working context?\n\nThis drops ${willDrop}. Visible messages stay, and notes + long-term memory are not touched.`
      )
    ) {
      void rollbackContext(conversation.id)
    }
  }

  const exportMarkdown = async (): Promise<void> => {
    const result = await window.api.exportConversationMarkdown(
      conversation.title,
      conversationToMarkdown(conversation)
    )
    if (result.ok) {
      setExported(true)
      setTimeout(() => setExported(false), 2000)
    } else if (result.error) {
      alert(`Export failed: ${result.error}`)
    }
  }

  const rolePill = (m: ModelConfig, active: boolean, onClick: () => void): JSX.Element => (
    <button
      key={m.id}
      type="button"
      onClick={onClick}
      className={`flex min-w-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] transition-colors ${
        active
          ? `${ACCENT[m.color].badge} font-medium`
          : 'text-ink-tertiary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink-secondary'
      }`}
      title={`Route with @${m.roleName.replace(/\s+/g, '')}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${ACCENT[m.color].dot}`} />
      <span className="truncate">{m.roleName}</span>
    </button>
  )

  const utilityButton =
    'rounded-lg px-2 py-1 text-[11px] text-ink-tertiary transition-colors hover:bg-black/5 dark:hover:bg-white/10 hover:text-ink-primary disabled:opacity-40 disabled:hover:bg-transparent'

  return (
    <div className="border-t border-black/10 dark:border-white/10 px-4 pb-2 pt-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
          This chat
        </span>
        {conversation.ephemeral && (
          <span
            className="rounded-full border border-violet-400/30 bg-violet-400/10 px-1.5 py-0.5 text-[10px] text-violet-500 dark:text-violet-300"
            title="This chat lives only in memory. Nothing is written to disk; it is gone when you close it or quit."
          >
            ◌ ephemeral
          </span>
        )}
      </div>

      {/*
        Strategy. 10px, not 11 — "Orchestrated" is the longest label the rail has
        to hold, and at 11px it ellipsizes inside a 248px three-up control.
      */}
      <div
        className="grid grid-cols-3 gap-0.5 rounded-full bg-black/5 dark:bg-white/5 p-0.5 text-[10px]"
        title={MODE_HINTS[conversation.mode]}
      >
        {(Object.keys(MODE_LABELS) as ChatMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setMode(mode)}
            disabled={streaming}
            className={`truncate rounded-full px-1 py-1 transition-colors ${
              conversation.mode === mode
                ? 'bg-white/70 dark:bg-white/10 font-medium text-ink-primary shadow-sm'
                : 'text-ink-tertiary hover:text-ink-secondary'
            } disabled:opacity-50`}
            title={MODE_HINTS[mode]}
          >
            {MODE_LABELS[mode]}
          </button>
        ))}
      </div>

      {/* Who answers */}
      <div className="mt-2">
        {conversation.mode === 'independent' &&
          (enabledModels.length === 0 ? (
            <p className="px-1 text-[11px] text-ink-muted">No roles enabled — open Settings</p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {enabledModels.map((m) =>
                rolePill(m, conversation.activeModelSlotId === m.id, () =>
                  patch({ activeModelSlotId: m.id })
                )
              )}
            </div>
          ))}

        {conversation.mode === 'collaborative' && (
          <p className="px-1 text-[11px] leading-relaxed text-ink-tertiary">
            {settings.pipeline
              .map((id) => settings.models.find((m) => m.id === id)?.roleName)
              .filter(Boolean)
              .join(' → ') || 'Empty chain — configure it under Settings → Pipeline'}
          </p>
        )}

        {conversation.mode === 'orchestrated' && (
          <>
            <p className="mb-1 px-1 text-[10px] uppercase tracking-[0.08em] text-ink-muted">
              Orchestrator
            </p>
            <div className="flex flex-wrap gap-1">
              {enabledModels.map((m) =>
                rolePill(m, conversation.orchestratorSlotId === m.id, () =>
                  patch({ orchestratorSlotId: m.id })
                )
              )}
            </div>
            <p className="mt-1 px-1 text-[10px] text-ink-muted">
              Delegates to the other {Math.max(0, enabledModels.length - 1)} enabled role(s)
            </p>
          </>
        )}
      </div>

      {/* Memory scope · rollback · export */}
      <div className="relative mt-2 flex items-center gap-0.5">
        <button
          type="button"
          onClick={toggleMemoryPicker}
          className={
            scopedSources !== null
              ? `${utilityButton} text-accent-ink hover:text-accent-ink`
              : utilityButton
          }
          title={
            scopedSources !== null
              ? `This chat recalls from ${scopedSources.length} of its memory sources`
              : 'This chat recalls from all long-term memory sources — click to scope it'
          }
        >
          📚 {scopedSources !== null ? scopedSources.length : 'All'}
        </button>
        <button
          type="button"
          onClick={confirmRollback}
          disabled={streaming || conversation.messages.length === 0}
          className={utilityButton}
          title="Forget what the model remembers that you cannot see: the compacted summary and any fetched pages held in memory"
        >
          ⏪ Rollback
        </button>
        <button
          type="button"
          onClick={() => void exportMarkdown()}
          disabled={conversation.messages.length === 0}
          className={utilityButton}
          title="Export conversation as Markdown"
        >
          {exported ? '✓ Saved' : '⤓ Export'}
        </button>

        {/* Opens upward — this row sits at the bottom of the rail. */}
        {memoryPickerOpen && (
          <div className="glass-panel absolute bottom-full left-0 z-20 mb-1 w-60 rounded-2xl p-2 text-[11px] shadow-xl">
            <p className="px-2 pb-1.5 pt-1 font-medium text-ink-secondary">
              Memory sources for this chat
            </p>
            {availableSources === null ? (
              <p className="px-2 py-1 text-ink-tertiary">Loading…</p>
            ) : availableSources.length === 0 ? (
              <p className="px-2 py-1 text-ink-tertiary">
                No sources yet — add documents under Settings → Memory.
              </p>
            ) : (
              <>
                {availableSources.map((source) => {
                  const checked = scopedSources === null || scopedSources.includes(source)
                  return (
                    <label
                      key={source}
                      className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSource(source)}
                      />
                      <span className="min-w-0 flex-1 truncate" title={source}>
                        {source}
                      </span>
                    </label>
                  )
                })}
                <button
                  type="button"
                  onClick={() => patch({ memorySources: [] })}
                  className="mt-1 w-full rounded-lg px-2 py-1 text-left text-ink-tertiary hover:bg-black/5 dark:hover:bg-white/5"
                  title="This conversation recalls nothing from long-term memory"
                >
                  ⃠ None — no memory for this chat
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setMemoryPickerOpen(false)}
              className="mt-1 w-full rounded-lg border-t border-black/10 dark:border-white/10 px-2 py-1.5 text-center text-ink-tertiary hover:text-ink-primary"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
