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

  /** One-shot text a component wants dropped into the composer (e.g. a prompt chip). */
  composerPrefill: string | null
  setComposerPrefill: (text: string | null) => void

  appendMessage: (conversationId: string, message: ChatMessage) => void
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
  setStreaming: (streaming) => set({ streaming }),

  composerPrefill: null,
  setComposerPrefill: (composerPrefill) => set({ composerPrefill }),

  appendMessage: (conversationId, message) =>
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId
          ? { ...c, updatedAt: Date.now(), messages: [...c.messages, message] }
          : c
      )
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
