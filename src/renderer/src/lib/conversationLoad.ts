/**
 * What a load from disk is allowed to do to what the store is already holding.
 *
 * v2.0.1. `load()` ended in `setConversations(list)` — the store replaced
 * wholesale by whatever `listConversations()` returned — and it re-ran
 * whenever `settings.baseUrl` changed, which the reader can do at any moment
 * from Settings. That trigger is gone (App.tsx now waits for settings and runs
 * it once), but the trigger was never the defect: `setConversations`-from-disk
 * is, and the next thing to call `load` should inherit a safe contract rather
 * than this one. Three things the store can hold that a list of files
 * structurally cannot, and the replacement deleted all of them:
 *
 *   - **Ephemeral conversations.** The whole feature is "never written to
 *     disk", enforced in two layers so the no-trace promise survives a
 *     renderer regression (see useConversations). A list built from files
 *     cannot contain one, so every open ephemeral chat was destroyed by a
 *     change of *server address* — the one thing that has nothing to do with
 *     conversations at all.
 *   - **A turn in progress.** The assistant message being streamed into is in
 *     memory; disk holds the conversation as it stood at the end of the last
 *     turn. Replacing memory with disk drops the message, and the executor
 *     goes on patching an id the store no longer has: `patchMessage`'s
 *     `.map()` matches nothing, so tokens keep arriving and nothing appears.
 *   - **A conversation just created.** `createConversation` upserts without
 *     saving — there is nothing worth writing until the first message — so a
 *     brand-new chat exists only in memory, and `activeConversationId` was
 *     left pointing at it after it was deleted.
 *
 * The rule is the whole fix, and it needs no timestamps: **memory is never
 * behind disk.** The renderer is the only writer of these files, main persists
 * only what the renderer hands it, and every call site pairs its
 * `saveConversation` with an `upsertConversation` of the same object. So for
 * any conversation the store holds, its copy equals the file or is ahead of
 * it. Preferring memory is therefore never a loss, and is sometimes the
 * difference between keeping a turn and dropping it on the floor.
 *
 * Headless, pinned by test/conversationStore.test.ts.
 */

import type { Conversation } from '../types'

/** Newest first — the order the startup pick reads `[0]` from. */
export function byUpdatedAtDesc(a: Conversation, b: Conversation): number {
  return b.updatedAt - a.updatedAt
}

export const DEFAULT_HISTORY_LIMIT = 100

/**
 * How many conversations to keep on disk.
 *
 * Guarded here as well as on save, because this number decides what gets
 * deleted: a 0 — or a NaN from a half-typed settings field, which compares
 * false against everything and would take the `else` — prunes the entire
 * history off disk.
 */
export function historyLimit(configured: number | undefined): number {
  const n = Number(configured)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_HISTORY_LIMIT
}

export interface LoadPlan {
  /** What the store should hold afterwards. */
  keep: Conversation[]
  /** Files past the limit. Never holds a conversation that has no file. */
  prune: Conversation[]
}

/**
 * Disk and the store, reconciled — not one substituted for the other.
 *
 * The cap and the merge are decided together, in that order, because
 * separately they get the boundary wrong in both directions and the mistake is
 * invisible either way:
 *
 *   - cap the *merged* list and an ephemeral chat can push a saved
 *     conversation over the edge, deleting a file on behalf of a conversation
 *     that has none. That is this module's own defect pointed outward.
 *   - merge against the *capped* list and a conversation the cap just dropped
 *     looks exactly like one disk never had, so it is added back from memory
 *     while its file is deleted — the limit quietly stops being a limit for
 *     the rest of the session.
 *
 * So membership comes from the whole disk list and content from the capped
 * one. "Disk cannot hold this" and "disk was told to stop holding this" are
 * different facts, and only the first earns a place back in the store.
 */
export function planLoad(
  fromDisk: readonly Conversation[],
  inStore: readonly Conversation[],
  limit: number
): LoadPlan {
  const ordered = [...fromDisk].sort(byUpdatedAtDesc)
  const kept = ordered.slice(0, limit)
  const prune = ordered.slice(limit)
  const held = new Map(inStore.map((c) => [c.id, c]))
  // The full list, deliberately — see above.
  const hasAFile = new Set(fromDisk.map((c) => c.id))
  return {
    keep: [
      // Held by both: memory's copy, which is the file or something newer.
      ...kept.map((c) => held.get(c.id) ?? c),
      // Held only by memory: everything disk is structurally unable to return.
      ...inStore.filter((c) => !hasAFile.has(c.id))
    ].sort(byUpdatedAtDesc),
    prune
  }
}
