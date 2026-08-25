import type { ContextProvider } from './types'
import { buildSearchContext } from '../grounding'
import { shoppingSubject } from '../shopping'

/**
 * v1.3 shopping intent (DESIGN-private-shopping §2e). Same reasoning as the
 * auto-search, for the case where a wrong answer costs money: on a purchase
 * turn the app prices the thing mechanically, so the model has real offers to
 * write around instead of the option to recall a number. One provider owns
 * both arms: the priced path when shop_compare is allowlisted, and the
 * no-tool warning when it is not (the comparison tools ship off — they
 * contact commercial sites, which is the user's call to make).
 */
export const shoppingPriceProvider: ContextProvider = {
  id: 'shoppingPrice',
  phase: 'serial',
  wait: {
    label: 'Checking prices',
    detail: 'real offers, so the answer is not written around a remembered number'
  },
  enabled: (input) => input.shoppingTurn && !!input.lastUserContent,
  async gather(input, io) {
    const canCompare = input.slotTools.some((t) => t.function.name === 'shop_compare')
    if (!canCompare) {
      // The option to invent a price still has to go, so say so, and the
      // grounding check flags any price that appears anyway.
      return {
        blocks: [
          'This turn is a purchase decision and no price-checking tool is enabled. Do not state ' +
            'prices, discounts, or "typical" cost ranges — you have no source for them and a ' +
            'remembered price is a guess about a number that changes weekly. Say that price checking ' +
            'is off (Settings → Tools), describe the options qualitatively, and link only to pages ' +
            'that appeared in a tool result.'
        ]
      }
    }
    const product = shoppingSubject(input.lastUserContent!, input.previousUserContent)
    if (!product) return null
    const result = await io.runTool('shop_compare', { product })
    if (!result.ok) return null
    return { blocks: [buildSearchContext(`prices for "${product}"`, result.output ?? '')] }
  }
}
