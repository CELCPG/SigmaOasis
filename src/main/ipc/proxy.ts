import { session } from 'electron'
import type { Session } from 'electron'
import { getSettings } from './store'

/**
 * Optional proxying of outbound traffic.
 *
 * This is the single largest privacy gain available to the app: routing search
 * and page traffic through the user's own Tor or VPN endpoint decouples their IP
 * address from their queries, which is the one thing query redaction and provider
 * choice cannot do. The provider still sees the query; it no longer sees who
 * asked.
 *
 * ## Two sessions, deliberately
 *
 * - **egress** — search, page fetches, rendering. Proxied when configured.
 * - **local** — the LM Studio server. Pinned to `direct://` *explicitly*, so it
 *   can never be routed through a proxy: sending model traffic through Tor would
 *   be slow, pointless (it is loopback), and would break the app the moment the
 *   proxy went down. Making it explicit also means a system-wide proxy cannot
 *   capture it by default.
 *
 * ## Why SOCKS5 specifically
 *
 * With `socks5://`, Chromium resolves hostnames *at the proxy* rather than
 * locally, so there is no DNS leak — the local resolver never learns which sites
 * are being read. That is exactly Tor's model, and it is why SOCKS5 is preferred
 * over an HTTP proxy here (see also the DNS handling in search.ts).
 */

export type ProxyMode = 'none' | 'socks5' | 'http'

export interface ProxySettings {
  mode: ProxyMode
  host: string
  port: number
}

/** Hosts that must never be proxied, whatever else is configured. */
const BYPASS_RULES = '127.0.0.1,localhost,[::1],<local>'

export interface ProxyConfig {
  mode: ProxyMode
  /** Chromium proxy rules string, or null for a direct connection. */
  proxyRules: string | null
  proxyBypassRules: string
  /** Human-readable description for the UI and the tool output. */
  description: string
  /** Set when the settings are unusable; the config falls back to direct. */
  error?: string
}

/**
 * Turn settings into a Chromium proxy configuration.
 *
 * Pure, and exported for tests: a misconfigured proxy that silently falls back to
 * a direct connection is precisely the failure a privacy feature must not have,
 * so the fallback is explicit and carries a reason.
 */
export function buildProxyConfig(settings: ProxySettings): ProxyConfig {
  const direct: ProxyConfig = {
    mode: 'none',
    proxyRules: null,
    proxyBypassRules: BYPASS_RULES,
    description: 'Direct connection (no proxy)'
  }

  if (settings.mode === 'none') return direct

  const host = settings.host.trim()
  const port = Number(settings.port)

  if (!host) {
    return { ...direct, error: 'No proxy host set — using a direct connection.' }
  }
  // A hostname here would be resolved locally, which is the leak the proxy is
  // meant to prevent; and in practice a proxy is on loopback or a LAN address.
  if (/[\s/@]/.test(host)) {
    return { ...direct, error: `Invalid proxy host "${host}" — using a direct connection.` }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      ...direct,
      error: `Invalid proxy port "${settings.port}" — using a direct connection.`
    }
  }

  // Bracket a bare IPv6 literal, which Chromium's rules syntax requires.
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  const scheme = settings.mode === 'socks5' ? 'socks5' : 'http'

  return {
    mode: settings.mode,
    proxyRules: `${scheme}://${authority}:${port}`,
    proxyBypassRules: BYPASS_RULES,
    description:
      settings.mode === 'socks5'
        ? `SOCKS5 via ${authority}:${port} (DNS resolved at the proxy)`
        : `HTTP proxy via ${authority}:${port}`
  }
}

/** The configuration currently in force, derived from settings. */
export function currentProxyConfig(): ProxyConfig {
  return buildProxyConfig(getSettings().proxy)
}

/** True when outbound traffic is actually going through a proxy right now. */
export function proxyActive(): boolean {
  return currentProxyConfig().proxyRules !== null
}

let egressSession: Session | null = null
let localSession: Session | null = null

/**
 * The session for everything that leaves the machine. Its proxy is re-applied on
 * every call, so a settings change takes effect without a restart.
 */
export async function getEgressSession(): Promise<Session> {
  if (!egressSession) {
    egressSession = session.fromPartition('sigma-egress', { cache: false })
  }
  const config = currentProxyConfig()
  await egressSession.setProxy(
    config.proxyRules
      ? { proxyRules: config.proxyRules, proxyBypassRules: config.proxyBypassRules }
      : { mode: 'direct' }
  )
  return egressSession
}

/**
 * The session for the local model server. Always direct — see the note above on
 * why that is pinned rather than merely left unconfigured.
 */
export async function getLocalSession(): Promise<Session> {
  if (!localSession) {
    localSession = session.fromPartition('sigma-local', { cache: false })
    await localSession.setProxy({ mode: 'direct' })
  }
  return localSession
}

/** Apply the current proxy configuration to a renderer session. */
export async function applyProxyToSession(target: Session): Promise<void> {
  const config = currentProxyConfig()
  await target.setProxy(
    config.proxyRules
      ? { proxyRules: config.proxyRules, proxyBypassRules: config.proxyBypassRules }
      : { mode: 'direct' }
  )
}
