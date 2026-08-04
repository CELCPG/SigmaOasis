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
}

export interface ModelCatalog {
  models: CatalogModel[]
  /** False when only /v1/models answered, so capability fields are absent. */
  detailed: boolean
}

const TIMEOUT_MS = 10_000

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

/** The OpenAI-compatible list: ids only, but present on every LM Studio build. */
async function fetchBasic(baseUrl: string): Promise<CatalogModel[]> {
  const res = await auditedFetch(
    `${baseUrl.replace(/\/+$/, '')}/models`,
    { timeoutMs: TIMEOUT_MS },
    'lmstudio'
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as { data?: { id?: string }[] }
  return (data.data ?? [])
    .filter((m): m is { id: string } => typeof m?.id === 'string')
    .map((m) => ({ id: m.id }))
}

/**
 * The model list, as detailed as this server can describe it. Throws only when
 * the server is unreachable — the caller reads that as "offline".
 */
export async function fetchModelCatalog(): Promise<ModelCatalog> {
  const baseUrl = getSettings().baseUrl
  try {
    const detailed = await fetchDetailed(restApiRoot(baseUrl))
    if (detailed && detailed.length > 0) return { models: detailed, detailed: true }
  } catch {
    // Endpoint missing or malformed — fall through to the universal one.
  }
  return { models: await fetchBasic(baseUrl), detailed: false }
}

export function registerModelCatalogHandlers(): void {
  ipcMain.handle('models:catalog', async (): Promise<ModelCatalog | { error: string }> => {
    try {
      return await fetchModelCatalog()
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
}
