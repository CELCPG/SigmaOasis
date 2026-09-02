/**
 * The one fact about MCP wire names both processes need (v2.5): how to tell
 * one apart from a built-in. The full naming rule lives in
 * main/ipc/mcp/naming.ts, which hashes with node's crypto and so cannot be
 * imported by the renderer; this file is pure.
 */
export const MCP_PREFIX = 'mcp__'

export function isMcpWireName(name: string): boolean {
  return name.startsWith(MCP_PREFIX)
}

/**
 * Per-turn budget for a tool the app knows nothing about: an MCP server can
 * do anything, including reach the network, so it is budgeted like the app's
 * own egress tools rather than like a cheap local one.
 */
export const MCP_DEFAULT_TURN_BUDGET = 3

/**
 * The two halves of a wire name, for display: `mcp__github__create_issue`
 * reads as server "github", tool "create_issue". A hash suffix a sanitized
 * name carries stays on the tool half — it is part of the identity.
 */
export function splitMcpWireName(name: string): { server: string; tool: string } | null {
  if (!isMcpWireName(name)) return null
  const rest = name.slice(MCP_PREFIX.length)
  const i = rest.indexOf('__')
  if (i <= 0) return null
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) }
}
