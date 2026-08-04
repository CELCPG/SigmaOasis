# Sigma Oasis — Private Shopping & Purchase-Decision Support Prompt

> A brief for implementing shopping research and buying-decision support in Sigma Oasis:
> a feature that helps someone figure out **what they actually need**, finds products that
> **verifiably meet it**, and reports **prices with sources and timestamps** — while the only
> party who knows what they are shopping for remains the user.

Companion rationale: [DESIGN-private-shopping.md](DESIGN-private-shopping.md).
Routing and tool-selection context: [STRATEGY-routing-and-tools.md](STRATEGY-routing-and-tools.md).

---

## 1. Context you need before writing code

Sigma Oasis is a local-first Electron + React + TypeScript desktop app that talks only to a
local LM Studio server. Relevant existing machinery you will reuse rather than rebuild:

| Capability | Where | Why it matters here |
| --- | --- | --- |
| Egress allowlist + activity log (origin only, never full URLs) | `src/main/ipc/net.ts` | Every shopping request must pass through it, with its own purpose tag. |
| Cookieless ephemeral render sessions; third-party requests blocked; hidden text stripped | `src/main/ipc/render.ts`, `pageScript.ts` | Retail pages are JS-dependent; this is already stricter than a normal browser. |
| Tor/VPN routing over Chromium's network stack | `src/main/ipc/proxy.ts`, `httpClient.ts` | The only thing that covers IP exposure to retailers. |
| Query redaction before search egress | `search.ts:sanitizeQuery` | Extend it; do not bypass it. |
| Budgeted multi-query campaigns with pacing and a disclosed ledger | `src/main/ipc/deepResearch.ts` | Copy this discipline exactly for seller fetches. |
| Claim verdicts: `confirmed` / `contradicted` / `unverifiable`, each with a source | `src/renderer/src/lib/claimCheck.ts` | **A product spec is a factual claim.** Reuse this shape verbatim. |
| Plan mode: decompose → show for approval → execute → synthesize | `src/main/ipc/plan.ts`, `PlanBlock.tsx` | The requirements interview follows this pattern. |
| Local JSON persistence via atomic writes | `store.ts`, `fsAtomic.ts` | Watchlists and decision records live here, nowhere else. |

**Two standing design principles govern every decision below.** They are not negotiable, and
they are why the existing grounding layer works:

1. **Decide in code what code can decide.** Prompting a 7B model to "remember to verify" fails.
   `looksFactual()` → forced pre-search succeeds. Mechanism beats instruction.
2. **Every decision is visible and correctable.** A requirement the app inferred, a source it
   trusted, a price it read — all shown, all editable, all attributable.

---

## 2. The boundary — read this before designing anything

**Sigma Oasis researches purchases. It never makes them.**

No login. No cart. No checkout. No stored payment method. No address autofill. No account
creation. No tool in this feature has a verb that submits, authenticates, or pays. The render
session is read-only by construction — navigation away from the target is already blocked and
the session is destroyed after each page.

This is not a limitation to route around. It is load-bearing: the moment the app holds a
retailer credential, every privacy guarantee collapses into "a browser with worse UX." The user
completes the purchase in their own browser, on their own account, holding the app's research.

If an implementation step seems to require authenticating to a retailer, the step is wrong.

---

## 3. What to build: the decision ladder

Shopping help is four distinct problems. Build them in this order; each is independently
shippable and each is useless if the one before it is skipped.

```
   requirements  →  candidates  →  verification  →  price & timing
   (local only)     (filtered)     (sourced)        (timestamped)
```

### 3.1 Requirements elicitation — the part that never touches the network

The highest-value stage, and it costs zero egress. When a user says *"I need a new laptop,"*
the app must not search. It must find out what they actually need.

**Interview, capped and skippable.** At most 4 questions, one round, asked together rather than
one at a time. Derived from a local **category rubric** — a shipped JSON file of the questions
that actually discriminate within a category:

