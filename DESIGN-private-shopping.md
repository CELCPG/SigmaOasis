# Sigma Oasis — Private shopping research

Status: **proposed** · Target: v1.4 · Author: Colin Long

Shopping is the most surveilled thing a person does online. Price trackers work
by knowing your entire watchlist. Coupon extensions work by seeing every cart.
Comparison sites work by taking a cut of where they send you. The whole
category is built on the assumption that *someone else holds the list*.

Sigma Oasis can hold the list on your machine and tell nobody. That is the
feature — not "an AI that shops for you," but **a comparison and price-watch
layer where the only party who knows what you're looking at is you.**

The existing stack does most of the hard work already: cookieless ephemeral
render sessions with third-party blocking (`render.ts`), an egress allowlist
and activity log (`net.ts`), query redaction (`search.ts:sanitizeQuery`),
Tor/VPN routing (`proxy.ts`), and the v1.1/v1.2 doctrine that a fact without a
source is a confabulation. A price is a fact with a source and a timestamp, or
it is nothing.

---

## The boundary, stated first

**Sigma Oasis researches. It never transacts.** No login, no cart, no
checkout, no stored payment method, no address autofill, no account creation.
The render session is read-only by construction — navigation away from the
target is already blocked, the session is destroyed after each page, and no
tool in this design has a verb that submits anything.

This is not a limitation worked around; it is the reason the privacy story
holds. The moment the app authenticates to a retailer, every guarantee above
collapses into "a browser with worse UX." You finish the purchase in your own
browser, on your own account, with the app's research in hand.

---

## 1. What the user gets

Ask *"who has the Sony WH-1000XM5 in stock under $300"* and the reply contains
a **comparison card**, not prose:

| Seller | Price | Availability | Checked | Source |
| --- | --- | --- | --- | --- |
| electronics-retailer.example | $278.00 | in stock | 2 min ago | link |
| manufacturer.example | $329.99 | in stock | 2 min ago | link |
| marketplace.example | — | blocked (403) | 2 min ago | link |

Under it, one line of provenance: *"4 sellers checked, 1 blocked · via Tor ·
prices as seen anonymously — your logged-in price may differ."*

Then the model writes the *recommendation* around the table — which one, why,
what the trade-off is. It never writes the numbers. The numbers come from the
extractor.

**Price watch.** ☆ on any row adds it to a local watchlist. On demand (or on a
schedule you set), the app re-fetches and shows the history — a sparkline and
the delta since you added it. Nobody is told what you are watching, because
there is nobody to tell: the list is a JSON file in your app-data directory,
next to `notes.json`.

---

## 2. How it works

### 2a. Mechanical extraction first, model second

Most retail pages carry schema.org `Product`/`Offer` data as JSON-LD in a
`<script type="application/ld+json">` block — name, price, priceCurrency,
availability, seller — because Google requires it for rich results. That is a
machine-readable price, and parsing it in code is both more accurate and more
honest than asking a 7B model to read a page and report a number.

So the extractor runs a ladder:

1. **JSON-LD `Product`/`Offer`** → structured, `source: 'json-ld'`
2. **Microdata / RDFa `itemprop="price"`** → structured, `source: 'microdata'`
3. **Meta tags** (`og:price:amount`, `product:price:amount`) → `source: 'meta'`
4. **Model fallback** — the rendered page text goes to the slot with one
   question: *"what is the listed price and availability?"* → `source: 'model'`,
   and the card **labels it as model-read**, visually distinct from the
   structured rows.

A price with no rung that produced it is not displayed. Rung 4 is the only one
a model touches, and the user can see when it was used — the same disclosure
logic as `unverified` and the memory-recall chips.

### 2b. What leaves the machine, and to whom

