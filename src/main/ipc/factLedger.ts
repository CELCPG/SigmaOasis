import { ipcMain } from 'electron'
import { createHash } from 'crypto'
import { LEDGER_PACK_ID, LEDGER_PACK_NAME, expiresAtFor } from '../../shared/factLedger'
import type { ClaimClass, LedgerEntryDraft, LedgerHit, LedgerUpsertResult } from '../../shared/factLedger'
import { lookupLibrary, readAppPack, removePack, writeAppPack } from './library'
import type { AppPackDoc } from './library'

/**
 * v2.6: the fact ledger's store — one library pack the app writes.
 *
 * Every entry is one document in the `verified-claims` pack: the reply
 * sentence that carried the claim, its source URL, the date it was checked
 * and the date it expires, keyed by the claim's class and the question's
 * content words. The pack is kind `app`: the Library panel lists it with a
 * purge control and nothing else — it is not curated, it is not the user's
 * documents, and it is never exported as either.
 *
 * One writer. Entries arrive only through `upsertClaims`, which the renderer
 * calls after the grounding pass with what that pass bound to a source; a
 * model cannot write here, and a tool cannot. A changed value supersedes
 * the entry and is reported back, so the reply can say what changed.
 *
 * `SIGMA_LEDGER_NOW` is a test seam: the claims eval asks the same question
 * "a day later" to see an expired price re-checked. Unset in the shipped app.
 */

const CLAIM_CLASSES: ReadonlySet<string> = new Set(['money', 'measurement', 'address', 'contact', 'url', 'date', 'historical'])
const MAX_LEDGER_ENTRIES = 2_000
const LEDGER_TOP_K = 5

export function ledgerNow(): number {
  const seam = process.env.SIGMA_LEDGER_NOW
  const n = seam ? Number(seam) : NaN
  return Number.isFinite(n) && n > 0 ? n : Date.now()
}

function docIdOf(key: string): string {
  return `c-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`
}

function dateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function docText(d: LedgerEntryDraft, checkedAt: number): string {
  return `${d.sentence}\n\nSource: ${d.url}\nChecked: ${dateOf(checkedAt)}\nClaim: ${d.claimClass} — ${d.value}\nQuestion: ${d.question}\n`
}

function isDraft(d: unknown): d is LedgerEntryDraft {
  const x = d as Partial<LedgerEntryDraft>
  return (
    !!x &&
    typeof x.key === 'string' &&
    x.key.length > 0 &&
    typeof x.claimClass === 'string' &&
    CLAIM_CLASSES.has(x.claimClass) &&
    typeof x.value === 'string' &&
    typeof x.sentence === 'string' &&
    typeof x.url === 'string' &&
    /^https?:\/\//.test(x.url) &&
    typeof x.question === 'string'
  )
}

/** Write drafts into the pack: new keys written, unchanged values refreshed, changed values superseded. */
export async function upsertClaims(rawDrafts: unknown[]): Promise<LedgerUpsertResult> {
  const drafts = rawDrafts.filter(isDraft)
  const out: LedgerUpsertResult = { written: [], refreshed: [], superseded: [] }
  if (drafts.length === 0) return out
  const now = ledgerNow()
  const existing = (await readAppPack(LEDGER_PACK_ID)) ?? { docs: [] as AppPackDoc[] }
  const byKey = new Map(existing.docs.filter((d) => d.claim).map((d) => [d.claim!.key, d]))
  for (const d of drafts) {
    const prior = byKey.get(d.key)
    const doc: AppPackDoc = {
      id: docIdOf(d.key),
      title: d.sentence.length > 90 ? `${d.sentence.slice(0, 89)}…` : d.sentence,
      text: docText(d, now),
      source: d.url,
      date: `checked ${dateOf(now)}`,
      checkedAt: now,
      expiresAt: expiresAtFor(d.claimClass, now),
      claim: { key: d.key, claimClass: d.claimClass, value: d.value }
    }
    if (!prior) {
      out.written.push(d.key)
    } else if (prior.claim!.value === d.value) {
      out.refreshed.push(d.key)
    } else {
      out.superseded.push({ key: d.key, previous: prior.claim!.value, next: d.value, sentence: d.sentence })
    }
    byKey.set(d.key, doc)
  }
  let docs = [...byKey.values()]
  if (docs.length > MAX_LEDGER_ENTRIES) {
    // Oldest checks go first; a ledger is a record of recent verification.
    docs = docs.sort((a, b) => (b.checkedAt ?? 0) - (a.checkedAt ?? 0)).slice(0, MAX_LEDGER_ENTRIES)
  }
  await writeAppPack({
    id: LEDGER_PACK_ID,
    name: LEDGER_PACK_NAME,
    description: 'Claims this app verified against a source, with the date each was checked. Written by the app; never by a model.',
    docs
  })
  return out
}

/** The ledger's answer to a question: entries whose text matches, freshest first, each marked expired or not. */
export async function lookupLedger(query: string): Promise<{ ok: boolean; hits: LedgerHit[]; error?: string }> {
  const pack = await readAppPack(LEDGER_PACK_ID)
  if (!pack || pack.docs.length === 0) return { ok: true, hits: [] }
  const outcome = await lookupLibrary({ query, packId: LEDGER_PACK_ID, topK: LEDGER_TOP_K })
  if (!outcome.ok) return { ok: false, hits: [], error: outcome.error }
  const now = ledgerNow()
  const byId = new Map(pack.docs.map((d) => [d.id, d]))
  const seen = new Set<string>()
  const hits: LedgerHit[] = []
  for (const p of outcome.passages) {
    const doc = byId.get(p.docId)
    if (!doc?.claim || typeof doc.checkedAt !== 'number' || seen.has(doc.id)) continue
    seen.add(doc.id)
    const expiresAt = doc.expiresAt === undefined ? null : doc.expiresAt
    hits.push({
      key: doc.claim.key,
      claimClass: doc.claim.claimClass as ClaimClass,
      value: doc.claim.value,
      sentence: doc.text.split('\n')[0] ?? doc.title,
      url: doc.source ?? '',
      checkedAt: doc.checkedAt,
      expiresAt,
      expired: expiresAt !== null && now > expiresAt,
      score: p.score
    })
  }
  return { ok: true, hits }
}

export async function ledgerStats(): Promise<{ entries: number; expired: number }> {
  const pack = await readAppPack(LEDGER_PACK_ID)
  if (!pack) return { entries: 0, expired: 0 }
  const now = ledgerNow()
  const claims = pack.docs.filter((d) => d.claim)
  return {
    entries: claims.length,
    expired: claims.filter((d) => typeof d.expiresAt === 'number' && now > d.expiresAt).length
  }
}

export async function purgeLedger(): Promise<{ removed: boolean }> {
  return removePack(LEDGER_PACK_ID)
}

export function registerFactLedgerHandlers(): void {
  ipcMain.handle('ledger:lookup', (_e, query: unknown) => lookupLedger(String(query ?? '')))
  ipcMain.handle('ledger:upsert', async (_e, drafts: unknown) => {
    try {
      return { ok: true, ...(await upsertClaims(Array.isArray(drafts) ? drafts : [])) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), written: [], refreshed: [], superseded: [] }
    }
  })
  ipcMain.handle('ledger:stats', () => ledgerStats())
  ipcMain.handle('ledger:purge', async () => {
    try {
      return { ok: true, ...(await purgeLedger()) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
