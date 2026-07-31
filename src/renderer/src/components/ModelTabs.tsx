import { useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { useConversations } from '../hooks/useConversations'
import type { ChatMode, Conversation, ModelConfig } from '../types'
import { ACCENT } from '../lib/colors'
import { conversationToMarkdown } from '../lib/exportMarkdown'
import { budgetContextLength, formatContextLength } from '../lib/modelInfo'
import { estimateMessageTokens, estimateTokens } from '../lib/contextBudget'

interface Props {
  conversation: Conversation
}

const MODE_LABELS: Record<ChatMode, string> = {
  independent: 'Independent',
  collaborative: 'Pipeline',
  orchestrated: 'Orchestrated'
}

/**
 * Top bar above the chat: pick the strategy (Independent / Pipeline /
 * Orchestrated), the active slot for independent mode, or the orchestrator
 * for orchestrated mode. Also hosts the v0.9 conversation-scoped controls:
 * memory source picker, context rollback, and the ephemeral indicator.
 */
export function ModelTabs({ conversation }: Props): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const upsertConversation = useAppStore((s) => s.upsertConversation)
  const streaming = useAppStore((s) => s.streaming)
  const availableModels = useAppStore((s) => s.availableModels)
  const { rollbackContext } = useConversations()
  const [exported, setExported] = useState(false)
  const [memoryPickerOpen, setMemoryPickerOpen] = useState(false)
  const [availableSources, setAvailableSources] = useState<string[] | null>(null)

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

  const scopedSources = conversation.memorySources ?? null

  /** Toggle one source. `null` means all; unchecking from null materializes the list. */
  const toggleSource = (source: string): void => {
    const current = scopedSources ?? availableSources ?? []
    const next = current.includes(source)
      ? current.filter((s) => s !== source)
      : [...current, source]
    // Selecting everything available is the same as no scope at all — store null.
    const allSelected = (availableSources ?? []).every((s) => next.includes(s))
    patchConvo({ memorySources: allSelected ? null : next })
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

  if (!settings) return <div className="m-3 mb-0 h-12 glass-panel" />

  const enabledModels = settings.models.filter((m) => m.enabled)

  /**
   * How full the context window is. Shown only when LM Studio reported a
   * window size — a meter against a guessed denominator would be worse than
   * no meter. The numerator is an estimate either way, which the tooltip says.
   */
  const activeSlot =
    settings.models.find((m) => m.id === conversation.activeModelSlotId && m.enabled) ??
    settings.models.find((m) => m.enabled)
  const total = budgetContextLength(
    activeSlot,
    availableModels.find((m) => m.id === activeSlot?.modelId)
  )
  const contextMeter = total
    ? (() => {
        const used =
          conversation.messages.reduce((n, m) => n + estimateMessageTokens(m), 0) +
          estimateTokens(activeSlot?.systemPrompt ?? '') +
          estimateTokens(conversation.summary?.text ?? '')
        return { used, total, ratio: used / total }
      })()
    : null

  const patchConvo = (partial: Partial<Conversation>): void => {
    const next = { ...conversation, ...partial }
    upsertConversation(next)
    // Ephemeral conversations are never persisted — RAM only, by design.
    if (!next.ephemeral) void window.api.saveConversation(next)
  }

  const setMode = (mode: ChatMode): void => {
    if (streaming) return
    // Default the orchestrator to the first enabled slot when switching in.
    if (mode === 'orchestrated' && !conversation.orchestratorSlotId) {
      patchConvo({ mode, orchestratorSlotId: enabledModels[0]?.id })
    } else {
      patchConvo({ mode })
    }
  }

  const slotTab = (m: ModelConfig, active: boolean, onClick: () => void): JSX.Element => (
    <button
      key={m.id}
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-xs ${
        active
          ? `${ACCENT[m.color].badge} font-medium`
          : 'text-neutral-500 hover:bg-black/5 dark:hover:bg-white/5'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ACCENT[m.color].dot}`} />
      {m.roleName}
    </button>
  )

  return (
    <div className="glass-panel m-3 mb-0 flex items-center gap-2 rounded-[20px] px-4 py-2">
      {/* Strategy toggle */}
      <div className="flex rounded-full bg-black/5 dark:bg-white/5 p-0.5 text-xs">
        {(Object.keys(MODE_LABELS) as ChatMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setMode(mode)}
            disabled={streaming}
            className={`rounded-full px-3 py-1 transition-colors ${
              conversation.mode === mode
                ? 'bg-black/10 dark:bg-white/10 shadow-sm font-medium'
                : 'text-neutral-500'
            } disabled:opacity-50`}
          >
            {MODE_LABELS[mode]}
          </button>
        ))}
      </div>

      {/* Active slot tabs (independent mode) */}
      {conversation.mode === 'independent' && (
        <div className="flex items-center gap-1 overflow-x-auto">
          {enabledModels.map((m) =>
            slotTab(m, conversation.activeModelSlotId === m.id, () =>
              patchConvo({ activeModelSlotId: m.id })
            )
          )}
          {enabledModels.length === 0 && (
            <span className="text-xs text-neutral-400">No models enabled — open Settings</span>
          )}
        </div>
      )}

      {/* Chain summary (pipeline mode) */}
      {conversation.mode === 'collaborative' && (
        <span className="text-xs text-neutral-400">
          Chain:{' '}
          {settings.pipeline
            .map((id) => settings.models.find((m) => m.id === id)?.roleName)
            .filter(Boolean)
            .join(' → ') || 'empty — configure under Settings → Pipeline'}
        </span>
      )}

      {/* Orchestrator picker (orchestrated mode) */}
      {conversation.mode === 'orchestrated' && (
        <div className="flex items-center gap-1 overflow-x-auto">
          <span className="text-xs text-neutral-400">Orchestrator:</span>
          {enabledModels.map((m) =>
            slotTab(m, conversation.orchestratorSlotId === m.id, () =>
              patchConvo({ orchestratorSlotId: m.id })
            )
          )}
          <span className="ml-1 whitespace-nowrap text-xs text-neutral-400">
            · delegates to the other {Math.max(0, enabledModels.length - 1)} enabled role(s)
          </span>
        </div>
      )}

      {/* Context meter — only when LM Studio told us the window size */}
      {contextMeter && (
        <span
          className={`ml-auto shrink-0 text-xs ${
            contextMeter.ratio > 0.9
              ? 'text-amber-600 dark:text-amber-500'
              : 'text-neutral-400'
          }`}
          title={`Estimated ${contextMeter.used.toLocaleString()} of ${contextMeter.total.toLocaleString()} tokens used. Token counts here are estimated from text length, not tokenized${
            conversation.summary ? '. Earlier messages have been summarized to fit' : ''
          }.`}
        >
          ~{formatContextLength(contextMeter.used)} / {formatContextLength(contextMeter.total)}
          {conversation.summary && ' · compacted'}
        </span>
      )}

      {/* Ephemeral indicator (v0.9) */}
      {conversation.ephemeral && (
        <span
          className={`${contextMeter ? 'ml-2' : 'ml-auto'} shrink-0 text-xs text-violet-500 dark:text-violet-400`}
          title="This chat lives only in memory. Nothing is written to disk; it is gone when you close it or quit."
        >
          ◌ ephemeral
        </span>
      )}

      {/* Memory source picker (v0.9) */}
      <div className="relative ml-2 shrink-0">
        <button
          type="button"
          onClick={toggleMemoryPicker}
          className={`rounded-lg px-2 py-1 text-xs transition-colors hover:bg-black/5 dark:hover:bg-white/10 ${
            scopedSources !== null
              ? 'text-accent-glow'
              : 'text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300'
          }`}
          title={
            scopedSources !== null
              ? `This chat recalls from ${scopedSources.length} of its memory sources`
              : 'This chat recalls from all long-term memory sources — click to scope it'
          }
        >
          📚 {scopedSources !== null ? scopedSources.length : 'All'}
        </button>
        {memoryPickerOpen && (
          <div className="glass-panel absolute right-0 top-8 z-20 w-64 rounded-2xl p-2 text-xs shadow-xl">
            <p className="px-2 pb-1.5 pt-1 font-medium text-neutral-500">
              Memory sources for this chat
            </p>
            {availableSources === null ? (
              <p className="px-2 py-1 text-neutral-400">Loading…</p>
            ) : availableSources.length === 0 ? (
              <p className="px-2 py-1 text-neutral-400">
                No sources yet — add documents under Settings → Memory.
              </p>
            ) : (
              <>
                {availableSources.map((source) => {
                  const checked = scopedSources === null || scopedSources.includes(source)
                  return (
                    <label
                      key={source}
                      className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-black/5 dark:hover:bg-white/5"
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
                  onClick={() => patchConvo({ memorySources: [] })}
                  className="mt-1 w-full rounded-lg px-2 py-1 text-left text-neutral-400 hover:bg-black/5 dark:hover:bg-white/5"
                  title="This conversation recalls nothing from long-term memory"
                >
                  ⃠ None — no memory for this chat
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setMemoryPickerOpen(false)}
              className="mt-1 w-full rounded-lg border-t border-black/10 dark:border-white/10 px-2 py-1.5 text-center text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            >
              Done
            </button>
          </div>
        )}
      </div>

      {/* Context rollback (v0.9) */}
      <button
        type="button"
        onClick={confirmRollback}
        disabled={streaming || conversation.messages.length === 0}
        className="ml-1 shrink-0 rounded-lg px-2 py-1 text-xs text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10 hover:text-neutral-600 dark:hover:text-neutral-300 disabled:opacity-40"
        title="Forget what the model remembers that you cannot see: the compacted summary and any fetched pages held in memory"
      >
        ⏪ Rollback
      </button>

      {/* Export transcript */}
      <button
        type="button"
        onClick={() => void exportMarkdown()}
        disabled={conversation.messages.length === 0}
        className="ml-1 shrink-0 rounded-lg px-2 py-1 text-xs text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10 hover:text-neutral-600 dark:hover:text-neutral-300 disabled:opacity-40"
        title="Export conversation as Markdown"
      >
        {exported ? '✓ Exported' : '⤓ Export'}
      </button>
    </div>
  )
}
