import { formatCompare, runShopCompare, runShopRequirements } from '../shopping'
import { addWatch, formatWatchlist, readWatchlist, removeWatch } from '../watchlist'
import { truncate } from './types'
import type { ToolHandler } from './types'

/** Private shopping research: shop_requirements, shop_compare, price_watch. See DESIGN-private-shopping.md. */

const shopRequirements: ToolHandler = async (args) => {
  const answers =
    args.answers && typeof args.answers === 'object' && !Array.isArray(args.answers)
      ? Object.fromEntries(
          Object.entries(args.answers as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')])
        )
      : undefined
  const result = runShopRequirements({ need: String(args.need ?? ''), answers })
  return result.ok ? { ok: true, output: truncate(result.output ?? '') } : { ok: false, error: result.error }
}

const shopCompare: ToolHandler = async (args) => {
  const brands = Array.isArray(args.brands)
    ? (args.brands as unknown[]).map((b) => String(b ?? '')).filter(Boolean)
    : []
  const outcome = await runShopCompare({
    product: String(args.product ?? ''),
    maxSellers: typeof args.maxSellers === 'number' ? args.maxSellers : undefined,
    brands
  })
  // A refusal (personal query, proxy off, regulated category) is an error
  // the model sees and can act on, not a silent empty result.
  if (!outcome.ok) return { ok: false, error: outcome.error }
  return { ok: true, output: truncate(formatCompare(outcome)) }
}

const priceWatch: ToolHandler = async (args) => {
  const action = String(args.action ?? 'list')
  if (action === 'list') {
    return { ok: true, output: truncate(formatWatchlist(await readWatchlist())) }
  }
  const url = String(args.url ?? '')
  if (!url) return { ok: false, error: 'A product URL is required for add/remove.' }
  if (action === 'remove') {
    const { removed } = await removeWatch(url)
    return removed
      ? { ok: true, output: 'Removed from the local watchlist.' }
      : { ok: false, error: 'That URL is not on the watchlist.' }
  }
  if (action === 'add') {
    const added = await addWatch({
      url,
      name: args.name ? String(args.name) : undefined,
      targetPrice: typeof args.targetPrice === 'number' ? args.targetPrice : undefined
    })
    return added.ok
      ? {
          ok: true,
          output:
            `Watching "${added.entry?.name}" locally. Nothing was sent — the list lives on this machine only.` +
            (added.entry?.url !== url ? `\nTracking parameters were stripped: ${added.entry?.url}` : '')
        }
      : { ok: false, error: added.error }
  }
  return { ok: false, error: `Unknown price_watch action "${action}".` }
}

export const shoppingHandlers = {
  shop_requirements: shopRequirements,
  shop_compare: shopCompare,
  price_watch: priceWatch
} satisfies Record<string, ToolHandler>
