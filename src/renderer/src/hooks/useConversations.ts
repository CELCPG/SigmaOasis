import { useCallback } from 'react'
import { useAppStore } from '../stores/appStore'
import type { Conversation } from '../types'

function byUpdatedAtDesc(a: Conversation, b: Conversation): number {
  return b.updatedAt - a.updatedAt
}

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

/**
 * Conversation persistence: loads saved conversations from disk on startup,
 * and creates / selects / deletes them. Saving after a chat turn is handled
 * by useLMStudio; this hook also enforces settings.historyLimit on load.
 *
 * v0.9: conversations can be ephemeral (RAM-only). The main process refuses
 * to persist them, so every save/delete call here skips them too — two
 * layers, because the no-trace promise should survive a renderer regression.
 */
export function useConversations(): {
  load: () => Promise<void>
  createConversation: (options?: { ephemeral?: boolean }) => void
  selectConversation: (id: string) => void
  removeConversation: (id: string) => Promise<void>
  renameConversation: (id: string, title: string) => Promise<void>
  patchConversation: (id: string, partial: Partial<Conversation>) => void
  rollbackContext: (id: string) => Promise<void>
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

  const createConversation = useCallback((options?: { ephemeral?: boolean }): void => {
    const store = useAppStore.getState()
    const convo: Conversation = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
      title: options?.ephemeral ? 'Ephemeral chat' : 'New conversation',
      mode: 'independent',
      activeModelSlotId: store.settings?.models.find((m) => m.enabled)?.id,
      messages: [],
      ...(options?.ephemeral ? { ephemeral: true } : {}),
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    store.upsertConversation(convo)
    store.setActiveConversationId(convo.id)
  }, [])

  const selectConversation = useCallback((id: string): void => {
    useAppStore.getState().setActiveConversationId(id)
  }, [])

  const removeConversation = useCallback(async (id: string): Promise<void> => {
    const convo = useAppStore.getState().conversations.find((c) => c.id === id)
    useAppStore.getState().removeConversation(id)
    // Ephemeral conversations never touched disk — there is no file to delete.
    if (!convo?.ephemeral) await window.api.deleteConversation(id).catch(() => undefined)
  }, [])

  const renameConversation = useCallback(async (id: string, title: string): Promise<void> => {
    const trimmed = title.trim()
    if (!trimmed) return
    const store = useAppStore.getState()
    const convo = store.conversations.find((c) => c.id === id)
    if (!convo || convo.title === trimmed) return
    const updated = { ...convo, title: trimmed }
    store.upsertConversation(updated)
    if (!convo.ephemeral) await window.api.saveConversation(updated).catch(() => undefined)
  }, [])

  /**
   * Merge a partial into one conversation and persist it. Used by the session
   * controls in the sidebar for mode, active slot, orchestrator and memory
   * scope. Ephemeral conversations are never written to disk, by design.
   */
  const patchConversation = useCallback((id: string, partial: Partial<Conversation>): void => {
    const store = useAppStore.getState()
    const convo = store.conversations.find((c) => c.id === id)
    if (!convo) return
    const next = { ...convo, ...partial }
    store.upsertConversation(next)
    if (!next.ephemeral) void window.api.saveConversation(next)
  }, [])

  /**
   * v0.9 context rollback: forget everything the model remembers that the user
   * cannot see — the compaction summary and the RAM research index — while
   * leaving the visible messages, notes and long-term memory untouched. A
   * marker message records the rollback in chat (it is display-only and never
   * reaches the wire history).
   */
  const rollbackContext = useCallback(async (id: string): Promise<void> => {
    const store = useAppStore.getState()
    const convo = store.conversations.find((c) => c.id === id)
    if (!convo) return

    const dropped: string[] = []
    if (convo.summary) dropped.push('the summary of earlier messages')
    let cleared = { pages: 0 }
    try {
      cleared = await window.api.clearResearchIndex()
    } catch {
      // A failed clear still rolls back the summary; say what happened.
    }
    if (cleared.pages > 0) {
      dropped.push(`${cleared.pages} fetched page${cleared.pages === 1 ? '' : 's'} held in memory`)
    }

    const next: Conversation = { ...convo, summary: undefined }
    store.upsertConversation(next)
    store.appendMessage(id, {
      id: uid(),
      role: 'assistant',
      content:
        dropped.length > 0
          ? `⏪ Context rolled back — the model no longer sees ${dropped.join(' or ')}. Visible messages above are unchanged; notes and long-term memory were not touched.`
          : '⏪ Context rolled back — there was no summary or fetched page in memory to drop. Visible messages are unchanged.',
      marker: 'rollback',
      createdAt: Date.now()
    })
    const final = useAppStore.getState().conversations.find((c) => c.id === id)
    if (final && !final.ephemeral) void window.api.saveConversation(final)
  }, [])

  return {
    load,
    createConversation,
    selectConversation,
    removeConversation,
    renameConversation,
    patchConversation,
    rollbackContext
  }
}
