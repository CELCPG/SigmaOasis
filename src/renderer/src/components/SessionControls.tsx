import { useEffect, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { useConversations } from '../hooks/useConversations'
import type { ChatMode, Conversation, ModelConfig } from '../types'
import { ACCENT } from '../lib/colors'
import { routingReadiness, sameModelOrchestrationNote } from '../lib/routing'
import { conversationToMarkdown } from '../lib/exportMarkdown'
import { PanelSection } from './PanelSection'

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
 * The per-conversation controls of the chat panel: strategy and roles, memory
 * scope, rollback and export. Through v0.9 these lived in a bar above the
 * chat, through v1.9 at the bottom of the conversation rail; they sit in the
 * right panel now (v1.10) so the rail is only a list and the controls that
 * shape *this* chat have room to breathe.
 */
export function SessionControls({ conversation }: Props): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const streaming = useAppStore((s) => s.streaming)
  const { rollbackContext, patchConversation } = useConversations()
  const [exported, setExported] = useState(false)
  const [availableSources, setAvailableSources] = useState<string[] | null>(null)

  if (!settings) return null

  const enabledModels = settings.models.filter((m) => m.enabled)
  const routingNote = routingReadiness(settings.models).note
  const sameModelNote =
    conversation.mode === 'orchestrated' ? sameModelOrchestrationNote(settings.models) : null
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

  /** Load the memory source list once, the first time the section is shown. */
  const loadSources = (): void => {
    if (availableSources !== null) return
    void window.api
      .memoryStats()
      .then((stats) => setAvailableSources(stats.sources.map((s) => s.source)))
      .catch(() => setAvailableSources([]))
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
    <>
      <PanelSection title="Strategy" hint={MODE_HINTS[conversation.mode]}>
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
        <p className="mt-1.5 px-1 text-[10px] leading-relaxed text-ink-tertiary">
          {MODE_HINTS[conversation.mode]}
        </p>

        {/* Who answers */}
        <div className="mt-2">
          {conversation.mode === 'independent' &&
            (enabledModels.length === 0 ? (
              <p className="px-1 text-[11px] text-ink-tertiary">No roles enabled — open Settings</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-1">
                  {enabledModels.map((m) =>
                    rolePill(m, conversation.activeModelSlotId === m.id, () =>
                      patch({ activeModelSlotId: m.id })
                    )
                  )}
                </div>
                {routingNote && (
                  <p
                    className="mt-1.5 px-1 text-[10px] leading-relaxed text-ink-tertiary"
                    title="The pre-flight router sends research, money, code and data turns to matching specialist roles — but only roles that are enabled with a model assigned. This is what it can reach right now."
                  >
                    🔀 {routingNote}
                  </p>
                )}
              </>
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
              <p className="mb-1 px-1 text-[10px] uppercase tracking-[0.08em] text-ink-tertiary">
                Orchestrator
              </p>
              <div className="flex flex-wrap gap-1">
                {enabledModels.map((m) =>
                  rolePill(m, conversation.orchestratorSlotId === m.id, () =>
                    patch({ orchestratorSlotId: m.id })
                  )
                )}
              </div>
              <p className="mt-1 px-1 text-[10px] text-ink-tertiary">
                Delegates to the other {Math.max(0, enabledModels.length - 1)} enabled role(s)
              </p>
              {sameModelNote && (
                <p
                  className="mt-1.5 px-1 text-[10px] leading-relaxed text-amber-600 dark:text-amber-500"
                  title="Measured on this app's own eval suites — 48 cases across three regimes, docs/evals.md in the repository. With different models per role this note disappears, because that configuration has not been measured."
                >
                  ⚖️ {sameModelNote}
                </p>
              )}
            </>
          )}
        </div>
      </PanelSection>

      <PanelSection
        title="Memory"
        hint="Which long-term memory sources this chat may recall from"
        defaultOpen={false}
        right={
          <span
            className={`text-[10px] ${scopedSources !== null ? 'text-accent-ink' : 'text-ink-tertiary'}`}
            title={
              scopedSources !== null
                ? `This chat recalls from ${scopedSources.length} of its memory sources`
                : 'This chat recalls from all long-term memory sources'
            }
          >
            📚 {scopedSources === null ? 'All' : scopedSources.length === 0 ? 'None' : scopedSources.length}
          </span>
        }
      >
        <MemoryScope
          availableSources={availableSources}
          scopedSources={scopedSources}
          onShow={loadSources}
          onToggle={toggleSource}
          onNone={() => patch({ memorySources: [] })}
          onAll={() => patch({ memorySources: null })}
        />
      </PanelSection>

      <PanelSection title="Actions" hint="Rollback the model's hidden context, or export the transcript">
        <div className="flex items-center gap-0.5">
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
        </div>
      </PanelSection>
    </>
  )
}

/**
 * Inline memory-source picker. Rendered only while its section is open, so the
 * source list is fetched on first open (via onShow) rather than on every mount.
 */
function MemoryScope({
  availableSources,
  scopedSources,
  onShow,
  onToggle,
  onNone,
  onAll
}: {
  availableSources: string[] | null
  scopedSources: string[] | null
  onShow: () => void
  onToggle: (source: string) => void
  onNone: () => void
  onAll: () => void
}): JSX.Element {
  useEffect(() => {
    onShow()
    // onShow is stable in practice (guards on state); run once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (availableSources === null) {
    return <p className="px-1 text-[11px] text-ink-tertiary">Loading…</p>
  }
  if (availableSources.length === 0) {
    return (
      <p className="px-1 text-[11px] text-ink-tertiary">
        No sources yet — add documents under Settings → Memory.
      </p>
    )
  }
  return (
    <div className="text-[11px]">
      {availableSources.map((source) => {
        const checked = scopedSources === null || scopedSources.includes(source)
        return (
          <label
            key={source}
            className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5"
          >
            <input type="checkbox" checked={checked} onChange={() => onToggle(source)} />
            <span className="min-w-0 flex-1 truncate" title={source}>
              {source}
            </span>
          </label>
        )
      })}
      <div className="mt-1 flex gap-1">
        <button
          type="button"
          onClick={onAll}
          disabled={scopedSources === null}
          className="rounded-lg px-1.5 py-1 text-ink-tertiary hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40"
          title="Recall from every memory source"
        >
          All
        </button>
        <button
          type="button"
          onClick={onNone}
          disabled={scopedSources !== null && scopedSources.length === 0}
          className="rounded-lg px-1.5 py-1 text-ink-tertiary hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40"
          title="This conversation recalls nothing from long-term memory"
        >
          ⃠ None
        </button>
      </div>
    </div>
  )
}