| Step | Who learns what | Control |
| --- | --- | --- |
| Product search | The search provider learns the query | Existing provider choice; SearXNG self-hosted leaks it to nobody. `sanitizeQuery` already strips paths and secrets; shopping adds **query minimization** — the model must search the product identifier (`"WH-1000XM5 price"`), never the user's framing (`"cheap headphones for my flight to Lagos"`). Enforced in code by rejecting queries over N tokens that contain first-person pronouns, not by asking the model nicely. |
| Product page fetch | The retailer learns: your IP, a generic UA, and that someone looked at this URL | Cookieless ephemeral session (already), third-party requests blocked (already), no referrer, one origin per session. IP is covered only by the proxy — hence 2c. |
| Watchlist re-check | Same as above, repeated | Jittered scheduling so a re-check doesn't fingerprint as a bot on a clean interval; per-run cap. |
| Nothing else | — | No affiliate links, no click-through wrapper, no analytics, ever. See §5. |

### 2c. Hardened mode

`settings.shopping.requireProxy` (default **on**): shopping fetches refuse to
run when Tor/VPN is off, rather than silently going out direct. A privacy
feature that quietly doesn't cover the case that matters is worse than not
having it — the same reasoning that moved the whole HTTP stack onto Electron's
`net` in `httpClient.ts`.

The refusal is a visible tool error naming the fix, not a fallback.

### 2d. URL hygiene

Every URL is normalized before it is fetched, displayed, stored, or exported:
strip `utm_*`, `gclid`, `fbclid`, `srsltid`, `tag`, `ref`, `ref_`, `smid`,
`psc`, and unwrap known click-redirect hosts to their destination. Applies to
search results (which arrive tagged), to the watchlist, and to markdown export.
Tracking parameters are how a link you paste into a group chat tells the
retailer where the click came from.

### 2e. Shopping intent as a routing signal

`looksLikeShopping()` in `src/renderer/src/lib/shopping.ts` mirrors
`looksFactual()` — price/buy/cheapest/in-stock/model-number patterns, with a
negative branch for *"how does X work"* and *"is X worth it"* (opinion, not
lookup). On a hit, the app runs the comparison mechanically before the model
answers, exactly as v1.1 does with `web_search`. The option to invent a price
is removed rather than discouraged.

This is also the first real consumer of the per-role tool allowlists proposed
in [STRATEGY-routing-and-tools.md](STRATEGY-routing-and-tools.md) §1a: a
"Shopper" role holds `shop_compare` / `price_watch` / `fetch_webpage` and
nothing else — in particular, not `run_terminal_command`.

---

## 3. Tools

Three, deliberately narrow. None of them can submit, authenticate, or pay.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `shop_compare` | `product` (identifier or name), `maxSellers` (≤5, default 4) | Structured offers array — seller, price, currency, availability, url, fetchedAt, extraction rung. Never prose. |
| `product_details` | `url` | One offer plus spec/description text from the page |
| `price_watch` | `action`: `add`/`list`/`remove`/`check`, `url`, `targetPrice?` | Watchlist state and price history |

`shop_compare` is a budgeted campaign, not a loop the model drives: one
search, then at most `maxSellers` page fetches, sequenced with the same
pacing discipline as `deepResearch.ts` (`searchPacing`), with the budget
checked **before** each fetch and disclosed when hit — "3 of 4 sellers checked
— fetch budget reached."

Toggles land in `ToolToggles` alongside the existing 15, default **off**:
this feature initiates outbound requests to commercial sites, and that should
be a choice the user makes on purpose.

---

## 4. Implementation