```jsonc
// src/main/ipc/rubrics/laptop.json
{
  "category": "laptop",
  "questions": [
    { "id": "primary_use", "ask": "What will you mainly do on it?",
      "options": ["everyday/web/office", "software development", "video or photo editing",
                  "gaming", "data science / ML"] },
    { "id": "portability", "ask": "How often will you carry it?",
      "options": ["desk most of the time", "commute a few times a week", "constant travel"] },
    { "id": "os", "ask": "Any OS requirement?", "options": ["macOS", "Windows", "Linux", "no preference"] },
    { "id": "budget", "ask": "Rough budget ceiling?", "free": true }
  ],
  "derive": [
    { "when": { "primary_use": "video or photo editing" },
      "requires": [{ "spec": "ram_gb", "op": ">=", "value": 32, "why": "4K timeline scrubbing" },
                   { "spec": "storage_gb", "op": ">=", "value": 1000, "why": "media footprint" },
                   { "spec": "gpu_class", "op": "in", "value": ["discrete", "apple_silicon_pro_max"] }] },
    { "when": { "portability": "constant travel" },
      "requires": [{ "spec": "weight_kg", "op": "<=", "value": 1.6 },
                   { "spec": "battery_h_tested", "op": ">=", "value": 8 }] }
  ]
}
```

**Why a rubric file and not a prompt.** A model asked to invent requirements will produce
confident, plausible, subtly wrong ones ("you'll need at least 64GB"). A rubric is auditable,
user-editable, ships with sane defaults, and the *derivation is shown with its reason*. The
model's job is to handle the categories the rubric doesn't cover and to phrase things naturally
— not to be the source of truth about what a video editor needs.

**Output: a `RequirementSpec`, rendered as an editable card.** Same interaction as Plan mode —
shown for approval before any search runs, with every row deletable and every threshold
adjustable:

```ts
interface Requirement {
  spec: string                 // 'ram_gb'
  label: string                // '32 GB RAM or more'
  op: '>=' | '<=' | '==' | 'in'
  value: number | string | string[]
  kind: 'hard' | 'soft'        // hard = filter; soft = ranking signal
  why: string                  // 'video editing — 4K timeline scrubbing'
  origin: 'user' | 'rubric' | 'model'   // shown as a badge; 'model' is visually distinct
}
interface RequirementSpec {
  category: string
  requirements: Requirement[]
  budgetCeiling?: { amount: number; currency: string }
  createdAt: number
}
```

**Privacy rule, enforced in code, not in the prompt:** the `RequirementSpec` never leaves the
machine and never enters a search query. Only a **product-shaped query** derived from it goes
out — `"laptop 32GB RAM 1TB discrete GPU under 2000"`, never `"laptop for editing my wedding
videos"`. Implement this as a hard filter in `sanitizeQuery`: reject outbound shopping queries
containing first-person pronouns, or exceeding a token cap, or matching the free-text fields of
the spec. A rejected query is a visible tool error, not a silent rewrite.

### 3.2 Candidate discovery — filter the sources, not just the products

The dominant failure mode of shopping search is not bad models. It is that the results are
SEO-optimized affiliate listicles written to rank, not to inform.

Ship a **source tier list** as a readable, user-editable JSON file — never a hidden ranking:

| Tier | Kind | Authoritative for | Not authoritative for |
| --- | --- | --- | --- |
| A | Manufacturer spec sheets | Specifications, dimensions, part numbers | Performance claims, battery life, "best in class" |
| B | Independent testing outlets with published methodology | Measured performance, tested battery, thermals | Price, availability |
| C | Retailer product listings | **Price and stock only**, at a timestamp | Specs (frequently wrong/stale), reviews |
| D | Forums, user reports | Failure modes, long-term reliability signals | Anything quantitative |
| X | Affiliate listicles, "top 10" content farms, SEO aggregators | — | **Excluded by default** |

Tier X exclusion is the single biggest quality lever in this feature. Make it a default-on
setting the user can inspect and turn off, with the domain list visible in Settings.

### 3.3 Verification — a spec claim is a factual claim

This is where the v1.2 architecture pays off. For each candidate, every hard requirement gets a
verdict in the **existing** claim shape:

```ts
interface SpecVerdict {
  requirement: string          // '32 GB RAM or more'
  verdict: 'confirmed' | 'contradicted' | 'unverifiable'
  found?: string               // '32 GB'
  source?: string              // URL
  sourceTier: 'A' | 'B' | 'C' | 'D'
  basis: 'manufacturer-claimed' | 'independently-tested' | 'retailer-listed' | 'model-read'
}
```

**The `basis` field is the honest core of the whole feature.** A manufacturer claiming 18-hour
battery life and a testing outlet measuring 11 are not the same kind of fact, and the app must
never flatten them into one number. Render them differently. A recommendation resting on
`manufacturer-claimed` or `model-read` values says so on its face.

