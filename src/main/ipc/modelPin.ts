import { ipcMain } from 'electron'
import { auditedFetch } from './net'
import { getSettings } from './store'
import { draftModelFor } from '../../shared/draftModel'

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
 * A model that is already loaded when we check is left alone. LM Studio has
 * no "upgrade a JIT load to a manual one" call: asking the load endpoint for
 * an already-loaded model tries to start a SECOND instance, which either
 * doubles the memory or is refused by the server's resource guardrails. So an
 * already-loaded model is accepted as-is, and the pin does its work on the
 * common path: the app's first turn, before anything else has JIT-loaded the
 * model. (A model that something else JIT-loaded first can still be evicted;
 * the README's troubleshooting section points at the LM Studio setting that
 * disables auto-evict entirely.)
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

async function postLoad(url: string, body: Record<string, unknown>): Promise<'ok' | 'missing' | 'refused' | 'failed'> {
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
    const text = await res.text().catch(() => '')
    // A route that does not exist, checked BEFORE the status.
    //
    // v1.4.2: this check has been here since v1.3 and was unreachable, because
    // `res.ok` returned 'ok' first. Some LM Studio builds answer an unknown
    // route with a 200 and an error in the body — this one says so in its own
    // log: "Unexpected endpoint or method. (POST /api/v0/models/load).
    // Returning 200 anyway". The pin then reported success, never fell back to
    // the legacy endpoint, and left the model merely JIT-loaded. Auto-evict
    // unloaded it the next time an embedding call landed, so every turn paid a
    // full model reload — and every reload discards the prompt cache, which is
    // scoped to the load ("lifetime=model_load" in the server log).
    if (text.includes('Unexpected endpoint')) return 'missing'
    if (res.ok) return 'ok'
    if (res.status === 404) return 'missing'
    // The resource guardrail declining the load ("insufficient system
    // resources") will not change from one turn to the next; treat it as
    // settled rather than retrying every message.
    if (text.includes('model_load_failed') || text.includes('insufficient')) return 'refused'
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
  // v4.2 (S8): a role's draft model is pinned beside its main model, so the
  // embedding calls that evict one do not evict the other. After the main
  // model, whose load is the one the turn is waiting on. Not for a pair the
  // server has already refused this session.
  const draft = draftModelFor(trimmed, getSettings().models)
  if (draft && !draftRejected(trimmed, draft)) return pinOne(trimmed).then(() => pinOne(draft))
  return pinOne(trimmed)
}

function pinOne(trimmed: string): Promise<void> {
  const settings = getSettings()
  const root = restApiRoot(settings.baseUrl)
  const key = `${root}::${trimmed}`
  const existing = attempts.get(key)
  if (existing) return existing

  const attempt = (async () => {
    // Resident already (user loaded it, or we did earlier): nothing to do,
    // and nothing to unload later.
    //
    // v1.4.5: the memo is dropped in this branch, which is the whole fix for a
    // model that reloads on every prompt. "Already loaded" is not a permanent
    // fact — a JIT-loaded model is evicted the moment the embedding model
    // loads, which happens on every turn that recalls memory or ranks tools.
    // Memoizing the skip meant the app checked once at startup, found the
    // model resident, and never looked again; the eviction that arrived thirty
    // seconds later went unnoticed for the rest of the session, and every
    // prompt after it paid a full reload. Measured 2026-08-12: the chat model
    // reloading on all three turns of a conversation, prompt cache restoring
    // `cached_tokens=0` each time, and no load request ever sent.
    //
    // Re-checking costs one loopback GET per turn while unpinned, and stops
    // entirely once a pin succeeds — that path stays memoized below.
    if (await isAlreadyLoaded(root, trimmed)) {
      attempts.delete(key)
      return
    }

    // Preferred: the current REST API, whose TTL makes the pin self-cleaning.
    // v4.0: a slot marked *Keep loaded* (Settings → Roles) pins for a month
    // idle rather than an hour, so the app's own embedding calls and another
    // client's requests do not evict it between sessions.
    const modern = await postLoad(`${root}/api/v0/models/load`, {
      model: trimmed,
      ttl: keepLoadedTtl(trimmed, settings.models)
    })
    if (modern === 'ok') return

    if (modern === 'missing') {
      // Legacy generation: no TTL, so remember the pin and undo it on quit.
      const legacy = await postLoad(`${root}/api/v1/models/load`, { model: trimmed })
      if (legacy === 'ok') {
        legacyPins.add(trimmed)
        return
      }
      if (legacy === 'missing' || legacy === 'refused') return // Settled for this session. Stay memoized.
    }
    if (modern === 'refused') return // Guardrail said no; it will keep saying no.

    // Transient failure (server busy, model still downloading): allow the
    // next turn to try again rather than giving up for the whole session.
    attempts.delete(key)
  })()
  attempts.set(key, attempt)
  return attempt
}

