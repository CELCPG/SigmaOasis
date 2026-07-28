import { useState } from 'react'
import { useAppStore } from '../stores/appStore'
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

/**
 * Top bar above the chat: pick the strategy (Independent / Pipeline /
 * Orchestrated), the active slot for independent mode, or the orchestrator
 * for orchestrated mode.
 */
export function ModelTabs({ conversation }: Props): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const upsertConversation = useAppStore((s) => s.upsertConversation)
  const streaming = useAppStore((s) => s.streaming)
  const [exported, setExported] = useState(false)

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

  if (!settings) return <div className="h-12 border-b border-black/10 dark:border-white/10" />

  const enabledModels = settings.models.filter((m) => m.enabled)

  const patchConvo = (partial: Partial<Conversation>): void => {
    const next = { ...conversation, ...partial }
    upsertConversation(next)
    void window.api.saveConversation(next)
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
    <div className="flex items-center gap-2 border-b border-black/10 dark:border-white/10 px-4 py-2">
      {/* Strategy toggle */}
      <div className="flex rounded-lg bg-black/5 dark:bg-white/10 p-0.5 text-xs">
        {(Object.keys(MODE_LABELS) as ChatMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setMode(mode)}
            disabled={streaming}
            className={`rounded-md px-3 py-1 ${
              conversation.mode === mode
                ? 'bg-white dark:bg-neutral-700 shadow-sm font-medium'
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

      {/* Export transcript */}
      <button
        type="button"
        onClick={() => void exportMarkdown()}
        disabled={conversation.messages.length === 0}
        className="ml-auto shrink-0 rounded-lg px-2 py-1 text-xs text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10 hover:text-neutral-600 dark:hover:text-neutral-300 disabled:opacity-40"
        title="Export conversation as Markdown"
      >
        {exported ? '✓ Exported' : '⤓ Export'}
      </button>
    </div>
  )
}
