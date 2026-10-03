/**
 * Loopback detection for the main process (net.ts, store.ts, search.ts). The
 * one definition moved to src/shared/loopback.ts in 4.6 (J1) so the agent's
 * connection rule (main/agent/connection.ts), which must not reach into this
 * IPC layer, reads the same one; this re-export keeps every importer here.
 */
export { isLoopbackBaseUrl, isLoopbackHostname } from '../../shared/loopback'
