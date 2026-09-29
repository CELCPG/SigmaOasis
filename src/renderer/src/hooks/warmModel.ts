import { useAppStore } from '../stores/appStore'
import { agentSlot } from './agentTasks'

/**
 * v3.1: start loading the model while the reader is still typing.
 *
 * A model LM Studio no longer holds — unloaded by JIT loading's idle TTL, by a
 * restart, by another model loaded in its place — is loaded again by the
 * turn's first request, so the reader waits out the whole load after pressing
 * Enter. Measured on 2026-09-28: a "hello" to a 27B waited 60 s for its first
 * token. Every turn already pins its model before anything else runs
 * (useLMStudio.ts), and a pin is one promise per server and model
 * (main/ipc/modelPin.ts), so asking for it at the first keystroke moves that
 * same load earlier: the turn's own pin then finds it finished, or joins it in
 * flight. The model is the one the turn would have loaded seconds later.
 *
 * Which model: the composer's own resolution (InputBar.tsx, and
 * turnContextUsage in turnHelpers.ts) — the conversation's slot if it is still
 * enabled, else the first enabled one — or, in an agent chat, the task's slot.
 * Routing may still send the turn elsewhere; then this was a guess, and the
 * turn pins its own model as it always has.
 *
 * At most once per model per interval. On a resident model the pin costs one
 * loopback GET, and a message's first keystroke should not cost even that
 * twice in a row.
 */

const WARM_INTERVAL_MS = 15_000
const lastWarmed = new Map<string, number>()

/** The model a message typed now in `conversationId` would most likely run on. */
export function composerModelId(conversationId: string | null): string | null {
  const { settings, conversations } = useAppStore.getState()
  if (!settings) return null
  const convo = conversations.find((c) => c.id === conversationId)
  const slot = convo?.agent
    ? agentSlot(convo, settings.models)
    : (settings.models.find((m) => m.id === convo?.activeModelSlotId && m.enabled) ??
      settings.models.find((m) => m.enabled))
  return slot?.modelId?.trim() || null
}

/** Ask LM Studio to have the composer's model resident. Never blocks, never throws. */
export function warmComposerModel(conversationId: string | null, now: number = Date.now()): void {
  const model = composerModelId(conversationId)
  if (!model) return
  if (now - (lastWarmed.get(model) ?? -Infinity) < WARM_INTERVAL_MS) return
  lastWarmed.set(model, now)
  void window.api.pinModel(model).catch(() => false)
}
