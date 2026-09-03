import type { ContextProvider } from './types'
import type { LedgerHit } from '../../../../shared/factLedger'

/**
 * v2.6: the fact ledger rides the turn ahead of the app-run search.
 *
 * A fresh entry — a claim the app verified earlier, whose freshness window
 * has not passed — is handed to the model with its source and its check
 * date, and the search is suppressed: the second ask is answered from what
 * the first one verified. An expired entry is handed over too, marked as
 * such, and the search runs: the model is told what was true on that date
 * and asked to say whether it still is. What the reply then states is
 * captured again after the turn, and a changed value supersedes the entry
 * with the contradiction disclosed under the reply.
 *
 * Registered ahead of `autoSearch`, and the only provider that suppresses.
 */

export const LEDGER_FRESH_LEAD = 'Claims this app verified earlier, each with its source and the date it was checked'
export const LEDGER_EXPIRED_LEAD = 'A claim this app verified earlier has passed its freshness window'

const LEDGER_TOP_K = 3

function dateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function line(h: LedgerHit): string {
  return `- ${h.sentence} (source: ${h.url}; checked ${dateOf(h.checkedAt)})`
}

export const factLedgerProvider: ContextProvider = {
  id: 'factLedger',
  phase: 'serial',
  wait: { label: 'Checking verified claims', detail: 'what the app confirmed earlier, with its date' },
  enabled: (input, io) =>
    input.factualTurn &&
    !!input.lastUserContent &&
    typeof io.api.ledgerLookup === 'function' &&
    io.settings()?.grounding?.factLedger !== false,
  async gather(input, io) {
    const looked = await io.api.ledgerLookup!(input.lastUserContent!).catch(() => null)
    if (!looked?.ok || looked.hits.length === 0) return null
    const hits = looked.hits.slice(0, LEDGER_TOP_K)
    const fresh = hits.filter((h) => !h.expired)
    const expired = hits.filter((h) => h.expired)
    // One expired entry is enough to run the search: a fresh measurement
    // beside an expired price must not keep the price from being re-checked.
    io.patch({
      ledgerContext: {
        hits: hits.length,
        expired: expired.length > 0,
        checkedAt: dateOf(hits[0]!.checkedAt)
      }
    })
    const blocks: string[] = []
    if (fresh.length > 0) {
      blocks.push(
        `${LEDGER_FRESH_LEAD}. Answer from them, and give the date they were checked${expired.length === 0 ? '; the web was not searched for this turn because these hold' : ''}:\n${fresh.map(line).join('\n')}`
      )
    }
    if (expired.length > 0) {
      blocks.push(
        `${LEDGER_EXPIRED_LEAD}. Re-check it against the sources you are given this turn, and if the value has changed, say so and give both the old value with its date and the new one:\n${expired.map(line).join('\n')}`
      )
    }
    return expired.length === 0 ? { blocks, suppress: ['autoSearch'] } : { blocks }
  }
}
