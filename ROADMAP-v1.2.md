# Sigma Oasis v1.2 — Roadmap & Feature Spec

Status: **proposed** · Target: v1.2.0 · Author: Colin Long

v1.1 shipped the grounding layer: auto-verification on factual turns, the
⚠️ unverified badge, automatic second opinions, and calmer temperature
defaults. That stack *prevents* confabulation (grounding rules, injected
search results) and *detects* it (badge, critic). What it deliberately does
not do yet is *settle* anything — the auto-critic names the check that would
verify a claim, but nobody runs it. v1.2 closes that last rung of the ladder:

> prevent → detect → review → **settle**

The same two design principles from v0.9/v1.1 constrain everything below:

1. **No self-graded confidence.** Claims are checked mechanically against
   sources, or by a different model with tools — never by the answerer
   rating itself.
2. **Verification is mechanical and visible.** The UI shows what was
   actually checked and what came back; it never asks a model to footnote
   itself and trusts the result.

---

## Scope summary

| # | Feature | Builds on | Effort | Risk |
| --- | --- | --- | --- | --- |
| 1 | Claim-check pass — settle the critic's list | grounding.ts, Second Opinion | L | Med |
| 2 | Critic with tools (auto path only) | runAutoCritic, web_search | M | Med |
| 3 | Claim annotations in the message bubble | §1 | M | Low |
| 4 | Role temperature presets + factual defaults | store.ts sampling | S | Low |

Deferred: per-conversation grounding toggles → v1.3. Rejected as stated:
always-on search for every turn, numeric "truth scores", the answerer
extracting its own claims. Rationale in §5.

---

## 1. Claim-check pass — settle the critic's list

**What the user gets.** Under a flagged answer, instead of only "claims we
couldn't verify," the app now checks them: each claim is marked **confirmed**,
**contradicted**, or **unverifiable** — with the source URL that settled it.
The Phish chat from v1.1's origin story ends with "Assessment Station (1996) —
contradicted: no such album in the band's discography (allmusic.com)," not a
polite apology.

**How it works.**

1. **Extraction (different model, no tools).** The critic slot — never the
   answerer — receives the answer and returns the bare factual claims as JSON:
   `[{ "claim": "...", "check": "..." }]`. Structured output only; tolerant
   parsing reuses the deep-research planner's JSON recovery (`llm.ts`).
   Claims capped (default 5) so the pass stays cheap.
2. **Settlement (mechanical).** For each claim, the app runs one `web_search`
   plus at most one `fetch_webpage` on the top result — the same query-budget
   discipline as deep research, enforced in code, not in the prompt. A claim
   is:
   - **confirmed** when a fetched source states it (matched by the critic
     model reading the passage against the claim — a narrow, single-claim
     judgment, not a self-grade);
   - **contradicted** when a source directly conflicts;
   - **unverifiable** when search returns nothing useful within budget —
     reported as such, never resolved by model intuition.
3. **Disclosure.** Every claim shows its source URL; every budget stop is
   stated ("2 of 5 claims checked — search budget reached").

**Implementation.**

- New `src/renderer/src/lib/claimCheck.ts` (extraction prompt assembly,
  result parsing, claim/verdict types) and a main-process budget wrapper
  around search/fetch, mirroring `deepResearch.ts`'s ledger.
- `types.ts`: `ChatMessage.claimCheck?: { claims: { text: string; verdict: 'confirmed' | 'contradicted' | 'unverifiable'; source?: string }[]; budgetNote?: string; createdAt: number }` —
  display-only, excluded from wire history like `secondOpinion`.
- Trigger: automatic on `unverified` answers (replacing §2's tools-less
  auto-critic when enabled), manual via the 🔍 menu. Respects
  `search.confirmBeforeSearch` — a declined search degrades the pass to the
  v1.1 behavior (critic names checks only), and the block says so.
- `store.ts`: `settings.claimCheck: { enabled: boolean; maxClaims: number }`,
  default **on** when second opinions are on.

**Tests.** JSON extraction recovery on malformed model output; verdict rules
(no source → unverifiable, never guessed); budget caps enforced; wire-history
exclusion; confirmBeforeSearch degradation path.

---

## 2. Critic with tools (auto path only)

**The intermediate rung**, shippable independently of §1: let the
auto-triggered critic call `web_search` / `fetch_webpage` so it can settle
the easy claims inline rather than only naming the check.

