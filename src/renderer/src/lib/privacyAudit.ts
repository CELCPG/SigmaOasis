import type { AppSettings, AuditStatus, Grant, McpServerStatus, MemoryStats } from '../types'
import { UNTRUSTED_TOOLS } from '../../../shared/tools'

/**
 * v2.6: the privacy audit — every setting that widens what leaves the machine
 * or what a model may do, named, with a sentence each.
 *
 * OpenClaw's `security audit` runs over a hundred checks after a year of
 * incidents; this app has far fewer surfaces and can have its checks before.
 * Pure over the settings and the live status the panel already fetches: no
 * check contacts anything, and nothing here changes a setting — each row says
 * where the switch is.
 *
 * `ok` is the private default. `warn` is a widening the user chose and should
 * be able to see in one place. `info` is a fact with no default to compare to.
 */

export type PrivacyState = 'ok' | 'warn' | 'info'

export interface PrivacyCheck {
  /** A stable dotted key, so a row can be found by name in the log and the tests. */
  key: string
  title: string
  state: PrivacyState
  detail: string
  /** Where the switch is. */
  where: string
}

export interface PrivacyAuditInput {
  settings: AppSettings
  mcp?: McpServerStatus[] | null
  audit?: AuditStatus | null
  grants?: Grant[] | null
  memory?: MemoryStats | null
  ledger?: { entries: number; expired: number } | null
  /** Hosts each purpose may reach right now, from the egress allowlist. */
  allowedHosts?: Record<string, string[]> | null
}

function isLoopbackUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url)
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
  } catch {
    return false
  }
}

