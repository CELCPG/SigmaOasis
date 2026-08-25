import { create } from 'zustand'
import type {
  AppSettings,
  ChatMessage,
  ConnectionStatus,
  Conversation,
  ModelInfo
} from '../types'
import type { TurnPhase } from '../lib/turnPhase'
import type { SettingsTarget } from '../../../shared/failure'

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
  /**
   * The tab Settings should land on when it opens, or null for wherever it was.
   *
   * v1.17.2: a failure sentence that says "Point Settings → Search at a working
   * provider" is a remedy the reader has to go and find. Where the app has
   * PROVEN which setting is wrong, it offers the place instead of describing
   * it — and the place has to be reachable from a button, which needs this.
   * Cleared by SettingsModal once it has honoured it, so a later manual open
   * does not jump somewhere the reader did not ask for.
   */
  settingsTab: SettingsTarget | null
  openSettingsAt: (tab: SettingsTarget) => void
  clearSettingsTab: () => void

  onboardingOpen: boolean
  setOnboardingOpen: (open: boolean) => void

  /** v1.10: the project whose editor is open, or null. */
  projectEditorId: string | null
  setProjectEditorId: (id: string | null) => void

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

  /**
   * The FOCUSED conversation. Everything that acts — the composer, the chat
   * panel, every turn entry point in useLMStudio — reads this and only this,
   * which is why split view costs the turn machinery nothing.
   */
  activeConversationId: string | null
  setActiveConversationId: (id: string | null) => void

  /**
   * v1.11 split view: the conversation in the *other* pane, or null when the
   * split is closed. Never equal to activeConversationId — the same chat twice
   * is two views of one scroll position and no use to anybody.
   */
  splitConversationId: string | null
  /**
   * Which side the unfocused pane sits on. Focus moves between panes by
   * swapping the two ids and flipping this, so the chat you were reading stays
   * where it was on screen while `activeConversationId` keeps meaning "focused".
   */
  splitOnLeft: boolean
  /** Open `id` beside the current chat and focus it. No-op if it is already the focused chat. */
  openSplit: (id: string) => void
  /** Close the split, keeping the focused chat. */
  closeSplit: () => void
  /** Focus the other pane: swap the ids, flip the side, so nothing moves on screen. */
  focusOtherPane: () => void

  streaming: boolean
  setStreaming: (streaming: boolean) => void

  /**
   * Live phase of a running deep_research call. Research takes a minute or more,
   * so without this the UI is an unexplained spinner for the whole run.
   */
  researchProgress: { phase: string; detail: string } | null
  setResearchProgress: (progress: { phase: string; detail: string } | null) => void

  /**
   * The named stage of the in-flight turn (lib/turnPhase.ts): the pre-model
   * wait a context provider is in, or the post-answer check that is running.
   * It names the wait, and — because `streaming` stays true through the
   * checks — it is also what tells a finished bubble that its answer is done
   * and can be acted on.
   */
  turnPhase: TurnPhase | null
  setTurnPhase: (phase: TurnPhase | null) => void

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

  /**
   * The live text of the message currently being streamed. Tokens land here —
   * a two-field object replace — instead of in `conversations`, so a token
   * re-renders exactly one subscriber (the streaming bubble) rather than every
   * component holding the conversations array. While set, the bubble displays
   * this text in place of its message's committed content; the accumulated
   * content is committed through patchMessage at round and stream boundaries,
   * and the tail is cleared when the turn ends.
   */
  streamingTail: { messageId: string; text: string } | null
  setStreamingTail: (tail: { messageId: string; text: string } | null) => void

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

  settingsTab: null,
  openSettingsAt: (settingsTab) => set({ settingsTab, settingsOpen: true }),
  clearSettingsTab: () => set({ settingsTab: null }),

  onboardingOpen: false,
  setOnboardingOpen: (onboardingOpen) => set({ onboardingOpen }),

  projectEditorId: null,
  setProjectEditorId: (projectEditorId) => set({ projectEditorId }),

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
    set((s) => {
      // A deleted chat must not survive in either pane. When the focused one
      // goes, the split pane is promoted rather than leaving an empty pane
      // beside a live one.
      if (s.activeConversationId === id) {
        return {
          conversations: s.conversations.filter((c) => c.id !== id),
          activeConversationId: s.splitConversationId,
          splitConversationId: null,
          splitOnLeft: false
        }
      }
      return {
        conversations: s.conversations.filter((c) => c.id !== id),
        ...(s.splitConversationId === id ? { splitConversationId: null, splitOnLeft: false } : {})
      }
    }),

  activeConversationId: null,
  // Selecting the chat that is already in the other pane focuses that pane
  // rather than showing it twice.
  setActiveConversationId: (activeConversationId) =>
    set((s) =>
      activeConversationId !== null && activeConversationId === s.splitConversationId
        ? {
            activeConversationId,
            splitConversationId: s.activeConversationId,
            splitOnLeft: !s.splitOnLeft
          }
        : { activeConversationId }
    ),

  splitConversationId: null,
  splitOnLeft: false,
  openSplit: (id) =>
    set((s) => {
      if (id === s.activeConversationId) return {}
      // The chat already on screen keeps its side; the new one takes the other
      // and the focus.
      return {
        activeConversationId: id,
        splitConversationId: s.activeConversationId,
        splitOnLeft: !s.splitOnLeft
      }
    }),
  closeSplit: () => set({ splitConversationId: null, splitOnLeft: false }),
  focusOtherPane: () =>
    set((s) =>
      s.splitConversationId === null
        ? {}
        : {
            activeConversationId: s.splitConversationId,
            splitConversationId: s.activeConversationId,
            splitOnLeft: !s.splitOnLeft
          }
    ),

  streaming: false,
  // Clearing progress whenever streaming stops keeps a stale phase from
  // lingering after the turn ends, however it ended.
  setStreaming: (streaming) =>
    set(
      streaming
        ? { streaming }
        : { streaming, researchProgress: null, compacting: false, turnPhase: null }
    ),

  researchProgress: null,
  setResearchProgress: (researchProgress) => set({ researchProgress }),

  turnPhase: null,
  setTurnPhase: (turnPhase) => set({ turnPhase }),

  compacting: false,
  setCompacting: (compacting) => set({ compacting }),

  composerPrefill: null,
  setComposerPrefill: (composerPrefill) => set({ composerPrefill }),

  streamingTail: null,
  setStreamingTail: (streamingTail) => set({ streamingTail }),

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