/** An hour idle by default; a month for a slot the user asked to keep loaded. */
export const PIN_TTL_S = 3600
export const KEEP_LOADED_TTL_S = 30 * 24 * 3600
export function keepLoadedTtl(model: string, slots: readonly { modelId: string; keepLoaded?: boolean; enabled: boolean; draftModel?: string }[] | undefined): number {
  // A settings object with no slots (a test's stub, a cold store) keeps the hour.
  // v4.2 (S8): a kept-loaded role's draft model is kept as long as the model it drafts for.
  return (slots ?? []).some((s) => s.enabled && s.keepLoaded && (s.modelId === model || s.draftModel === model)) ? KEEP_LOADED_TTL_S : PIN_TTL_S
}

/**
 * v4.2 (S8): draft pairs the server refused this session, and what it said —
 * for the quiet notice on Settings → LM Studio. A refused pair is not sent
 * again until the app restarts, so one refusal costs one retried request, not
 * one per turn. Both the chat (renderer, over IPC) and the agent report here.
 */
export interface DraftNotice {
  model: string
  draft: string
  detail: string
  at: number
}
const draftRefusals = new Map<string, DraftNotice>()

export function noteDraftRejected(model: string, draft: string, detail: string): void {
  draftRefusals.set(`${model}::${draft}`, { model, draft, detail: detail.slice(0, 300), at: Date.now() })
}
export function draftRejected(model: string, draft: string): boolean {
  return draftRefusals.has(`${model}::${draft}`)
}
export function draftNotices(): DraftNotice[] {
  return [...draftRefusals.values()]
}

/**
 * v4.0 (E2): load or unload a model on the user's click, from Settings →
 * LM Studio. The same two routes the pin uses, tried in the same order; the
 * outcome is a sentence for the row, never a throw.
 */
export async function loadModel(model: string): Promise<{ ok: boolean; detail: string }> {
  const trimmed = model.trim()
  if (!trimmed) return { ok: false, detail: 'No model named.' }
  const settings = getSettings()
  const root = restApiRoot(settings.baseUrl)
  if (await isAlreadyLoaded(root, trimmed)) return { ok: true, detail: 'Already loaded.' }
  const modern = await postLoad(`${root}/api/v0/models/load`, { model: trimmed, ttl: keepLoadedTtl(trimmed, settings.models) })
  if (modern === 'ok') {
    attempts.delete(`${root}::${trimmed}`)
    return { ok: true, detail: 'Loaded.' }
  }
  if (modern === 'missing') {
    const legacy = await postLoad(`${root}/api/v1/models/load`, { model: trimmed })
    if (legacy === 'ok') {
      legacyPins.add(trimmed)
      return { ok: true, detail: 'Loaded (an older LM Studio: unloaded again when the app quits).' }
    }
    if (legacy === 'missing') return { ok: false, detail: 'This LM Studio has no load route; load it in LM Studio itself.' }
    if (legacy === 'refused') return { ok: false, detail: 'LM Studio refused: not enough memory for it.' }
    return { ok: false, detail: 'LM Studio did not load it; its server log says why.' }
  }
  if (modern === 'refused') return { ok: false, detail: 'LM Studio refused: not enough memory for it.' }
  return { ok: false, detail: 'LM Studio did not load it; its server log says why.' }
}

export async function unloadModel(model: string): Promise<{ ok: boolean; detail: string }> {
  const trimmed = model.trim()
  if (!trimmed) return { ok: false, detail: 'No model named.' }
  const root = restApiRoot(getSettings().baseUrl)
  for (const url of [`${root}/api/v0/models/unload`, `${root}/api/v1/models/unload`]) {
    try {
      const res = await auditedFetch(
        url,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: trimmed, instance_id: trimmed }), timeoutMs: UNLOAD_TIMEOUT_MS },
        'lmstudio'
      )
      const text = await res.text().catch(() => '')
      if (res.ok && !text.includes('Unexpected endpoint')) {
        legacyPins.delete(trimmed)
        attempts.delete(`${root}::${trimmed}`)
        return { ok: true, detail: 'Unloaded.' }
      }
    } catch {
      // try the next route
    }
  }
  return { ok: false, detail: 'LM Studio did not unload it; unload it in LM Studio itself.' }
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
  // v4.0 (E2): the user's own Load and Unload, from Settings → LM Studio.
  ipcMain.handle('models:load', (_e, model: unknown) => loadModel(String(model ?? '')))
  ipcMain.handle('models:unload', (_e, model: unknown) => unloadModel(String(model ?? '')))
  // v4.2 (S8): the chat's draft refusals land here; Settings → LM Studio reads them back.
  ipcMain.handle('models:draftRejected', (_e, model: unknown, draft: unknown, detail: unknown) => {
    if (typeof model === 'string' && typeof draft === 'string' && model && draft) noteDraftRejected(model, draft, String(detail ?? ''))
    return true
  })
  ipcMain.handle('models:draftNotices', () => draftNotices())
}
