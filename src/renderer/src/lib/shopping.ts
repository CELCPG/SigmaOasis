/**
 * Shopping intent as a routing signal (DESIGN-private-shopping §2e).
 *
 * `looksFactual` exists because small models almost never volunteer a
 * `web_search` on a factual question, so the app runs one itself. Shopping has
 * exactly the same failure, with worse consequences: measured in a v1.3
 * session, an entirely shopping-shaped conversation — "i need to buy some new
 * underwear", then a brand, then "find the best reviewed product" — never once
 * produced a `shop_compare` call. The model answered from memory and invented a
 * price range ("$20–$35 per pair"), a reputational ranking, and a product URL
 * that existed in no search result.
 *
 * `shop_compare` extracts prices from page data rather than reading them with a
 * model, so putting real offers in front of the answer removes the option to
 * invent one, rather than discouraging it. That is the same move v1.1 made for
 * `web_search` and v1.2 made for claim checking.
 */

/**
 * Buying language. A price, a purchase verb, an availability question, or a
 * superlative aimed at products — the shapes that mean "help me choose or buy
 * a thing" rather than "explain a thing".
 */
const SHOPPING_INTENT =
  /\b(?:buy|purchase|order|shop(?:ping)?\s+for|price[sd]?|pricing|cost[s]?|how\s+much|cheap(?:er|est)?|afford(?:able)?|deal[s]?|discount[s]?|coupon[s]?|sale|on\s+sale|in\s+stock|availability|where\s+can\s+i\s+(?:get|buy|find)|worth\s+buying|best\s+(?:value|price|deal))\b/i

/**
 * Product-shopping nouns paired with a choosing verb — "recommend a laptop",
 * "which stroller", "best headphones". Kept separate from SHOPPING_INTENT so
 * the negative branch below can veto it.
 */
const PRODUCT_CHOICE =
  /\b(?:best|top|recommend(?:ation)?s?|which|compare|vs\.?|versus)\b[^.?!]{0,60}\b(?:brand|model|product|laptop|phone|headphones?|tv|monitor|camera|mattress|stroller|purifier|vacuum|printer|watch|tablet|speaker|chair|desk|bike|shoes?|jacket|underwear|suit|car|suv|sedan|appliance|fridge|washer|dryer)s?\b/i

/**
 * Questions that mention products but want understanding, not a purchase.
 * Checked first and wins: "how does noise cancelling work" and "is a standing
 * desk worth it" are conversations, and a comparison table is the wrong answer
 * to both.
 */
const OPINION_OR_EXPLANATION =
  /\b(?:how\s+(?:does|do|did|to)\b|what\s+is\b|what\s+are\b|why\s+(?:is|are|do|does)\b|explain\b|difference\s+between\b|worth\s+it\b|should\s+i\s+(?:keep|repair|fix|replace\s+or)\b|how\s+long\s+(?:do|does|should)\b|review\s+of\s+my\b)/i

/**
 * Already-owned framing: maintenance and troubleshooting, not acquisition.
 * "my car won't start" and "fix my dishwasher" are not shopping.
 */
const OWNERSHIP =
  /\b(?:fix|repair|troubleshoot|broken|won'?t\s+(?:start|turn|work)|not\s+working|clean(?:ing)?|maintain|warranty\s+claim|return\s+my|my\s+old)\b/i

/**
 * Buying a security is not shopping.
 *
 * "you can buy stocks on kraken" tripped the purchase branch in a measured
 * v1.4 session, which put the turn into pricing mode: `shop_compare` has
 * nothing to say about an equity, and the mode's other half — the check that
 * flags any price in the reply — then flagged the user's own investment
 * budget. Both halves were wrong for the same reason, so the veto sits here
 * rather than in either of them.
 *
 * Plural-only for `stocks` and `shares`: "are these headphones in stock" is a
 * genuine availability question, and "can you share the link" is not about
 * equities. The singular forms carry too much ordinary retail traffic to spend
 * a veto on.
 */
const SECURITIES =
  /\b(?:stocks|stock (?:market|price)|shares|shareholders?|equit(?:y|ies)|etfs?|bonds|treasuries|crypto(?:currency)?|bitcoin|ethereum|tickers?|brokerages?|portfolios?|index funds?|mutual funds?|ira|401k|dividends?|options contracts?|price targets?|market cap|valuations?|ipo|analysts?)\b/i

/**
 * Decide whether a turn is a purchase decision worth pricing mechanically.
 *
 * Conservative in the opposite direction from `looksFactual`: over-triggering
 * here costs real outbound requests to commercial sites, so the negative
 * branches win and ties break toward *not* shopping.
 */
export function looksLikeShopping(text: string): boolean {
  const t = text.trim()
  if (t.length < 8) return false
  if (OPINION_OR_EXPLANATION.test(t)) return false
  if (OWNERSHIP.test(t)) return false
  if (SECURITIES.test(t)) return false
  if (SHOPPING_INTENT.test(t)) return true
  if (PRODUCT_CHOICE.test(t)) return true
  return false
}

/**
 * The product terms to price, drawn from the turn plus the conversation.
 *
 * A follow-up ("find the best reviewed one", "what about the second") names no
 * product, so the subject has to come from what was said before — the same
 * anchoring problem `buildSearchQuery` solves for search, and the same answer.
 * Returns null when no candidate subject exists, in which case the caller
 * simply does not run a comparison.
 */
export function shoppingSubject(text: string, previousUserText?: string): string | null {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  const previous = previousUserText?.replace(/\s+/g, ' ').trim()

  const anchored = previous && needsAnchor(oneLine) ? `${previous} — ${oneLine}` : oneLine
  const subject = anchored.trim()
  return subject.length >= 3 ? subject.slice(0, 240) : null
}

/**
 * Words that stand in for a product rather than naming one — "the best
 * reviewed product", "which one", "that option". A message built from these
 * says nothing to a price extractor on its own, so the subject has to come
 * from the conversation.
 */
const GENERIC_REFERENT =
  /\b(?:one|ones|it|its|this|that|these|those|product|products|item|items|option|options|model|brand|pair|first|second|third|last|other|same|them)\b/i

/** Below this a message is too terse to carry a product on its own. */
const MIN_STANDALONE_WORDS = 6

function needsAnchor(text: string): boolean {
  if (GENERIC_REFERENT.test(text)) return true
  return text.split(/\s+/).filter(Boolean).length < MIN_STANDALONE_WORDS
}