export function privacyChecks(input: PrivacyAuditInput): PrivacyCheck[] {
  const s = input.settings
  const out: PrivacyCheck[] = []
  const tools = 'Settings → Tools'
  const models = 'Settings → Models'

  // ---- where the model server is -----------------------------------------
  out.push(
    isLoopbackUrl(s.baseUrl)
      ? { key: 'lmstudio.loopback', title: 'The model server is on this machine', state: 'ok', detail: `Every prompt goes to ${s.baseUrl} and nowhere else.`, where: 'Settings → Connection' }
      : { key: 'lmstudio.remote', title: 'The model server is not on this machine', state: 'warn', detail: `Prompts, attachments and recalled memory are sent to ${s.baseUrl}. Only you can say whether that host is yours.`, where: 'Settings → Connection' }
  )

  // ---- tools that touch the host ------------------------------------------
  const wd = s.workingDirectory.trim()
  if (s.tools.run_terminal_command) {
    out.push({
      key: 'tools.terminal_enabled',
      title: 'The terminal tool is on',
      state: 'warn',
      detail: wd
        ? `Commands run in ${wd} after you confirm each one, or under a standing grant.`
        : 'Commands run in your home directory after you confirm each one, or under a standing grant. Set a working directory to scope them.',
      where: tools
    })
  }
  if (s.tools.write_file) {
    out.push({
      key: wd ? 'tools.write_scoped' : 'tools.write_unscoped',
      title: wd ? 'The file-write tool is on, scoped to a directory' : 'The file-write tool is on with no working directory',
      state: wd ? 'info' : 'warn',
      detail: wd ? `Writes land only under ${wd} and are not confirmed one by one.` : 'Every write is confirmed, or runs under a standing grant for that exact path.',
      where: tools
    })
  }
  const egressOn = [...UNTRUSTED_TOOLS].filter((t) => s.tools[t as keyof AppSettings['tools']])
  out.push({
    key: 'tools.egress',
    title: egressOn.length ? `${egressOn.length} tool${egressOn.length === 1 ? '' : 's'} can reach the web` : 'No built-in tool reaches the web',
    state: egressOn.length ? 'info' : 'ok',
    detail: egressOn.length
      ? `${egressOn.join(', ')} — each sends only the query or URL, through the egress allowlist, and marks what comes back as untrusted.`
      : 'Search, page fetching and research are all off.',
    where: tools
  })

  // ---- grants ---------------------------------------------------------------
  const grants = input.grants ?? []
  if (grants.length > 0) {
    out.push({
      key: 'grants.standing',
      title: `${grants.length} standing grant${grants.length === 1 ? '' : 's'}`,
      state: 'warn',
      detail: 'Calls matching these exact commands, paths or MCP arguments run without a dialog. Revoke any you no longer want.',
      where: tools
    })
  }

  // ---- MCP -------------------------------------------------------------------
  for (const server of s.mcp?.servers ?? []) {
    if (!server.enabled) continue
    const live = input.mcp?.find((m) => m.id === server.id)
    out.push({
      key: `mcp.enabled.${server.id}`,
      title: `MCP server "${server.name}" is on`,
      state: server.approval === 'full' ? 'warn' : 'info',
      detail:
        `${[server.command, ...server.args].join(' ')} runs with your privileges and outside the egress allowlist; its network traffic is not visible here.` +
        (Object.keys(server.env).length ? ` Environment: ${Object.keys(server.env).join(', ')}.` : '') +
        (server.approval === 'full' ? ' Every call runs without asking.' : server.approval === 'allowlist' ? ' Only calls with a standing grant run.' : ' Each call is confirmed.') +
        (live ? ` Currently ${live.state}.` : ''),
      where: 'Settings → MCP'
    })
  }
  if ((s.mcp?.servers ?? []).some((x) => x.enabled) && s.shopping.requireProxy && s.proxy.mode !== 'none') {
    out.push({
      key: 'mcp.outside_proxy',
      title: 'MCP servers do not use your proxy',
      state: 'warn',
      detail: 'The proxy setting covers the app’s own requests; a server is a separate program with its own sockets.',
      where: 'Settings → MCP'
    })
  }

  // ---- search ----------------------------------------------------------------
  out.push(
    s.search.provider === 'searxng'
      ? { key: 'search.self_hosted', title: 'Search goes to your own SearXNG', state: isLoopbackUrl(s.search.searxngUrl) ? 'ok' : 'info', detail: `Queries go to ${s.search.searxngUrl || '(no URL set)'}.`, where: 'Settings → Search' }
      : { key: 'search.third_party', title: `Search queries go to ${s.search.provider}`, state: 'info', detail: 'Only the query text leaves, and only when a search tool runs. A self-hosted SearXNG keeps queries on your network.', where: 'Settings → Search' }
  )
  if (s.search.confirmBeforeSearch) {
    out.push({ key: 'search.confirmed', title: 'Every search is confirmed first', state: 'ok', detail: 'A dialog shows the query before it is sent.', where: 'Settings → Search' })
  }

  // ---- updates ----------------------------------------------------------------
  out.push(
    s.updates.autoCheck
      ? { key: 'updates.auto_check', title: 'Update checks are on', state: 'info', detail: 'The app asks GitHub for a newer release on a timer. Nothing about you is sent; the request itself reveals the app is in use.', where: 'Settings → Privacy' }
      : { key: 'updates.manual', title: 'Update checks are off', state: 'ok', detail: 'The app never contacts GitHub on its own.', where: 'Settings → Privacy' }
  )

  // ---- proxy ------------------------------------------------------------------
  if (s.proxy.mode === 'none') {
    out.push({ key: 'proxy.off', title: 'No proxy', state: 'info', detail: 'Search and page fetches leave from this machine’s own address.', where: 'Settings → Privacy' })
  } else {
    out.push({ key: 'proxy.on', title: `Outbound requests go through ${s.proxy.host}:${s.proxy.port}`, state: 'ok', detail: 'The model server is never proxied; everything else is.', where: 'Settings → Privacy' })
  }

  // ---- audit log --------------------------------------------------------------
  const audit = input.audit
  out.push(
    s.audit.enabled
      ? { key: 'audit.on', title: 'The session audit log is on', state: audit && !audit.available ? 'warn' : 'ok', detail: audit && !audit.available ? 'The keychain is unavailable, so nothing is being written.' : `Every prompt, reply and tool call is written encrypted, ${audit ? `${audit.sessions.length} session file(s) on disk` : 'per launch'}.`, where: 'Settings → Privacy' }
      : { key: 'audit.off', title: 'The session audit log is off', state: 'info', detail: 'No record of prompts, replies or tool calls is kept beyond the conversations themselves.', where: 'Settings → Privacy' }
  )

  // ---- memory -------------------------------------------------------------------
  const untrusted = input.memory?.untrustedChunks ?? 0
  if (untrusted > 0) {
    out.push({
      key: 'memory.untrusted_present',
      title: `${untrusted} memory chunk${untrusted === 1 ? '' : 's'} came from web or server content`,
      state: 'info',
      detail: 'Saved by a model after it read a page or a server’s output. Never recalled automatically; findable by memory_search; forgettable in one click.',
      where: 'Settings → Memory'
    })
  }

  // ---- ledger -------------------------------------------------------------------
  if (input.ledger && input.ledger.entries > 0) {
    out.push({
      key: 'ledger.entries',
      title: `${input.ledger.entries} verified claim${input.ledger.entries === 1 ? '' : 's'} kept${input.ledger.expired ? `, ${input.ledger.expired} past freshness` : ''}`,
      state: 'info',
      detail: 'Sentences the app confirmed against a source, with the source and date. Local, app-written, purgeable.',
      where: 'Settings → Library'
    })
  }

  // ---- secrets --------------------------------------------------------------------
  out.push({
    key: 'secrets.keychain',
    title: 'Credentials live in the system keychain',
    state: 'ok',
    detail: 'The search API key and MCP environment values are never written to the settings file in clear.',
    where: 'Settings → Search'
  })

  // ---- the allowlist, as it stands -----------------------------------------------
  if (input.allowedHosts) {
    const lines = Object.entries(input.allowedHosts)
      .filter(([, hosts]) => hosts.length > 0)
      .map(([purpose, hosts]) => `${purpose}: ${hosts.join(', ')}`)
    out.push({
      key: 'egress.allowlist',
      title: 'Hosts the app itself may reach right now',
      state: 'info',
      detail: lines.length ? lines.join(' · ') : 'none',
      where: 'derived from the settings above'
    })
  }

  return out
}
