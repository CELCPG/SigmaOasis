import { useState } from 'react'
import { useAppStore } from '../stores/appStore'
import type { ChatMode, Conversation, ModelConfig } from '../types'
import { ACCENT } from '../lib/colors'
import { conversationToMarkdown } from '../lib/exportMarkdown'
import { effectiveContextLength, formatContextLength } from '../lib/modelInfo'
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
 * for orchestrated mode.
 */
export function ModelTabs({ conversation }: Props): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const upsertConversation = useAppStore((s) => s.upsertConversation)
  const streaming = useAppStore((s) => s.streaming)
  const availableModels = useAppStore((s) => s.availableModels)
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
  const total = effectiveContextLength(
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

      {/* Export transcript */}
      <button
        type="button"
        onClick={() => void exportMarkdown()}
        disabled={conversation.messages.length === 0}
        className={`${contextMeter ? 'ml-2' : 'ml-auto'} shrink-0 rounded-lg px-2 py-1 text-xs text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10 hover:text-neutral-600 dark:hover:text-neutral-300 disabled:opacity-40`}
        title="Export conversation as Markdown"
      >
        {exported ? '✓ Exported' : '⤓ Export'}
      </button>
    </div>
  )
}
