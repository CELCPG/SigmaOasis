import { ipcMain } from 'electron'
import { auditedFetch } from './net'
import { restApiRoot } from './modelPin'
import { getSettings } from './store'

/**
 * What LM Studio can tell us about the models it has.
 *
 * The OpenAI-compatible `/v1/models` endpoint returns ids and nothing else,
 * which is all the app used through v0.8.1. That left it blind in ways the
 * user then paid for: an image sent to a text-only model produces confident
 * nonsense, and history was trimmed against a hardcoded character budget
 * because the real context window was unknown.
 *
 * LM Studio's own REST API (`/api/v0/models`, same server, different root)
 * reports `type`, `max_context_length`, `loaded_context_length`, `state`,
 * `quantization` and `arch`. Two notes on reading it honestly:
 *
 *   - Vision is derivable: `type === 'vlm'`. There is no documented tool-use
 *     capability field, so tool support is left unknown rather than guessed —
 *     a wrong badge is worse than no badge.
 *   - `loaded_context_length` is what the model is actually loaded with, which
 *     can be far below `max_context_length`. It is the number that matters for
 *     budgeting, so it wins when present.
 *
 * Older LM Studio builds have no `/api/v0`. Those fall back to `/v1/models`
 * and the app degrades to exactly its previous behavior.
 *
 * 4.5 (H4a): llama.cpp's own `llama-server` can be the server instead — this PC
 * runs Gemma 4 26B-A4B and the 35B-A3B that way. It has no `/api/v0` (a JSON
 * 404), so it lands on the same `/v1/models` fallback, but that list is not
 * ids-only there: `models[].capabilities` says whether a multimodal projector
 * is loaded and `data[].meta` carries `n_ctx` (the window the server was
 * started with) and `n_ctx_train`. `GET /props` adds `modalities.vision` and
 * `default_generation_settings.n_ctx`, the window one request really gets. The
 * fallback reads those only when the body looks like llama-server's, so an LM
 * Studio answer — with or without `/api/v0` — goes through the code it always
 * did and costs no extra request.
 */

export interface CatalogModel {
  id: string
  /** 'llm' | 'vlm' | 'embeddings' when known. */
  type?: string
  /** True when the model accepts images (LM Studio reports type 'vlm'). */
  vision?: boolean
  /** Context the model is currently loaded with — prefer this for budgeting. */
  loadedContextLength?: number
  /** Context the model supports at most. */
  maxContextLength?: number
  /** True when the model is resident in LM Studio right now. */
  loaded?: boolean
  quantization?: string
  arch?: string
  /**
   * Which server described this model, set only when it is not LM Studio — so
   * LM Studio's entries stay exactly the entries they were.
   */
  server?: 'llamacpp'
}

export interface ModelCatalog {
  models: CatalogModel[]
  /** False when only /v1/models answered with ids, so capability fields are absent. */
  detailed: boolean
}

const TIMEOUT_MS = 10_000
/** /props is an extra, optional read; a server too busy to answer it quickly is not waited for. */
const PROPS_TIMEOUT_MS = 3_000

