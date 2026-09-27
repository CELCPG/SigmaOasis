import { safeStorage } from 'electron'

/**
 * v2.9: an MCP server's environment values, kept where the Brave key is kept.
 *
 * Through v2.8 a server's `env` was a field of its settings row: typed into a
 * plain textarea, written to config.json in clear, sent to the renderer with
 * every `getSettings` and sent back with every toggle of the server's switch.
 * The privacy audit meanwhile said, unconditionally, that MCP environment
 * values were "never written to the settings file in clear". The values in
 * question are what MCP servers are configured with — API tokens, database
 * URLs, personal access tokens — so the audit was wrong about exactly the
 * values it existed to be right about.
 *
 * The shape now makes the claim true by construction rather than by care:
 *
 *   - The settings row carries `envNames` — names, never values. There is no
 *     field on it a value could be written to, so no later code path can put
 *     one back in config.json by accident, and the renderer never holds one
 *     after the moment it was typed.
 *   - The values live in the store's `secrets` key, one sealed entry per
 *     server, encrypted by the OS keychain through `safeStorage` — the same
 *     mechanism, and the same fallback, as the Brave key.
 *   - The main process joins them back onto the config only where a process is
 *     spawned (mcp.ts builds the manager's runtime configs), so a value exists
 *     in memory in the one place it is used.
 *
 * Where the keychain is unavailable (some Linux setups without a secret
 * service), a value is stored unencrypted, marked so, and the privacy audit
 * warns — the Brave key's rule. `resealMcpEnv` encrypts such entries the first
 * time the app starts with a keychain, so a machine that gains one does not
 * keep the plaintext.
 *
 * Pure over a table the caller persists, so it is tested without electron-store
 * (test/mcpEnv.test.ts, against the harness's deterministic keychain).
 */

/** One server's values, sealed: base64 of the encrypted JSON, or the JSON itself when unencrypted. */
export interface SealedMcpEnv {
  values: string
  unencrypted?: true
}

/** Server id → its sealed values. A server with no environment has no entry. */
export type McpEnvTable = Record<string, SealedMcpEnv>

/** A POSIX environment name. The same rule the settings normalizer applies to names. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * A server's id as the settings normalizer stores it. One function for both, so
 * values lifted out of a legacy row are keyed exactly as the row will be.
 */
export function mcpServerId(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .slice(0, 32)
}

/** Names and string values only, in the order given, first occurrence wins. */
export function normalizeMcpEnv(raw: unknown): Record<string, string> {
  const env: Record<string, string> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return env
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (ENV_NAME.test(k) && typeof v === 'string' && !(k in env)) env[k] = v
  }
  return env
}

/**
 * A settings row's variable names: its own `envNames`, plus the keys of a
 * pre-v2.9 row's `env` — names only. The settings normalizer builds every row
 * through this, so a value handed to it has nowhere to go but the floor.
 */
export function envNamesOf(row: { envNames?: unknown; env?: unknown } | null | undefined): string[] {
  const names = [...(Array.isArray(row?.envNames) ? row.envNames : []), ...Object.keys(normalizeMcpEnv(row?.env))]
  return [...new Set(names.filter((n): n is string => typeof n === 'string' && ENV_NAME.test(n)))]
}

/** Seal one server's values: encrypted when the keychain is there, marked when it is not. */
export function sealMcpEnv(values: Record<string, string>): SealedMcpEnv {
  const json = JSON.stringify(values)
  if (safeStorage.isEncryptionAvailable()) {
    return { values: safeStorage.encryptString(json).toString('base64') }
  }
  return { values: json, unencrypted: true }
}

/**
 * Open one server's values. `null` when an encrypted entry cannot be decrypted
 * — a profile copied from another machine or user account, whose keychain
 * sealed it — which the caller reports rather than spawning the server with a
 * silently empty environment.
 */
export function openMcpEnv(sealed: SealedMcpEnv | undefined): Record<string, string> | null {
  if (!sealed) return {}
  try {
    const json = sealed.unencrypted ? sealed.values : safeStorage.decryptString(Buffer.from(sealed.values, 'base64'))
    return normalizeMcpEnv(JSON.parse(json))
  } catch {
    return null
  }
}

/** The table with one server's values replaced; no values means no entry. */
export function withMcpEnv(table: McpEnvTable, serverId: string, values: Record<string, string>): McpEnvTable {
  const next = { ...table }
  if (Object.keys(values).length === 0) delete next[serverId]
  else next[serverId] = sealMcpEnv(values)
  return next
}

/** Only the entries for servers that still exist. */
export function pruneMcpEnv(table: McpEnvTable, serverIds: Iterable<string>): McpEnvTable {
  const keep = new Set(serverIds)
  return Object.fromEntries(Object.entries(table).filter(([id]) => keep.has(id)))
}

/**
 * Encrypt what had to be stored unencrypted, now that a keychain is available.
 * Returns the same table object when there is nothing to do, so the caller can
 * skip the write.
 */
export function resealMcpEnv(table: McpEnvTable): McpEnvTable {
  if (!safeStorage.isEncryptionAvailable()) return table
  const pending = Object.entries(table).filter(([, s]) => s.unencrypted)
  if (pending.length === 0) return table
  const next = { ...table }
  for (const [id, sealed] of pending) {
    const values = openMcpEnv(sealed)
    if (values) next[id] = sealMcpEnv(values)
  }
  return next
}

/**
 * What the privacy audit and the MCP tab read: how many servers have values
 * stored, how many of those in clear, and which cannot be opened on this
 * machine — those servers are kept from starting (mcp.ts) and the tab says why.
 */
export function mcpEnvStatus(table: McpEnvTable): { servers: number; unencrypted: number; unreadable: string[] } {
  const entries = Object.entries(table)
  return {
    servers: entries.length,
    unencrypted: entries.filter(([, s]) => s.unencrypted).length,
    unreadable: entries.filter(([, s]) => openMcpEnv(s) === null).map(([id]) => id)
  }
}

/**
 * The migration's one step: lift values out of pre-v2.9 settings rows.
 *
 * Returns each row with `env` replaced by `envNames`, and the values found,
 * per server id. Rows without an id are passed through untouched for the
 * settings normalizer to drop, as it always has.
 */
export function liftMcpEnv(rawServers: unknown): { servers: unknown[]; values: Record<string, Record<string, string>> } {
  if (!Array.isArray(rawServers)) return { servers: [], values: {} }
  const values: Record<string, Record<string, string>> = {}
  const servers = rawServers.map((row: unknown) => {
    if (!row || typeof row !== 'object' || !('env' in row)) return row
    const { env, ...rest } = row as Record<string, unknown>
    const found = normalizeMcpEnv(env)
    const id = mcpServerId(rest.id)
    if (id && Object.keys(found).length > 0) values[id] = found
    return { ...rest, envNames: envNamesOf({ envNames: rest.envNames, env: found }) }
  })
  return { servers, values }
}
