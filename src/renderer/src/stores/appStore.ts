import { create } from 'zustand'
import type {
  AppSettings,
  ChatMessage,
  ConnectionStatus,
  Conversation,
  ModelInfo
} from '../types'

/**
 * Global renderer state (Zustand). Settings are a mirror of electron-store —
 * always persist changes through window.api.setSettings and then update here.
 * Conversations mirror the JSON files in the OS app-data directory.
 */
interface AppState {
  settings: AppSettings | null
  setSettings: (settings: AppSettings) => void

  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void

  onboardingOpen: boolean
  setOnboardingOpen: (open: boolean) => void

  connection: ConnectionStatus
  setConnection: (status: ConnectionStatus) => void

  availableModels: ModelInfo[]
  setAvailableModels: (models: ModelInfo[]) => void

  // ---- Chat -----------------------------------------------------------------

  conversations: Conversation[]
  setConversations: (conversations: Conversation[]) => void
  /** Insert a new conversation or replace the existing one with the same id. */
  upsertConversation: (conversation: Conversation) => void
  removeConversation: (id: string) => void

  activeConversationId: string | null
  setActiveConversationId: (id: string | null) => void

  streaming: boolean
  setStreaming: (streaming: boolean) => void

  /**
   * Live phase of a running deep_research call. Research takes a minute or more,
   * so without this the UI is an unexplained spinner for the whole run.
   */
  researchProgress: { phase: string; detail: string } | null
  setResearchProgress: (progress: { phase: string; detail: string } | null) => void

  /**
   * True while earlier messages are being summarized to fit the context
   * window. Compaction is a model call that happens before the reply starts,
   * so without this the turn just appears to hang.
   */
  compacting: boolean
  setCompacting: (compacting: boolean) => void

  /** One-shot text a component wants dropped into the composer (e.g. a prompt chip). */
  composerPrefill: string | null
  setComposerPrefill: (text: string | null) => void

  appendMessage: (
    conversationId: string,
    message: ChatMessage,
    options?: { retitle?: string }
  ) => void
  patchMessage: (
    conversationId: string,
    messageId: string,
    patch: Partial<ChatMessage>
  ) => void
}

export const useAppStore = create<AppState>((set) => ({
  settings: null,
  setSettings: (settings) => set({ settings }),

  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  onboardingOpen: false,
  setOnboardingOpen: (onboardingOpen) => set({ onboardingOpen }),

  connection: 'offline',
  setConnection: (connection) => set({ connection }),

  availableModels: [],
  setAvailableModels: (availableModels) => set({ availableModels }),

  conversations: [],
  setConversations: (conversations) => set({ conversations }),
  upsertConversation: (conversation) =>
    set((s) => {
      const idx = s.conversations.findIndex((c) => c.id === conversation.id)
      if (idx < 0) return { conversations: [conversation, ...s.conversations] }
      const next = [...s.conversations]
      next[idx] = conversation
      return { conversations: next }
    }),
  removeConversation: (id) =>
    set((s) => ({
      conversations: s.conversations.filter((c) => c.id !== id),
      activeConversationId: s.activeConversationId === id ? null : s.activeConversationId
    })),

  activeConversationId: null,
  setActiveConversationId: (activeConversationId) => set({ activeConversationId }),

  streaming: false,
  // Clearing progress whenever streaming stops keeps a stale phase from
  // lingering after the turn ends, however it ended.
  setStreaming: (streaming) =>
    set(streaming ? { streaming } : { streaming, researchProgress: null, compacting: false }),

  researchProgress: null,
  setResearchProgress: (researchProgress) => set({ researchProgress }),

  compacting: false,
  setCompacting: (compacting) => set({ compacting }),

  composerPrefill: null,
  setComposerPrefill: (composerPrefill) => set({ composerPrefill }),

  appendMessage: (conversationId, message, options) =>
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== conversationId) return c
        // Append and retitle in ONE immutable update. Every object here is
        // replaced rather than mutated, so a caller that appends and then
        // upserts a snapshot taken before the append silently drops the
        // message — that interleaving was the first-turn ghost bug, where a
        // new conversation's opening message never reached the model.
        const retitle =
          options?.retitle && (c.title === 'New conversation' || c.title === 'Ephemeral chat')
            ? { title: options.retitle }
            : {}
        return { ...c, ...retitle, updatedAt: Date.now(), messages: [...c.messages, message] }
      })
    })),
  patchMessage: (conversationId, messageId, patch) =>
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              updatedAt: Date.now(),
              messages: c.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m))
            }
          : c
      )
    }))
}))