interface RestModel {
  id?: string
  type?: string
  state?: string
  max_context_length?: number
  loaded_context_length?: number
  quantization?: string
  arch?: string
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Ask the richer REST endpoint. Returns null when it is not available. */
async function fetchDetailed(root: string): Promise<CatalogModel[] | null> {
  const res = await auditedFetch(`${root}/api/v0/models`, { timeoutMs: TIMEOUT_MS }, 'lmstudio')
  if (!res.ok) return null
  const data = (await res.json()) as { data?: RestModel[] }
  if (!Array.isArray(data.data)) return null
  return data.data
    .filter((m): m is RestModel & { id: string } => typeof m?.id === 'string')
    .map((m) => ({
      id: m.id,
      type: typeof m.type === 'string' ? m.type : undefined,
      vision: m.type === 'vlm',
      loadedContextLength: num(m.loaded_context_length),
      maxContextLength: num(m.max_context_length),
      loaded: m.state === 'loaded',
      quantization: typeof m.quantization === 'string' ? m.quantization : undefined,
      arch: typeof m.arch === 'string' ? m.arch : undefined
    }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Is this `/v1/models` body llama-server's? Its list has an Ollama-style
 * `models[]` with `capabilities`, and its `data[]` entries are owned by
 * `llamacpp` and carry a `meta` with the model's training context. LM Studio's
 * entries have none of these (`owned_by: "organization_owner"`).
 */
function fromLlamaCpp(body: unknown): boolean {
  if (!isRecord(body)) return false
  if (Array.isArray(body.models) && body.models.some((m) => isRecord(m) && Array.isArray(m.capabilities))) return true
  return (
    Array.isArray(body.data) &&
    body.data.some(
      (m) => isRecord(m) && (m.owned_by === 'llamacpp' || (isRecord(m.meta) && num(m.meta.n_ctx_train) !== undefined))
    )
  )
}

/** What llama-server's `GET /props` says about the model it serves; null when it does not answer. */
async function fetchProps(root: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await auditedFetch(`${root}/props`, { timeoutMs: PROPS_TIMEOUT_MS }, 'lmstudio')
    if (!res.ok) return null
    const body: unknown = await res.json()
    return isRecord(body) ? body : null
  } catch {
    return null
  }
}

/** llama.cpp's file-type name in LM Studio's spelling ("Q4_K - Medium" → "Q4_K_M"); any other name as reported. */
function quantizationName(ftype: unknown): string | undefined {
  if (typeof ftype !== 'string' || !ftype.trim()) return undefined
  const name = ftype.trim()
  const sized = /^(Q\d_K) - (Small|Medium|Large)$/.exec(name)
  return sized ? `${sized[1]}_${sized[2][0]}` : name
}

/**
 * The catalog of a llama-server, from its `/v1/models` body and its `/props`.
 *
 *   - Vision: `/props` `modalities.vision` when it answers (an audio-only
 *     projector is "multimodal" too, so the list's capability is the fallback,
 *     not the authority); otherwise `capabilities` — `multimodal` is vision, a
 *     list without it is text-only. No capability list and no `/props`: unknown.
 *   - Context: the loaded window, `default_generation_settings.n_ctx` (what one
 *     request gets), else the list's `meta.n_ctx`; the training window is
 *     `meta.n_ctx_train`. The loaded one wins in `effectiveContextLength`.
 *   - Loaded: llama-server serves the one model it lists, so it is resident
 *     unless `/props` says `is_sleeping`. With several models listed and no
 *     `/props` answer for one of them, that is not known, so not claimed.
 *   - Not reported at all, so absent: architecture.
 *
 * `/props` describes the server's one model. It is applied to a listed model
 * only when that is the only one listed or its `model_alias` names it.
 */
async function describeLlamaCpp(body: Record<string, unknown>, root: string): Promise<CatalogModel[]> {
  const entries = (Array.isArray(body.data) ? body.data : []).filter(
    (m): m is Record<string, unknown> & { id: string } => isRecord(m) && typeof m.id === 'string'
  )
  const props = await fetchProps(root)
  const listed = Array.isArray(body.models) ? body.models.filter(isRecord) : []
  const sole = entries.length === 1
  return entries.map((m): CatalogModel => {
    const names = [m.id, ...(Array.isArray(m.aliases) ? m.aliases.filter((a): a is string => typeof a === 'string') : [])]
    const meta = isRecord(m.meta) ? m.meta : {}
    const caps = listed.find((l) => names.includes(l.name as string) || names.includes(l.model as string))?.capabilities
    const capabilities = Array.isArray(caps) && caps.length > 0 ? caps : undefined
    const mine = props && (sole || (typeof props.model_alias === 'string' && names.includes(props.model_alias))) ? props : null
    const modalities = mine && isRecord(mine.modalities) ? mine.modalities : {}
    const generation = mine && isRecord(mine.default_generation_settings) ? mine.default_generation_settings : {}

    const vision =
      typeof modalities.vision === 'boolean'
        ? modalities.vision
        : capabilities
          ? capabilities.includes('multimodal')
          : undefined
    return {
      id: m.id,
      type: vision === undefined ? undefined : vision ? 'vlm' : 'llm',
      vision,
      loadedContextLength: num(generation.n_ctx) ?? num(meta.n_ctx),
      maxContextLength: num(meta.n_ctx_train),
      loaded: mine || sole ? !(mine && mine.is_sleeping === true) : undefined,
      quantization: quantizationName(meta.ftype),
      server: 'llamacpp'
    }
  })
}

/**
 * The OpenAI-compatible list, present on every server we support. From LM Studio
 * it is ids only; from llama-server it is read for capabilities (see above).
 */
async function fetchBasic(baseUrl: string): Promise<ModelCatalog> {
  const res = await auditedFetch(
    `${baseUrl.replace(/\/+$/, '')}/models`,
    { timeoutMs: TIMEOUT_MS },
    'lmstudio'
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as { data?: { id?: string }[] }
  if (fromLlamaCpp(data)) return { models: await describeLlamaCpp(data as Record<string, unknown>, restApiRoot(baseUrl)), detailed: true }
  return {
    models: (data.data ?? [])
      .filter((m): m is { id: string } => typeof m?.id === 'string')
      .map((m) => ({ id: m.id })),
    detailed: false
  }
}

/**
 * The model list, as detailed as this server can describe it. Throws only when
 * the server is unreachable — the caller reads that as "offline".
 *
 * 4.6 (J1): of the main connection unless told another address — the agent
 * connection's (./agentRoute.ts), read by the same code, llama-server's reader
 * included.
 */
export async function fetchModelCatalog(baseUrl: string = getSettings().baseUrl): Promise<ModelCatalog> {
  try {
    const detailed = await fetchDetailed(restApiRoot(baseUrl))
    if (detailed && detailed.length > 0) return { models: detailed, detailed: true }
  } catch {
    // Endpoint missing or malformed — fall through to the universal one.
  }
  return fetchBasic(baseUrl)
}

export function registerModelCatalogHandlers(): void {
  ipcMain.handle('models:catalog', async (): Promise<ModelCatalog | { error: string }> => {
    try {
      return await fetchModelCatalog()
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
  // 4.6 (J1): the agent connection's server, for its card under Settings →
  // Connection. Read only while the connection is on: off, nothing at all goes
  // to that address.
  ipcMain.handle('models:agentCatalog', async (): Promise<ModelCatalog | { error: string; off?: true }> => {
    const connection = getSettings().agentConnection
    if (!connection?.enabled) return { error: 'The agent connection is off.', off: true }
    try {
      return await fetchModelCatalog(connection.baseUrl)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
}