| File | Change |
| --- | --- |
| `src/main/ipc/shopping.ts` | **New.** JSON-LD / microdata / meta extraction ladder, currency + unit-price normalization, offer types, the `shop_compare` budget ledger. |
| `src/main/ipc/watchlist.ts` | **New.** `watchlist.json` in `userData`, written through `writeFileAtomic` like `notes.json`; price history append-only, capped per item. |
| `src/main/ipc/urlHygiene.ts` | **New.** Tracking-parameter stripping and redirect unwrapping, used by search results, shopping, and export. |
| `src/main/ipc/tools.ts` | Three schemas, written as decision rules per the strategy doc's §1c (*"do not use for opinion questions — answer those directly"*). |
| `src/main/ipc/net.ts` | New `NetworkPurpose: 'shop'` so the activity log distinguishes retailer contact from ordinary browsing, and the per-turn summary can count sellers. |
| `src/main/ipc/store.ts` | `settings.shopping: { enabled, requireProxy, maxSellers, currency, watchCheckInterval }`, merged through the existing defaults pattern. |
| `src/renderer/src/lib/shopping.ts` | `looksLikeShopping()`, query minimization, offer formatting. |
| `src/renderer/src/components/OfferTable.tsx` | The comparison card, the model-read badge, the ☆ watch action, the provenance line. |
| `src/renderer/src/types.ts` | `ChatMessage.offers?: Offer[]` — display-only, excluded from wire history like `claimCheck` and `secondOpinion`. |

**Render path.** Reuses `renderPage` unchanged — shopping pages are exactly the
JavaScript-dependent case it was built for, and its filter (own origin only,
no images, no beacons, ephemeral session) is already stricter than what a
shopping trip in a normal browser does.

---

## 5. What this deliberately does not do

| Not doing | Why |
| --- | --- |
| Log in, add to cart, or check out | §0. The privacy guarantee is that no retailer ever sees an authenticated session from this app. |
| Store payment details or addresses | Nothing in the app should ever hold them; the design has no field for them. |
| Affiliate links or referral revenue | Every comparison tool that takes a cut has a reason to rank dishonestly. Sigma Oasis has no revenue model, and the links it shows are the bare product URLs with tracking parameters *removed*, not added. This is a promise worth being able to grep for. |
| Solve CAPTCHAs or evade bot detection | A blocked fetch is reported as blocked. Working around a retailer's refusal is neither the app's business nor a fight it wins. |
| Claim a price is *the* price | Retailers price by geography, session, and account. What the app reports is the **anonymous** price at a timestamp, and the card says so. A number without that caveat would be a confident guess dressed as a measurement — the exact thing v1.1 was built to stop. |
| Auto-buy on a price drop | Same reasoning as v1.2's rejection of silent retry: the alert is shown, the human decides. |

---

## 6. Honest limitations

- **The biggest retailers will block this.** Amazon, Walmart and similar
  aggressively refuse datacenter and Tor exit IPs. Expect 403s, and expect
  them to be *more* frequent in hardened mode — the privacy setting and the
  success rate trade against each other, directly. The card shows a blocked
  row rather than omitting the seller, so the user can see the gap and open
  that one themselves. Mid-size retailers, manufacturer direct sites, and
  specialist shops work considerably better.
- **A user-assisted path is the fallback, and should ship with v1.** Paste a
  URL, or paste the page text, and the extractor runs on that — no fetch, no
  IP exposure, works on every site. This is the *most* private mode and it
  should not be framed as a degraded one.
- **Anonymous prices can differ from yours.** Loyalty pricing, regional
  pricing, and cart-level discounts are invisible from outside. Disclosed on
  every card.
- **Structured data lies sometimes.** JSON-LD goes stale on badly-maintained
  sites. The fetch timestamp and the link out are the mitigation — the user
  confirms on the page before they spend money, always.

---

## 7. Tests

- Extraction ladder against fixture HTML per rung, including a page with
  JSON-LD that contradicts a visible price (structured wins, and the rung is
  recorded).
- Currency and unit-price normalization; `—` for missing rather than `0`.
- URL hygiene: parameter stripping, redirect unwrapping, idempotence.
- `requireProxy` refusal when the proxy is off — the path that must never
  silently degrade.
- Budget enforced before each fetch; disclosure string on the stop.
- `looksLikeShopping()` fixtures, including the opinion-question negatives.
- Watchlist persistence, history cap, atomic write.
- Wire-history exclusion for `offers`.
- No affiliate parameter is ever *added* to an outbound or displayed URL —
  asserted, not assumed.