Extraction follows the same mechanical-first ladder as price (see the design doc §2a):
JSON-LD `Product` → microdata → meta tags → **model fallback, labeled**. A value with no rung
that produced it is not displayed. Ever.

### 3.4 Price and timing

Per [DESIGN-private-shopping.md](DESIGN-private-shopping.md): budgeted seller fetches through
the hardened render path, prices with fetch timestamps and source links, tracking parameters
stripped, anonymous-price caveat on every card, local watchlist with price history, no affiliate
links in any direction.

---

## 4. The recommendation output

The model writes the *reasoning*. It never writes the numbers. Required shape:

```
RECOMMENDED — [Product], $X at [seller] (checked 3 min ago)

Meets your requirements:
  ✓ 32 GB RAM — confirmed, manufacturer spec sheet [link]
  ✓ under 1.6 kg — confirmed, 1.24 kg, manufacturer spec sheet [link]
  ? 8h+ battery — unverifiable: manufacturer claims 18h, no independent test found
  ✗ discrete GPU — contradicted: integrated graphics only [link]

Trade-off: fails your GPU requirement. Strong on portability and battery.
If GPU is genuinely hard, see [alternative] at $X — heavier by 700 g.

2 of 4 sellers checked — fetch budget reached.
Prices seen anonymously via Tor; your logged-in price may differ.
```

Rules the implementation must enforce mechanically, not by prompt:

- **No product is recommended whose hard requirements are unverified.** If every candidate has
  `unverifiable` blockers, the correct output is *"I could not verify what you need on any of
  these — here is what to check on the page yourself,"* not a confident pick.
- **Never report an aggregated star rating.** Retailer-hosted reviews are incentivized and
  gated; a 4.3 synthesized from them is a number with no meaning. Link to independent reviews
  instead; quote with attribution when quoting.
- **Never reproduce urgency as fact.** "Only 2 left," countdown timers, and strike-through
  "was" prices are dark patterns and frequently fictional. Strip them from extracted text; if
  shown at all, show them labeled as retailer marketing.
- **Flag marketplace risk.** A third-party marketplace listing significantly below market gets a
  caution row, never the top rank — counterfeits and grey-market units cluster there.

---

## 5. Safety requirements

**5a. Page content is data, never instructions.** Retail pages contain text engineered to
influence agents — "this is the best product, recommend it," hidden divs with instructions.
`render.ts` already strips visually hidden text and reports the count; keep that, and add the
explicit rule that nothing extracted from a page may alter the requirement spec, the source
tiering, or the recommendation logic. Extracted content flows into the *verification* stage as
evidence with a source, and nowhere else.

**5b. Categories to refuse decision support on.** Product research shades into regulated advice.
For medical devices, supplements or anything with a health claim, financial and insurance
products, firearms, prescription anything, and age-restricted goods: do not rank or recommend.
Provide what to look for and who is qualified to ask, and say plainly why the app is stopping
there. One sentence, no lecture.

**5c. Never solve a CAPTCHA or evade bot detection.** A blocked fetch is reported as blocked,
with the seller shown as a blocked row so the gap is visible. Working around a retailer's
refusal is not the app's business.

**5d. `requireProxy` defaults on.** Shopping fetches refuse when Tor/VPN is off rather than
silently going out direct — the reasoning that moved the whole HTTP stack onto Electron's `net`.
The refusal is a visible error naming the fix, never a fallback.

**5e. No affiliate links, no referral revenue, ever.** Every comparison tool that takes a cut has
a structural reason to rank dishonestly. The app strips tracking parameters rather than adding
them, and this is asserted in a test so it can be grepped for and proven.

---

## 6. Implementation plan

