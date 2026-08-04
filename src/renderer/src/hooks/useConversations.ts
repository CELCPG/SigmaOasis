import { useCallback } from 'react'
import { useAppStore } from '../stores/appStore'
import type { Conversation } from '../types'

function byUpdatedAtDesc(a: Conversation, b: Conversation): number {
  return b.updatedAt - a.updatedAt
}

/**
 * Conversation persistence: loads saved conversations from disk on startup,
 * and creates / selects / deletes them. Saving after a chat turn is handled
 * by useLMStudio; this hook also enforces settings.historyLimit on load.
 */
export function useConversations(): {
  load: () => Promise<void>
  createConversation: () => void
  selectConversation: (id: string) => void
  removeConversation: (id: string) => Promise<void>
  renameConversation: (id: string, title: string) => Promise<void>
} {
  const load = useCallback(async (): Promise<void> => {
    const store = useAppStore.getState()
    const list = (await window.api.listConversations().catch(() => [])) as Conversation[]
    list.sort(byUpdatedAtDesc)

    // Enforce the history limit: drop the oldest beyond the cap, on disk too.
    // Guard the value here as well as on save — a 0 or NaN would prune every
    // conversation off disk.
    const configured = Number(store.settings?.historyLimit)
    const limit = Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 100
    const keep = list.slice(0, limit)
    for (const stale of list.slice(limit)) {
      void window.api.deleteConversation(stale.id)
    }

    store.setConversations(keep)
    if (!store.activeConversationId && keep.length > 0) {
      store.setActiveConversationId(keep[0].id)
    }
  }, [])

  const createConversation = useCallback((branchFromMessageId?: string): void => {
    const store = useAppStore.getState()
    const convo: Conversation = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
      title: 'New conversation',
      mode: 'independent',
      activeModelSlotId: store.settings?.models.find((m) => m.enabled)?.id,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      branches: branchFromMessageId ? [{ messageId: branchFromMessageId, branchId: convo.id, title: 'Branch' }] : [],
      activeBranchId: null
    }
    store.upsertConversation(convo)
    store.setActiveConversationId(convo.id)
  }, [])

  const selectConversation = useCallback((id: string): void => {
    useAppStore.getState().setActiveConversationId(id)
  }, [])

  const removeConversation = useCallback(async (id: string): Promise<void> => {
    useAppStore.getState().removeConversation(id)
    await window.api.deleteConversation(id).catch(() => undefined)
  }, [])

  const renameConversation = useCallback(async (id: string, title: string): Promise<void> => {
    const trimmed = title.trim()
    if (!trimmed) return
    const store = useAppStore.getState()
    const convo = store.conversations.find((c) => c.id === id)
    if (!convo || convo.title === trimmed) return
    const updated = { ...convo, title: trimmed }
    store.upsertConversation(updated)
    await window.api.saveConversation(updated).catch(() => undefined)
  }, [])

  return { load, createConversation, selectConversation, removeConversation, renameConversation }
}
