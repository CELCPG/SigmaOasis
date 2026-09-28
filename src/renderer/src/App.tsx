import { useEffect } from 'react'
import { useAppStore } from './stores/appStore'
import { useModels } from './hooks/useModels'
import { useConversations } from './hooks/useConversations'
import { uid } from './hooks/turnHelpers'
import { Sidebar } from './components/Sidebar'
import { ChatPane } from './components/ChatPane'
import { SettingsModal } from './components/SettingsModal'
import { OnboardingModal } from './components/OnboardingModal'
import { CommandPalette } from './components/CommandPalette'
import { ChatPanel, setRightPanelCollapsed } from './components/ChatPanel'
import { ProjectModal } from './components/ProjectModal'
import { VibeView } from './components/vibe/VibeView'
import { setVibeMode } from './hooks/vibeMode'
import { handleAgentEvent, syncAgentRuns } from './hooks/agentTasks'
import { isVibeToggle } from './lib/vibe'

/** Hairline between the two panes; purely visual, so it is hidden from the tree. */
function PaneDivider(): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="my-4 w-px shrink-0 bg-gradient-to-b from-transparent via-black/10 to-transparent dark:via-white/10"
    />
  )
}

export default function App(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const setSettings = useAppStore((s) => s.setSettings)
  const activeConversationId = useAppStore((s) => s.activeConversationId)
  const splitConversationId = useAppStore((s) => s.splitConversationId)
  const splitOnLeft = useAppStore((s) => s.splitOnLeft)
  const { refresh } = useModels()
  const { load, createConversation } = useConversations()

  // Boot: load settings, then probe LM Studio and load saved conversations.
  useEffect(() => {
    void window.api.getSettings().then((s) => {
      setSettings(s)
      if (!s.onboardingCompleted) useAppStore.getState().setOnboardingOpen(true)
    })
  }, [setSettings])

  // Live phase updates from a running deep_research call.
  useEffect(() => {
    return window.api.onResearchProgress((update) =>
      useAppStore.getState().setResearchProgress(update)
    )
  }, [])

  // v3.0: an agent task reports from the main process; each event folds into
  // its message, and the conversation is saved when the task ends.
  useEffect(() => window.api.onAgentEvent(handleAgentEvent), [])

  // v3.0: a finished task's notification was clicked — open its conversation.
  useEffect(
    () =>
      window.api.onAgentFocus((id) => {
        const s = useAppStore.getState()
        if (s.conversations.some((c) => c.id === id)) {
          if (s.settings?.vibeMode) setVibeMode(false)
          s.setActiveConversationId(id)
        }
      }),
    []
  )

  // v2.8: a proposed patch's diff arrives for review and waits in the store
  // until the reader applies or discards it under the tool call that made it.
  useEffect(() => {
    return window.api.onPatchReview((review) => useAppStore.getState().addPatchReview(review))
  }, [])

  // v2.6: a standing question's digest lands in its own conversation — created
  // on the first delivery, appended to after — and is saved like any turn.
  useEffect(() => {
    return window.api.onJobDigest((digest) => {
      const store = useAppStore.getState()
      let convo = store.conversations.find((c) => c.id === digest.conversationId)
      if (!convo) {
        const enabled = (store.settings?.models ?? []).filter((m) => m.enabled).map((m) => m.id)
        convo = {
          id: digest.conversationId,
          title: `📬 ${digest.title}`,
          mode: 'independent',
          activeModelSlotId: enabled[0],
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
        store.upsertConversation(convo)
      }
      store.appendMessage(digest.conversationId, {
        id: uid(),
        role: 'assistant',
        content: digest.content,
        marker: 'digest',
        createdAt: Date.now()
      })
      const final = useAppStore.getState().conversations.find((c) => c.id === digest.conversationId)
      if (final) void window.api.saveConversation(final)
    })
  }, [])

  // Global shortcuts: ⌘N new conversation, ⌘, settings, ⌘B collapse the rail,
  // ⌘J collapse the chat panel, ⌘⇧L enter or leave VIBE.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (isVibeToggle(e)) {
        e.preventDefault()
        setVibeMode(!useAppStore.getState().settings?.vibeMode)
      } else if (e.key === 'n') {
        e.preventDefault()
        createConversation()
      } else if (e.key === ',') {
        e.preventDefault()
        useAppStore.getState().setSettingsOpen(true)
      } else if (e.key === 'b') {
        e.preventDefault()
        const current = useAppStore.getState().settings
        if (!current) return
        const updated = { ...current, sidebarCollapsed: !current.sidebarCollapsed }
        useAppStore.getState().setSettings(updated)
        void window.api.setSettings(updated)
      } else if (e.key === 'j') {
        e.preventDefault()
        const current = useAppStore.getState().settings
        if (!current) return
        setRightPanelCollapsed(!current.rightPanelCollapsed)
      } else if (e.key === '\\') {
        // ⌘\ toggles split view, the way editors have meant it for years.
        // Opening picks the most recently touched *other* chat, so the shortcut
        // does something useful on its own rather than opening an empty pane.
        e.preventDefault()
        const s = useAppStore.getState()
        if (s.splitConversationId) {
          s.closeSplit()
          return
        }
        const next = [...s.conversations]
          .filter((c) => c.id !== s.activeConversationId)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0]
        if (next) s.openSplit(next.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [createConversation])

  // Keyed on baseUrl alone — settings changes identity on every save, and a
  // font-size change must not re-probe the server or reload conversations.
  // `null` (settings not loaded yet) is distinct from '' (loaded, no URL).
  const baseUrl = settings ? settings.baseUrl : null
  useEffect(() => {
    if (baseUrl === null) return
    void refresh()
    // v3.0: once the conversations are in, relearn the agent tasks the main
    // process is still running and settle the ones that died with a restart.
    void load().then(() => syncAgentRuns())
  }, [baseUrl, refresh, load])

  // Theme + font size.
  //
  // The theme flips with every colour transition suspended (v2.3). Buttons and
  // rows carry Tailwind's `transition-colors`, so a theme change starts a
  // 150ms colour transition on each of them — and a transition only advances
  // when the compositor ticks. Behind another window it does not, and the
  // head-to-head's dark-theme capture found tool-call headers, the selected
  // conversation and the Rollback/Export actions still drawn in the LIGHT
  // theme's ink 700ms after the switch: dark on dark, 1.05:1. Measured on both
  // Electron 31 and 44, so it is the app's to fix, not the runtime's. The
  // class below turns transitions off for the two frames the switch takes;
  // everything the user does afterwards animates as before.
  useEffect(() => {
    if (!settings) return
    const root = document.documentElement
    const dark = settings.theme === 'dark'
    if (root.classList.contains('dark') !== dark) {
      root.classList.add('theme-switching')
      root.classList.toggle('dark', dark)
      void root.offsetHeight // flush the switch with transitions still off
      requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')))
    }
    root.style.fontSize = `${settings.fontSize}px`
  }, [settings])

  // v3.0: VIBE replaces the whole layout — rail, panes and chat panel — with
  // the conversation alone. The surfaces a reader summons (Settings, the
  // palette, the setup checklist) still open over it.
  if (settings?.vibeMode) {
    return (
      <>
        <VibeView />
        <SettingsModal />
        <ProjectModal />
        <OnboardingModal />
        <CommandPalette />
      </>
    )
  }

  return (
    <div className="relative flex h-screen bg-base-light text-ink-primary dark:bg-base-dark">
      <div className="ambient-orbs" aria-hidden="true" />
      <Sidebar />

      {/*
        One pane, or two side by side (⌘\). `splitOnLeft` decides which side the
        unfocused chat is on, so focusing a pane swaps ids underneath without
        anything moving on screen.
      */}
      <main className="relative z-10 flex min-w-0 flex-1 flex-row">
        {splitConversationId && splitOnLeft && (
          <>
            <ChatPane conversationId={splitConversationId} focused={false} split />
            <PaneDivider />
          </>
        )}
        <ChatPane
          conversationId={activeConversationId}
          focused
          split={Boolean(splitConversationId)}
        />
        {splitConversationId && !splitOnLeft && (
          <>
            <PaneDivider />
            <ChatPane conversationId={splitConversationId} focused={false} split />
          </>
        )}
      </main>

      <ChatPanel />

      <SettingsModal />
      <ProjectModal />
      <OnboardingModal />
      <CommandPalette />
    </div>
  )
}
