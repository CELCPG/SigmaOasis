/**
 * The agent connection (4.6, J1): which server the agent's requests go to.
 *
 * Through 4.5 the app had one connection, `settings.baseUrl` (LM Studio), and
 * everything shared it: chat, embeddings, titles, the library, the model pin
 * and the agent. On this PC the agent is 2–3½× faster on the 35B-A3B behind a
 * second server (llama-server on the B60, `:8081`) than on the 9B behind LM
 * Studio, and pointing `baseUrl` there would cost nomic's embeddings — the
 * library, memory and tool ranking (ROADMAP-v4.5.md decisions 2 and 12).
 *
 * So the agent may have a connection of its own. Only the agent uses it: the
 * in-app agent, `sigma` and `eval:agent` all route through `routeAgent` here,
 * and nothing else reads it. Off — the default, and every 4.5 config, which
 * has no such key — returns the main address and the requested model exactly
 * as given, so a task's requests are the 4.5 requests byte for byte
 * (test/agentRequests.test.ts). On, the agent talks to that server and only
 * that server: unreachable, or without the model, is a plain error that names
 * the agent connection, never a quiet fall back to LM Studio.
 *
 * Plain Node, no Electron: the CLI and the eval import it as the app does.
 */

import { isLoopbackBaseUrl } from '../ipc/loopback'

/** 4.6 (J1): mirrors main/ipc/store.ts and the renderer's types.ts. */
export interface AgentConnectionSettings {
  /** Off: the agent runs on the main connection (`baseUrl`), as through 4.5. */
  enabled: boolean
  /** An OpenAI-compatible server on this machine — llama-server's `http://127.0.0.1:8080/v1`. Loopback only, like `baseUrl`. */
  baseUrl: string
  /** The model the agent asks it for; '' is the one model the server lists first. */
  model: string
}

/** The default an absent or malformed setting takes: off, llama-server's own default port, no model named. */
export const DEFAULT_AGENT_CONNECTION: AgentConnectionSettings = { enabled: false, baseUrl: 'http://127.0.0.1:8080/v1', model: '' }

/**
 * A stored value read back (the settings normalizer, and `sigma` reading the
 * app's file). On only when written as true. The address follows the main
 * address's rule (store.ts `normalizeBaseUrl`): a server on this machine, or
 * the default — the conversation would otherwise leave the machine on a path
 * that is deliberately never proxied. `enabled` is kept as written, so a bad
 * address fails the next task in words rather than moving the agent back to
 * LM Studio unseen.
 */
export function normalizeAgentConnection(raw: unknown): AgentConnectionSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof AgentConnectionSettings, unknown>>
  const url = typeof r.baseUrl === 'string' ? r.baseUrl.trim() : ''
  return {
    enabled: r.enabled === true,
    baseUrl: isLoopbackBaseUrl(url) ? url : DEFAULT_AGENT_CONNECTION.baseUrl,
    model: typeof r.model === 'string' ? r.model.trim().slice(0, 200) : ''
  }
}

/** Where one task's requests go: the main connection, or the agent's own. */
export interface AgentRoute {
  via: 'main' | 'agent'
  baseUrl: string
  /** On the agent connection, '' until `pickServedModel` names the server's model. */
  model: string
}

/** True only for a connection switched on with an address; anything else is off. */
export function agentConnectionOn(c: Partial<AgentConnectionSettings> | null | undefined): c is AgentConnectionSettings {
  return Boolean(c && c.enabled === true && typeof c.baseUrl === 'string' && c.baseUrl.trim())
}

/**
 * The agent's server and model. Off (or absent) is the main address and the
 * model the task asked for, as given — nothing about the 4.5 request moves.
 * On is the agent connection's address and its model, whatever the task's own
 * slot names: that slot is an LM Studio model, which the agent server may not
 * have at all.
 */
export function routeAgent(mainBaseUrl: string, connection: Partial<AgentConnectionSettings> | null | undefined, requestedModel: string): AgentRoute {
  if (!agentConnectionOn(connection)) return { via: 'main', baseUrl: mainBaseUrl, model: requestedModel }
  return { via: 'agent', baseUrl: connection.baseUrl.trim(), model: typeof connection.model === 'string' ? connection.model.trim() : '' }
}

