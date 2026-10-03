/**
 * Loopback detection, shared by the settings normalizer (store.ts), the egress
 * allowlist (net.ts), the SSRF guard (search.ts) and — since 4.6 (J1), when it
 * moved here from main/ipc — the agent connection's rule (main/agent/
 * connection.ts), which the agent's code must reach without the IPC layer. One
 * definition: a tightening here must not miss a copy. (The renderer keeps its
 * own mirror in SettingsModal.tsx for the live typing hint, as it does for all
 * main types.)
 */

const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '::1', '[::1]']

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.includes(hostname)
}

/**
 * True when `url` parses as http(s) to a loopback host. Used to decide whether
 * an LM Studio base URL may be saved at all — see normalizeBaseUrl in store.ts.
 */
export function isLoopbackBaseUrl(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url)
    if (protocol !== 'http:' && protocol !== 'https:') return false
    return isLoopbackHostname(hostname)
  } catch {
    return false
  }
}