- Scope-limited deliberately: the **manual** Second Opinion keeps its
  tools-less design (fast, predictable, names checks for the user to run);
  the **automatic** path on unverified answers gets tools, because that path
  exists precisely to settle what the answerer asserted without sources.
- Guardrails: same `MAX_TOOL_ITERATIONS` cap as consultations, tool calls
  audit-logged, `confirmBeforeSearch` respected, and the critic's system
  prompt gains one line — "verify what you can; name the check for what you
  cannot."
- If §1 lands, §2 folds into it (the claim-check pass *is* a critic with
  tools, structured). Ship §2 first only if §1 slips.

**Tests.** Critic tool loop terminates at the cap; degraded (search-declined)
runs still produce the name-the-check list.

---

## 3. Claim annotations in the message bubble

**What the user gets.** The verdicts from §1 render inline, not in a separate
block: a subtle dotted underline on checked claims in the answer text —
green ✓ confirmed, red ✗ contradicted, amber ? unverifiable — with a hover
card showing the source and the one-line basis.

- Pure renderer work on top of §1's data: `markdown.ts` post-pass wraps
  matched claim spans; unmatched claims fall back to the §1 list block (fuzzy
  matching against model prose will never be perfect — disclosed, not hidden).
- Sanitization unchanged: annotations are added *after* DOMPurify, as data
  attributes on plain spans — no new HTML injection surface.
- Toggle under Settings → Appearance for users who want clean prose.

**Tests.** Span matching against rendered markdown; fallback list when a
claim's text can't be located in the answer.

---

## 4. Role temperature presets + factual defaults

Small, finishes what v1.1 started:

- **Presets in Settings → Models:** three one-click chips per slot —
  *Factual 0.3 · Balanced 0.5 · Creative 0.8* — instead of a bare number
  input. The number stays editable; the presets make the trade-off legible
  to users who shouldn't have to know what temperature is.
- **Default the remaining factual roles down:** Coder and Finance Coach join
  Assistant/Researcher at 0.3 for fresh installs. Saved values are never
  rewritten — `normalizeSampling` already guarantees that.
- Tooltip states the reasoning in one line: "Lower = fewer invented facts;
  higher = more varied prose."

**Tests.** Preset application per slot; saved-value preservation across the
settings merge.

---

## 5. Considered and rejected (as proposed)

| Proposal | Verdict | Why |
| --- | --- | --- |
| Search on *every* turn, not just factual ones | **Rejected** | Latency and egress on "hello" and "write a poem" buys nothing; the v1.1 heuristic's over-trigger margin is already the cheap direction. |
| Numeric truth/confidence score per answer | **Rejected** | Self-grading returns "yes" nearly always — unchanged since v0.9. §1's per-claim verdicts carry a source instead of a feeling. |
| The answerer extracts its own claims | **Rejected** | Self-reporting: a model that invented "Assessment Station" will faithfully extract it as fact. Extraction is the critic's job — a different slot with no stake in the answer. |
| Per-conversation auto-search toggle | **Deferred to v1.3** | Real demand is plausible (one chat private/offline, another researched), but the settings surface needs a conversation-level home first — the same problem per-chat memory scoping solved in v0.9. |
| Retry contradicted answers automatically | **Rejected** | Silent re-answering hides the contradiction the user most needs to see. The verdict is shown; the user decides. |

---

## Cross-cutting checklist (applies to every feature above)

- **Settings migrations:** new settings get defaults in `store.ts` and merge
  via the existing `{ ...defaults, ...current }` pattern.
- **Egress honesty:** §1/§2 add outbound queries the model didn't initiate —
  every one respects `confirmBeforeSearch`, appears as a tool call in the
  bubble, and lands in the audit log. The network activity log is a release
  checklist item, not an assumption.
- **Wire-history hygiene:** `claimCheck` and any new adornment are excluded
  from what is replayed to models — one shared serializer, per the v0.9
  checklist.
- **Budgets before work:** claim-check budgets are checked before each
  search, disclosed when hit — never reported after the fact.
- **Tests:** logic lands where the `node:test` suite can reach it;
  renderer-only code stays thin.
- **README:** each feature gets a section in the same voice — what it does,
  what it costs, what it deliberately does not do.