/** The words every failure on the agent connection starts with. */
export function agentConnectionName(baseUrl: string): string {
  return `The agent connection (${baseUrl}, Settings → LM Studio)`
}

/** What to do about it — the same sentence wherever the failure is told. */
const NO_FALLBACK = 'The agent does not fall back to LM Studio: start that server, or turn the agent connection off.'

/** The agent server did not answer its model list. */
export function agentConnectionError(baseUrl: string, detail: string): string {
  return `${agentConnectionName(baseUrl)} did not answer: ${detail.replace(/\.$/, '')}. ${NO_FALLBACK}`
}

/** An embedding model in a list is never the agent's (LM Studio lists nomic beside the chat models). */
const EMBEDDING_ID = /embed/i

/**
 * The model the agent asks the agent server for: the configured one when the
 * server lists it, or with none configured the first chat model it lists
 * (llama-server serves one). Anything else is an error that names the
 * connection — a missing model is not swapped for another.
 */
export function pickServedModel(route: AgentRoute, listed: string[]): { ok: true; model: string } | { ok: false; error: string } {
  const chat = listed.filter((id) => !EMBEDDING_ID.test(id))
  if (route.model) {
    if (listed.includes(route.model)) return { ok: true, model: route.model }
    const names = chat.length > 0 ? `it lists ${chat.slice(0, 5).join(', ')}${chat.length > 5 ? ', …' : ''}` : 'it lists no chat model'
    return { ok: false, error: `${agentConnectionName(route.baseUrl)} does not serve ${route.model} (${names}). ${NO_FALLBACK}` }
  }
  if (chat.length > 0) return { ok: true, model: chat[0]! }
  return { ok: false, error: `${agentConnectionName(route.baseUrl)} lists no chat model to run the agent on. ${NO_FALLBACK}` }
}

/**
 * The check before a task, over plain HTTP — for `sigma` and `eval:agent`,
 * which run on Node. (The app asks through its audited transport and the
 * catalog's reader instead: main/ipc/agentRoute.ts.) The server's model list,
 * then `pickServedModel`; a server that does not answer is `agentConnectionError`.
 */
export async function checkAgentServer(route: AgentRoute, timeoutMs = 10_000): Promise<{ ok: true; route: AgentRoute } | { ok: false; error: string }> {
  let ids: string[]
  try {
    const res = await fetch(`${route.baseUrl.replace(/\/+$/, '')}/models`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { ok: false, error: agentConnectionError(route.baseUrl, `HTTP ${res.status}`) }
    const data = (await res.json()) as { data?: { id?: unknown }[] }
    ids = (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string')
  } catch (err) {
    // Node's fetch says "fetch failed" and keeps the reason (ECONNREFUSED …) in its cause.
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : ''
    return { ok: false, error: agentConnectionError(route.baseUrl, cause || (err instanceof Error ? err.message : String(err))) }
  }
  const picked = pickServedModel(route, ids)
  return picked.ok ? { ok: true, route: { ...route, model: picked.model } } : picked
}

/**
 * An error the engine reported, said of the server it really came from. The
 * engine's words name LM Studio (main/agent/stream.ts) — and the eval reads
 * those words to tell a server failure from a task failure, so they stay; on
 * the agent connection the app and the CLI say which server it was instead.
 */
export function onAgentConnection(detail: string, route: AgentRoute): string {
  if (route.via !== 'agent' || !detail) return detail
  const named = detail.replace(/\bLM Studio\b/g, `the agent connection's server (${route.baseUrl})`)
  return named === detail ? `On the agent connection (${route.baseUrl}): ${detail}` : named.charAt(0).toUpperCase() + named.slice(1)
}

/**
 * What a host shows under a finished task: a failure on the agent connection
 * says which server failed; a pause, a question or a stuck note is the task's
 * own and is left as the engine wrote it.
 */
export function taskDetail(result: { status: string; detail?: string }, route: AgentRoute): string | undefined {
  return result.detail && result.status === 'error' ? onAgentConnection(result.detail, route) : result.detail
}

/** One line for a header or a log: `qwen3.8-35b-a3b on the agent connection (http://127.0.0.1:8081/v1)`. */
export function describeRoute(route: AgentRoute): string {
  return route.via === 'agent' ? `${route.model || 'the server’s model'} on the agent connection (${route.baseUrl})` : `${route.model} on LM Studio (${route.baseUrl})`
}
