import { useCallback } from 'react'
import { useAppStore } from '../stores/appStore'
import type { Conversation } from '../types'
import { conversationDefaultsFromProject } from '../lib/projectContext'
import { abandonOrphanedPlans } from '../lib/planState'
import { historyLimit, planLoad } from '../lib/conversationLoad'
import { livePlans } from './planMode'

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
 *
 * v2.0.1: load reconciles with the store instead of replacing it, and settles
 * the plans it finds abandoned. Both come from the same place — this used to
 * re-run on every base-URL change, so it happened *during* a session and not
 * only at the start of one. App.tsx no longer triggers it that way; these two
 * make it survivable if anything ever does again. See `planLoad` for what the
 * store may be holding that disk cannot return, and `abandonOrphanedPlans` for
 * what disk may be holding that no process is behind any more.
 */
export function useConversations(): {
  load: () => Promise<void>
  createConversation: (options?: {
    ephemeral?: boolean
    branchFromMessageId?: string
    /** v1.10: file the new chat under a project from the start. */
    projectId?: string | null
  }) => Conversation
  selectConversation: (id: string) => void
  removeConversation: (id: string) => Promise<void>
  renameConversation: (id: string, title: string) => Promise<void>
  patchConversation: (id: string, partial: Partial<Conversation>) => void
  rollbackContext: (id: string) => Promise<void>
} {
  const load = useCallback(async (): Promise<void> => {
    const store = useAppStore.getState()
    const list = (await window.api.listConversations().catch(() => [])) as Conversation[]

    // The history limit and the reconciliation, decided together. The store
    // can be holding an ephemeral chat, a turn being streamed into, or a
    // conversation created a moment ago — none of which disk is able to
    // return, and none of which may count against a cap on files. See planLoad
    // for why those two decisions cannot be taken separately.
    const { keep: merged, prune } = planLoad(
      list,
      store.conversations,
      historyLimit(store.settings?.historyLimit)
    )
    for (const stale of prune) {
      void window.api.deleteConversation(stale.id)
    }

    // A plan still claiming a live executor — waiting to be approved, or
    // running — when no executor is behind it was abandoned by the app, not
    // paused by the reader: settle it before it can render controls that
    // resolve nothing or a step that pulses forever. `livePlans` is what this
    // process is genuinely working on, so a plan that really is live is left
    // exactly as it is — as is, now, the whole in-memory conversation carrying
    // it. Two independent reasons, kept independent: one is about a plan's
    // executor, the other about what a file can hold, and neither is the
    // other's backstop.
    const keep = abandonOrphanedPlans(merged, livePlans)
    // Nothing is written back here. The sweep is a pure function of what is on
    // disk, so it re-derives identically on every load; the settled plan
    // reaches the file with the conversation's next ordinary save.

    store.setConversations(keep)
    if (!store.activeConversationId && keep.length > 0) {
      store.setActiveConversationId(keep[0].id)
    }
  }, [])

  const createConversation = useCallback(
    (options?: {
      ephemeral?: boolean
      branchFromMessageId?: string
      projectId?: string | null
    }): Conversation => {
      const store = useAppStore.getState()
      // The id is needed inside `branches` below, so it is bound before the
      // literal rather than read back off `convo` mid-initialisation.
      const id = uid()
      const branchFrom = options?.branchFromMessageId
      // v1.10: a chat started inside a project takes the project's defaults
      // (strategy, role, memory scope). A branch copies its parent instead —
      // BranchMenu patches those fields right after — so defaults only apply
      // to genuinely new chats.
      const project =
        options?.projectId && !branchFrom
          ? store.settings?.projects.find((p) => p.id === options.projectId) ?? null
          : null
      const enabledSlotIds = (store.settings?.models ?? []).filter((m) => m.enabled).map((m) => m.id)
      const convo: Conversation = {
        id,
        title: options?.ephemeral ? 'Ephemeral chat' : 'New conversation',
        mode: 'independent',
        activeModelSlotId: enabledSlotIds[0],
        messages: [],
        ...conversationDefaultsFromProject(project, enabledSlotIds),
        ...(options?.ephemeral ? { ephemeral: true } : {}),
        ...(options?.projectId ? { projectId: options.projectId } : {}),
        ...(branchFrom
          ? {
              branches: [{ messageId: branchFrom, branchId: id, title: 'Alternative response' }],
              activeBranchId: id
            }
          : {}),
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      store.upsertConversation(convo)
      store.setActiveConversationId(id)
      return convo
    },
    []
  )

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
