/**
 * Local price watchlist.
 *
 * This is the part of the shopping feature that is better *because* it is
 * local, not merely private. Every price tracker on the market works by holding
 * your watchlist on their server — that list is the product, and it is a
 * remarkably complete statement of what you want and cannot yet afford.
 *
 * Here the list is a JSON file in the app-data directory, next to notes.json.
 * Nobody is told what is on it because there is nobody to tell.
 *
 * History is append-only and capped per item. Prices are recorded only when a
 * check actually produced one from structured page data — a failed or blocked
 * check appends nothing rather than a zero, because a gap in the history is
 * honest and a fabricated point is not.
 */

import { app } from 'electron'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { writeFileAtomic } from './fsAtomic'
import { normalizeProductUrl } from './urlHygiene'

/** Price points kept per item. Roughly a year of daily checks. */
const MAX_HISTORY_POINTS = 400
/** Items on the list. A watchlist is a shortlist; past this it is a hoard. */
const MAX_ITEMS = 100

export interface PricePoint {
  at: number
  price: number
  currency?: string
}

export interface WatchEntry {
  /** Normalized (tracking-free) URL — also the identity of the entry. */
  url: string
  name: string
  addedAt: number
  targetPrice?: number
  currency?: string
  history: PricePoint[]
}

function watchlistFile(): string {
  return join(app.getPath('userData'), 'watchlist.json')
}

export async function readWatchlist(): Promise<WatchEntry[]> {
  try {
    const raw = await fs.readFile(watchlistFile(), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as WatchEntry[]) : []
  } catch {
    return []
  }
}

export async function writeWatchlist(entries: WatchEntry[]): Promise<void> {
  const file = watchlistFile()
  // The app-data directory exists in practice, but a first write that fails
  // because of a missing parent would lose a watch the user just added.
  await fs.mkdir(dirname(file), { recursive: true }).catch(() => undefined)
  await writeFileAtomic(file, JSON.stringify(entries, null, 2))
}

export async function addWatch(args: {
  url: string
  name?: string
  targetPrice?: number
  currency?: string
}): Promise<{ ok: boolean; entry?: WatchEntry; error?: string }> {
  const url = normalizeProductUrl(args.url)
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'A watch needs an http(s) product URL.' }

  const entries = await readWatchlist()
  const existing = entries.find((e) => e.url === url)
  if (existing) {
    // Re-adding updates the target rather than duplicating the row.
    if (args.targetPrice !== undefined) existing.targetPrice = args.targetPrice
    if (args.name) existing.name = args.name
    await writeWatchlist(entries)
    return { ok: true, entry: existing }
  }
  if (entries.length >= MAX_ITEMS) {
    return { ok: false, error: `Watchlist is full (${MAX_ITEMS} items). Remove something first.` }
  }

  const entry: WatchEntry = {
    url,
    name: args.name?.trim() || url,
    addedAt: Date.now(),
    targetPrice: args.targetPrice,
    currency: args.currency,
    history: []
  }
  entries.push(entry)
  await writeWatchlist(entries)
  return { ok: true, entry }
}

export async function removeWatch(url: string): Promise<{ ok: boolean; removed: boolean }> {
  const normalized = normalizeProductUrl(url)
  const entries = await readWatchlist()
  const next = entries.filter((e) => e.url !== normalized)
  if (next.length === entries.length) return { ok: true, removed: false }
  await writeWatchlist(next)
  return { ok: true, removed: true }
}

/**
 * Append a price point. Returns the drop-vs-target and drop-vs-previous facts
 * so the caller can report them without recomputing — and without a model
 * doing arithmetic on prices.
 */
export async function recordPrice(
  url: string,
  price: number,
  currency?: string,
  at = Date.now()
): Promise<{
  ok: boolean
  entry?: WatchEntry
  previous?: number
  changed?: number
  hitTarget?: boolean
  error?: string
}> {
  if (!Number.isFinite(price) || price < 0) return { ok: false, error: 'Refusing to record a non-price.' }
  const normalized = normalizeProductUrl(url)
  const entries = await readWatchlist()
  const entry = entries.find((e) => e.url === normalized)
  if (!entry) return { ok: false, error: 'That URL is not on the watchlist.' }

  const previous = entry.history[entry.history.length - 1]?.price
  entry.history.push({ at, price, currency })
  if (entry.history.length > MAX_HISTORY_POINTS) {
    entry.history.splice(0, entry.history.length - MAX_HISTORY_POINTS)
  }
  if (currency && !entry.currency) entry.currency = currency
  await writeWatchlist(entries)

  return {
    ok: true,
    entry,
    previous,
    changed: previous === undefined ? undefined : Math.round((price - previous) * 100) / 100,
    hitTarget: entry.targetPrice !== undefined && price <= entry.targetPrice
  }
}

/** Render the list for a tool result. Timestamps stay absolute — "3 days ago" drifts. */
export function formatWatchlist(entries: WatchEntry[]): string {
  if (entries.length === 0) return 'Watchlist is empty. Nothing is being tracked, and nothing was ever sent.'
  const lines = entries.map((e) => {
    const last = e.history[e.history.length - 1]
    const first = e.history[0]
    const trend =
      last && first && last.price !== first.price
        ? ` (${last.price < first.price ? '↓' : '↑'} ${Math.abs(
            Math.round((last.price - first.price) * 100) / 100
          )} since added)`
        : ''
    const current = last ? `${last.price}${e.currency ? ` ${e.currency}` : ''}${trend}` : 'no price recorded yet'
    const target = e.targetPrice !== undefined ? ` · target ${e.targetPrice}` : ''
    const checked = last ? ` · last checked ${new Date(last.at).toISOString().slice(0, 16).replace('T', ' ')}` : ''
    return `- ${e.name}\n    ${current}${target}${checked}\n    ${e.url}`
  })
  return `${entries.length} item(s) watched locally — this list has never left the machine.\n${lines.join('\n')}`
}
