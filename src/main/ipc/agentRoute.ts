import { agentConnectionError, agentConnectionOn, pickServedModel, routeAgent, type AgentRoute } from '../agent/connection'
import { fetchModelCatalog } from './modelCatalog'
import { getSettings } from './store'

/**
 * 4.6 (J1): where an agent task in the app runs, checked before it is accepted.
 *
 * Off, this is `routeAgent`'s answer and nothing more — no request, no await
 * on the caller's side (./agent.ts takes the 4.5 path without calling this).
 * On, the agent connection's server is asked for its model list through the
 * catalog's own reader (./modelCatalog.ts — llama-server's `/v1/models` and
 * `/props`), and the task is refused in plain words when the server does not
 * answer or does not serve the model. The window the task budgets its history
 * against is that server's per-request window: llama-server's `/props`
 * `default_generation_settings.n_ctx`, which on a unified KV pool
 * (`--kv-unified`) is the whole context and on a split one a slot's share.
 */
export type PreparedRoute = { ok: true; route: AgentRoute; contextTokens?: number } | { ok: false; error: string }

export async function prepareAgentRoute(requestedModel: string): Promise<PreparedRoute> {
  const settings = getSettings()
  const route = routeAgent(settings.baseUrl, settings.agentConnection, requestedModel)
  if (!agentConnectionOn(settings.agentConnection)) return { ok: true, route }
  let models: Awaited<ReturnType<typeof fetchModelCatalog>>['models']
  try {
    models = (await fetchModelCatalog(route.baseUrl)).models
  } catch (err) {
    return { ok: false, error: agentConnectionError(route.baseUrl, err instanceof Error ? err.message : String(err)) }
  }
  const picked = pickServedModel(route, models.filter((m) => m.type !== 'embeddings').map((m) => m.id))
  if (!picked.ok) return picked
  const entry = models.find((m) => m.id === picked.model)
  const contextTokens = entry?.loadedContextLength ?? entry?.maxContextLength
  return { ok: true, route: { ...route, model: picked.model }, ...(contextTokens ? { contextTokens } : {}) }
}