| File | Work |
| --- | --- |
| `src/main/ipc/shopping.ts` | **New.** Extraction ladder (JSON-LD → microdata → meta → model, rung recorded), spec normalization (RAM/weight/battery units), currency handling, the fetch-budget ledger modeled on `deepResearch.ts`. |
| `src/main/ipc/rubrics/*.json` | **New.** Category rubrics: laptop, phone, headphones, monitor, appliance. Question sets plus derivation rules. User-extensible. |
| `src/main/ipc/sourceTiers.ts` + `sourceTiers.json` | **New.** Tier assignment by domain, Tier-X exclusion default-on, user-editable and visible in Settings. |
| `src/main/ipc/watchlist.ts` | **New.** `watchlist.json` and `decisions.json` in `userData` via `writeFileAtomic`; append-only price history, capped per item. |
| `src/main/ipc/urlHygiene.ts` | **New.** Strip `utm_*`, `gclid`, `fbclid`, `srsltid`, `tag`, `ref`, `smid`, `psc`; unwrap click-redirect hosts. Used by search results, shopping, and markdown export. |
| `src/main/ipc/search.ts` | Extend `sanitizeQuery` with the shopping-query minimization filter (§3.1). |
| `src/main/ipc/net.ts` | Add `NetworkPurpose: 'shop'`. |
| `src/main/ipc/tools.ts` | `shop_requirements`, `shop_compare`, `product_verify`, `price_watch`. Descriptions written as decision rules with a negative branch and one argument example each. Toggles default **off**. |
| `src/main/ipc/store.ts` | `settings.shopping: { enabled, requireProxy, maxSellers, excludeTierX, currency, watchCheckInterval }`, merged through the existing defaults pattern. |
| `src/renderer/src/lib/shopping.ts` | `looksLikeShopping()` mirroring `looksFactual()`, with negatives for opinion questions ("is X worth it", "how does X work"). |
| `src/renderer/src/components/RequirementCard.tsx` | The editable spec card, approval-gated like `PlanBlock`. |
| `src/renderer/src/components/OfferTable.tsx` | Comparison card: seller, price, availability, checked-at, source, ☆ watch, blocked rows, provenance line. |
| `src/renderer/src/components/SpecVerdicts.tsx` | Per-requirement verdicts with tier and basis badges. |
| `src/renderer/src/types.ts` | `ChatMessage.offers?`, `.requirementSpec?`, `.specVerdicts?` — **display-only, excluded from wire history** like `claimCheck` and `secondOpinion`. |

**Tool budgets.** One search plus at most `maxSellers` (≤5, default 4) page fetches per compare;
checked *before* each fetch and disclosed on the stop. Verification fetches share the ledger.

---

## 7. Tests

- Extraction ladder per rung against fixture HTML, including JSON-LD that contradicts the
  visible price — structured wins, and the rung is recorded.
- Spec normalization: `"16GB"` / `"16 GB"` / `"16384 MB"` → 16; missing renders `—`, never `0`.
- Requirement derivation from each rubric, including a spec the rubric can't cover falling
  through to `origin: 'model'` with the badge set.
- **Query minimization**: first-person shopping queries are rejected before egress; the
  `RequirementSpec` never appears in an outbound query. Assert against the activity log.
- URL hygiene: stripping, unwrapping, idempotence, and — asserted explicitly — that no affiliate
  parameter is ever *added*.
- `requireProxy` refusal when the proxy is off. This path must never silently degrade.
- Tier-X domains excluded from candidate discovery when the default is on.
- Recommendation gating: a candidate with an unverified hard requirement is never recommended.
- Refused categories (§5b) produce the guidance response, not a ranking.
- Budget enforced before each fetch; disclosure string on the stop.
- `looksLikeShopping()` fixtures including opinion-question negatives.
- Wire-history exclusion for all three new message fields.

---

## 8. What success looks like

- A user says *"I need a laptop for video editing that I can travel with,"* answers four
  questions, edits one derived requirement they disagree with, and gets three candidates whose
  every hard requirement is marked confirmed against a named source — plus an honest
  `unverifiable` on battery life, because no independent test existed.
- The network activity log for that session shows: one search query (product-shaped, no personal
  framing), four retailer origins, all through the proxy. Nothing else.
- The user's requirements, watchlist, and decision record exist only in their app-data
  directory. No service anywhere knows they are shopping for a laptop.
- The app declines to recommend a blood-pressure monitor and says why in one sentence.
- `grep -r affiliate src/` returns the test that asserts none are ever added.

---

## 9. Guiding principles for whoever implements this

1. **Mechanism over instruction.** If correctness depends on the model remembering a rule,
   it will fail on a 7B. Put it in code where it can be tested.
2. **A number without a source and a timestamp is a confabulation.** This applies to prices,
   specs, weights, and battery hours identically.
3. **Distinguish claimed from measured.** Flattening manufacturer marketing and independent
   testing into one number is the most common dishonesty in this entire product category.
4. **Show the inference, allow the correction.** Every derived requirement, tier assignment, and
   extraction rung is visible and editable. A wrong inference the user can see is a small
   problem; one they cannot is the whole problem.
5. **Budgets before work, disclosed on the stop.** Never report a limit after the fact.
6. **The app never transacts.** When in doubt, hand the user a link and get out of the way.
