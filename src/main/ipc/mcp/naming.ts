/**
 * Wire names for MCP tools (v2.5).
 *
 * A tool from a server enters the model's tool list beside the built-ins, and
 * its name has to satisfy three things at once: the wire contract
 * (`^[A-Za-z0-9_-]{1,64}$`), uniqueness against every built-in and every
 * other server's tools, and being a pure function of the tool's identity —
 * never of connection order, so two launches with the same servers put the
 * same names on the wire and the prompt cache holds.
 *
 * `mcp__<server>__<tool>`, each part sanitized. When sanitizing or truncating
 * changed anything, a 12-hex hash of (server, raw name) is appended so two
 * distinct raw names can never collapse into one wire name. Adopted from the
 * DeepSeek harness's rule (STRATEGY-harness-adoptions.md, Tier 2).
 *
 * Pure: no Electron, no I/O. The node suite and the renderer both import it.
 */
import { createHash } from 'crypto'
import { MCP_PREFIX } from '../../../shared/mcpNames'

export { isMcpWireName, MCP_PREFIX } from '../../../shared/mcpNames'
export const WIRE_NAME_MAX = 64
const SEP = '__'
const HASH_LEN = 12

function sanitize(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
}

function identityHash(serverId: string, rawName: string): string {
  return createHash('sha256').update(`${serverId} ${rawName}`).digest('hex').slice(0, HASH_LEN)
}

/**
 * The wire name for one tool of one server. Deterministic; the same inputs
 * always give the same name, whatever else is registered.
 */
export function wireName(serverId: string, rawName: string): string {
  const server = sanitize(serverId) || 'server'
  const tool = sanitize(rawName) || 'tool'
  const clean = server === serverId && tool === rawName
  let name = `${MCP_PREFIX}${server}${SEP}${tool}`
  if (!clean || name.length > WIRE_NAME_MAX) {
    const suffix = `_${identityHash(serverId, rawName)}`
    name = `${name.slice(0, WIRE_NAME_MAX - suffix.length)}${suffix}`
  }
  return name
}

/**
 * Assign wire names to a server's tool list. Refuses — as a whole, never
 * partially — a list that would collide with a built-in or with itself:
 * a generation of tools is swapped all or nothing (harness adoptions, Tier 2).
 */
export function assignWireNames(
  serverId: string,
  rawNames: readonly string[],
  builtIns: ReadonlySet<string>,
  takenByOthers: ReadonlySet<string> = new Set()
): { ok: true; names: Map<string, string> } | { ok: false; error: string } {
  const names = new Map<string, string>()
  const seen = new Set<string>()
  for (const raw of rawNames) {
    const name = wireName(serverId, raw)
    if (builtIns.has(name)) return { ok: false, error: `tool "${raw}" would shadow the built-in "${name}"` }
    if (takenByOthers.has(name)) return { ok: false, error: `tool "${raw}" collides with another server's "${name}"` }
    if (seen.has(name)) return { ok: false, error: `two tools on this server both map to "${name}"` }
    seen.add(name)
    names.set(raw, name)
  }
  return { ok: true, names }
}
