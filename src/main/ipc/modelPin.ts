import { ipcMain } from 'electron'
import { auditedFetch } from './net'
import { getSettings } from './store'

/**
 * Keep the chat model resident in LM Studio while the app is using it.
 *
 * The problem this solves: Sigma Oasis alternates between the chat model and
 * an embedding model (long-term memory, the research index). Both are usually
 * loaded just-in-time by API requests, and LM Studio's default "only keep the
 * last JIT-loaded model" auto-evict unloads the previous JIT model every time
 * a new one loads. A research round — embed pages, then ask the model to
 * reflect — therefore paid two full model reloads per round: nomic in, gemma
 * out; gemma in, nomic out. On a 12B model that is ~7 seconds and a fresh
 * llama_server process per round, for nothing.
 *
 * The lever LM Studio offers: models loaded through its explicit load
 * endpoint count as manually loaded, and auto-evict exempts manually loaded
 * models. So the chat model is loaded explicitly, once per session, the first
 * time it is about to be used.
 *
 * Two LM Studio generations are supported:
 *   - newer: POST /api/v0/models/load { model, ttl } — the TTL rides along,
 *     so the pin self-cleans after an hour idle. Nothing more to do.
 *   - older: POST /api/v1/models/load { model } — no TTL support, so these
 *     pins are recorded and undone with /api/v1/models/unload when the app
 *     quits, restoring whatever state LM Studio was in before we arrived.
 *
 * A model that was already loaded when we checked is left alone both times:
 * we neither pin nor unload it — it was the user's, not ours.
 *
 * Everything here is best-effort housekeeping. An LM Studio without either
 * endpoint just keeps JIT loading, exactly as before.
 */

/** A cold load of a large model can take minutes; the pin waits for it. */
const PIN_TIMEOUT_MS = 600_000
/** Quit-time unloads must not hold the process open. */
const UNLOAD_TIMEOUT_MS = 5_000

/** LM Studio's REST API root: settings.baseUrl ends in /v1; REST lives at /api. */
export function restApiRoot(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return base.endsWith('/v1') ? base.slice(0, -'/v1'.length) : base
}

/** One in-flight or settled pin per server+model, so a turn pins at most once. */
const attempts = new Map<string, Promise<void>>()

/**
 * Models this process loaded through the legacy (TTL-less) endpoint, keyed by
 * LM Studio's instance id. Unloaded on quit — see the module docstring.
 */
const legacyPins = new Set<string>()

/** Is `model` already resident, per LM Studio's model list? */
async function isAlreadyLoaded(root: string, model: string): Promise<boolean> {
  try {
    const res = await auditedFetch(`${root}/api/v0/models`, { timeoutMs: 10_000 }, 'lmstudio')
    if (!res.ok) return false
    const data = (await res.json()) as { data?: { id: string; state?: string }[] }
    return data.data?.some((m) => m.id === model && m.state === 'loaded') ?? false
  } catch {
    return false
  }
}

async function postLoad(url: string, body: Record<string, unknown>): Promise<'ok' | 'missing' | 'failed'> {
  try {
    const res = await auditedFetch(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: PIN_TIMEOUT_MS
      },
      'lmstudio'
    )
    if (res.ok) return 'ok'
    if (res.status === 404) return 'missing'
    const text = await res.text().catch(() => '')
    // Older servers answer an unknown route with 200-less JSON rather than a
    // bare 404 ("Unexpected endpoint or method").
    if (text.includes('Unexpected endpoint')) return 'missing'
    return 'failed'
  } catch {
    return 'failed'
  }
}

/**
 * Explicitly load `model` in LM Studio so auto-evict leaves it alone.
 * Memoized per server+model; resolves either way — pinning must never block
 * or break a conversation.
 */
export function pinChatModel(model: string): Promise<void> {
  const trimmed = model.trim()
  if (!trimmed) return Promise.resolve()

  const settings = getSettings()
  const root = restApiRoot(settings.baseUrl)
  const key = `${root}::${trimmed}`
  const existing = attempts.get(key)
  if (existing) return existing

  const attempt = (async () => {
    // Resident already (user loaded it, or we did earlier): nothing to do,
    // and nothing to unload later.
    if (await isAlreadyLoaded(root, trimmed)) return

    // Preferred: the current REST API, whose TTL makes the pin self-cleaning.
    const modern = await postLoad(`${root}/api/v0/models/load`, {
      model: trimmed,
      ttl: 3600
    })
    if (modern === 'ok') return

    if (modern === 'missing') {
      // Legacy generation: no TTL, so remember the pin and undo it on quit.
      const legacy = await postLoad(`${root}/api/v1/models/load`, { model: trimmed })
      if (legacy === 'ok') {
        legacyPins.add(trimmed)
        return
      }
      if (legacy === 'missing') return // No load endpoint at all — JIT as before. Stay memoized.
    }

    // Transient failure (server busy, model still downloading): allow the
    // next turn to try again rather than giving up for the whole session.
    attempts.delete(key)
  })()
  attempts.set(key, attempt)
  return attempt
}

/** Whether quitting should wait for legacy unloads. */
export function hasLegacyPins(): boolean {
  return legacyPins.size > 0
}

/**
 * Undo every legacy pin, best-effort. Only models this process loaded are
 * touched; a model that was already resident when we checked was never pinned
 * and is not listed here.
 */
export async function unloadLegacyPins(): Promise<void> {
  const settings = getSettings()
  const root = restApiRoot(settings.baseUrl)
  const ids = [...legacyPins]
  legacyPins.clear()
  await Promise.all(
    ids.map(async (instanceId) => {
      try {
        await auditedFetch(
          `${root}/api/v1/models/unload`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instance_id: instanceId }),
            timeoutMs: UNLOAD_TIMEOUT_MS
          },
          'lmstudio'
        )
      } catch {
        // Quitting anyway — nothing useful to do with a failure here.
      }
    })
  )
}

/** IPC: the renderer pins the model slot it is about to stream from. */
export function registerModelPinHandlers(): void {
  ipcMain.handle('models:pin', async (_e, model: unknown) => {
    if (typeof model === 'string') await pinChatModel(model)
    return true
  })
}
