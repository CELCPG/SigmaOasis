import type { ContextProvider } from './types'
import { buildLedger, buildLedgerContext, describeLedger, shouldInjectLedger } from '../ledger'

/**
 * v1.9 conversation ledger: what this conversation has established, from tool
 * results and the user's own words — never from earlier replies — once it is
 * long enough for a small model to have lost the thread. Rides the turn notes
 * like everything above it; disclosed under the reply.
 */
export const ledgerProvider: ContextProvider = {
  id: 'ledger',
  phase: 'serial',
  enabled: (_input, io) => io.settings()?.grounding.ledger !== false,
  async gather(input, io) {
    // The assistant message being written is already appended; the ledger is
    // built from everything before it.
    const ledger = buildLedger(input.convo.messages.filter((m) => m.id !== input.assistantMsgId))
    if (!shouldInjectLedger(ledger)) return null
    io.patch({ ledger: describeLedger(ledger) })
    return { blocks: [buildLedgerContext(ledger)] }
  }
}
