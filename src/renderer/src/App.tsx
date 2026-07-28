import { useEffect } from 'react'
import { useAppStore } from './stores/appStore'
import { useModels } from './hooks/useModels'
import { useConversations } from './hooks/useConversations'
import { Sidebar } from './components/Sidebar'
import { ModelTabs } from './components/ModelTabs'
import { ChatArea } from './components/ChatArea'
import { InputBar } from './components/InputBar'
import { SettingsModal } from './components/SettingsModal'

export default function App(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const setSettings = useAppStore((s) => s.setSettings)
  const activeConversationId = useAppStore((s) => s.activeConversationId)
  const conversation = useAppStore((s) =>
    s.conversations.find((c) => c.id === s.activeConversationId)
  )
  const { refresh } = useModels()
  const { load } = useConversations()

  // Boot: load settings, then probe LM Studio and load saved conversations.
  useEffect(() => {
    void window.api.getSettings().then((s) => setSettings(s))
  }, [setSettings])

  useEffect(() => {
    if (!settings) return
    void refresh()
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.baseUrl])

  // Theme + font size.
  useEffect(() => {
    if (!settings) return
    document.documentElement.classList.toggle('dark', settings.theme === 'dark')
    document.documentElement.style.fontSize = `${settings.fontSize}px`
  }, [settings])

  return (
    <div className="flex h-screen bg-base-light text-neutral-900 dark:bg-base-dark dark:text-neutral-100">
      <Sidebar />

      <main className="flex min-w-0 flex-1 flex-col">
        {conversation && activeConversationId ? (
          <>
            <ModelTabs conversation={conversation} />
            <ChatArea conversation={conversation} />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center p-8">
            <div className="max-w-md text-center text-sm text-neutral-500">
              <p className="mb-2 text-4xl">🧠</p>
              <p className="font-medium text-neutral-700 dark:text-neutral-300">
                Welcome to OpenMind
              </p>
              <p className="mt-2">
                A private, local-first AI chat powered by LM Studio. Click{' '}
                <span className="font-medium">+ New</span> to start a conversation.
              </p>
            </div>
          </div>
        )}
        <InputBar />
      </main>

      <SettingsModal />
    </div>
  )
}
