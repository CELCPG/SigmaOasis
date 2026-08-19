import { useEffect } from 'react'
import { useAppStore } from './stores/appStore'
import { useModels } from './hooks/useModels'
import { useConversations } from './hooks/useConversations'
import { Sidebar } from './components/Sidebar'
import { ChatArea } from './components/ChatArea'
import { InputBar } from './components/InputBar'
import { EmptyState } from './components/EmptyState'
import { SettingsModal } from './components/SettingsModal'
import { OnboardingModal } from './components/OnboardingModal'
import { CommandPalette } from './components/CommandPalette'
import { ChatPanel, setRightPanelCollapsed } from './components/ChatPanel'
import { ProjectModal } from './components/ProjectModal'

export default function App(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const setSettings = useAppStore((s) => s.setSettings)
  const activeConversationId = useAppStore((s) => s.activeConversationId)
  const conversation = useAppStore((s) =>
    s.conversations.find((c) => c.id === s.activeConversationId)
  )
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
  useEffect(() => {
    if (!settings) return
    document.documentElement.classList.toggle('dark', settings.theme === 'dark')
    document.documentElement.style.fontSize = `${settings.fontSize}px`
  }, [settings])

  return (
    <div className="relative flex h-screen bg-base-light text-neutral-900 dark:bg-base-dark dark:text-neutral-100">
      <div className="ambient-orbs" aria-hidden="true" />
      <Sidebar />

      <main className="relative z-10 flex min-w-0 flex-1 flex-col">
        {conversation && activeConversationId ? (
          <ChatArea conversation={conversation} />
        ) : (
          // No conversation yet — a starter opens one, then fills the composer.
          <EmptyState
            heading="Welcome to Sigma Oasis"
            onPick={(prompt) => {
              createConversation()
              useAppStore.getState().setComposerPrefill(prompt)
            }}
          />
        )}
        <InputBar />
      </main>

      <ChatPanel />

      <SettingsModal />
      <ProjectModal />
      <OnboardingModal />
      <CommandPalette />
    </div>
  )
}
