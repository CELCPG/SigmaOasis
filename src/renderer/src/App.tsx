import { useEffect } from 'react'
import { useAppStore } from './stores/appStore'
import { useModels } from './hooks/useModels'
import { useConversations } from './hooks/useConversations'
import { Sidebar } from './components/Sidebar'
import { ChatPane } from './components/ChatPane'
import { SettingsModal } from './components/SettingsModal'
import { OnboardingModal } from './components/OnboardingModal'
import { CommandPalette } from './components/CommandPalette'
import { ChatPanel, setRightPanelCollapsed } from './components/ChatPanel'
import { ProjectModal } from './components/ProjectModal'

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

  // Global shortcuts: ⌘N new conversation, ⌘, settings, ⌘B collapse the rail,
  // ⌘J collapse the chat panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === 'n') {
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
    void load()
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
