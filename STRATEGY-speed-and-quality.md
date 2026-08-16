# Strategy: Speed & Quality — post v1.4.6

**Status: Part 1a/1b/1c and Part 2a shipped in v1.4.7 · Part 2b, the `markdown.ts` suite and hook split from 2c, and the `tools.ts` dispatch table + loopback dedupe from 2d shipped in v1.4.8 · Part 1d, the rest of 2c/2d, and Part 3 proposed (Part 3 is re-sequenced behind the Almanac — see `STRATEGY-depth-and-reasoning.md`).**
Written against the v1.4.6 codebase (commit 81992aa). Companion to
`STRATEGY-routing-and-tools.md` (Layers 0–4, shipped) and `ROADMAP-v1.2.md` (prevent →
detect → review → settle, shipped). Those two ladders made answers *honest*. This one makes
the app *fast*, fixes the known bugs sitting in the untested band, and proposes the next two
capability features.

---

## Part 0 — Where v1.4.6 stands

A fair review of the codebase finds it in unusually good shape where past strategy docs
aimed effort, and predictably weak exactly where they didn't:

**Strengths (keep doing this):**
- The pure-logic extraction strategy worked. `agentLoop.ts`, `contextBudget.ts`,
  `toolGrounding.ts`, `toolSelection.ts`, `routing.ts` etc. are all headless, all tested —
  51 test files, ~1,043 checks, zero test dependencies, production code byte-for-byte what
  ships. The eval harness measures tool-choice quality with printed caveats.
- Security posture is strong and documented: sandbox + contextIsolation, navigation
  lockdown, purpose-keyed egress allowlist with an activity log, `UNTRUSTED_HEADER` on all
  web-derived text, structural refusal to persist ephemeral chats, safeStorage-encrypted
  secrets, atomic writes everywhere.
- Comment quality is exceptional — constants carry rationale with dates and measurements.
  `researchIndex.ts` (RAM-only, LRU+TTL, unit-vector cache, RRF+MMR) is the model the rest
  of the codebase should copy.

**Weaknesses (this document):**
1. **Streaming performance.** One store commit per token re-renders every bubble (no
   `React.memo` anywhere) and re-parses the entire accumulated markdown of the streaming
   reply — O(n²) in reply length, on the UI thread.
2. **Main-process I/O habits.** `getSettings()` is a synchronous disk read + JSON parse
   with 35 call sites on hot paths. `memory.json` is fully re-parsed per search. Whole
   conversations (with inline 256 KB image data URLs) are re-serialized per turn and all
   parsed at startup.
3. **Known bugs in the untested band.** All React components and hooks are untested — and
   that is exactly where the concrete bugs are (hooks-after-early-return, a Stop button
   that can't stop bubble-initiated turns, 11 `BrowserWindow.fromWebContents(...)!`
   assertions that throw if a window closes during a pending dialog).
4. **Unbounded growth.** `memory.json`, the `conversations/` directory, and the `audit/`
   directory have no caps, no rotation, and are read-whole-then-parse. A heavy user's
   install degrades along all three.
5. **God files.** `SettingsModal.tsx` 2,331 · `useLMStudio.ts` 2,292 · `search.ts` 1,403 ·
   `deepResearch.ts` 935 · `store.ts` 893 · `tools.ts` 830 (one 470-line switch).

---

## Part 1 — Speed

Ordered by measured leverage, not by ease. Each item names the fix and the file.

### 1a. Break the per-token re-render cascade (renderer, highest UI leverage)

Today one token → `patchMessage` (appStore.ts:142) rebuilds the conversations array →
`App.tsx:17`'s `.find()` returns a fresh object → App, Sidebar, InputBar re-render →
`ChatArea.tsx:102` maps every message → every `MessageBubble` re-renders, each
instantiating `useLMStudio()` again. At 40 tok/s in a 200-message chat that is ~8k object
allocations and a full-list render per second.

- **Move streaming text out of the message array.** A `streamingTail: {messageId, text}`
  slice (or ref + local subscription in the tail bubble) so a token commits to exactly one
  subscriber. `patchMessage` runs once, at stream end.
- **Batch commits on a frame clock.** Even with the slice, commit the tail on
  `requestAnimationFrame` (~60/s ceiling) rather than per SSE chunk.
- **`React.memo` on `MessageBubble` and `ToolCallBlock`** — there is currently none in the
  entire renderer. Finished bubbles must not render during streaming.
- **Stop calling `useLMStudio()` per bubble** (MessageBubble.tsx:230). Lift the 6 callbacks
  into a context or the store; N bubbles currently rebuild the hook on every render.

### 1b. Stop re-parsing the world per token (renderer)

- **Incremental markdown.** `MessageBubble.tsx:222` re-runs `marked.parse` +
  `hljs.highlight` + `DOMPurify.sanitize` over the entire accumulated reply per token —
  O(n²). Split at the last complete block: parse the stable prefix once, re-render only the
  open tail block. Failing that, throttling the full parse to rAF cadence removes most of
  the cost with a 10-line change.
- **Memoize the context meter.** `InputBar.tsx:117` reduces over every message and every
  tool-result string per render, un-memoized (`contextBudget.ts:83`).
- **Give the Sidebar a derived subscription.** It subscribes to `conversations` wholesale
  (Sidebar.tsx:13), so it re-sorts per token, and an active search query lowercases the
  full corpus per token (:55). Subscribe to a derived `{id, title, updatedAt}[]`.
- Virtualize `ChatArea` / `Sidebar` only after the above; with memo + tail-slice the
  win is small until conversations get very long.

### 1c. Cache what the main process re-reads (main, highest overall leverage)

- **Memoize `getSettings()`** (store.ts:891). electron-store's `conf` does
  `fs.readFileSync` + parse **on every access**; there are 35 call sites including once per
  audit entry, per completion, per embedding batch, per fetch (via `proxyActive()`), and
  inside deep-research rounds. One cached object invalidated in `store:setSettings` is the
  single highest-leverage fix in the codebase.
- **Keep `memory.json` in RAM with unit vectors** (memory.ts:61-68). Today every
  `memory_search` re-parses the whole file (~25 MB at 2,000 chunks of 768-dim JSON floats)
  and `cosine()` recomputes both norms per pair. `embeddings.ts:188-203` already has
  `toUnitVector`/`unitDot`; use them, cache the parsed store, invalidate on write.
- **Cache the egress proxy config** — `getEgressSession()` round-trips `setProxy()` to the
  network service on *every* fetch (proxy.ts:120-131). Re-apply only when the config
  changes.
- **Cache STT detection** (voice.ts:143-174) — currently a `which` child-process spawn plus
  a chain of fs probes before every push-to-talk clip.

### 1d. Make persistence O(what changed), and bounded (main)

- **Sidecar image blobs.** Conversations inline image-search galleries as data URLs up to
  256 KB each (tools.ts:73); `saveConversation` re-stringifies the entire conversation per
  turn (store.ts:849) and `conversations:list` parses every file at startup (store.ts:822).
  Store blobs as files referenced by id; keep an index file of `{id, title, updatedAt}` so
  startup reads one small file and conversations load lazily.
- **Cap and rotate.** `memory.json`, `conversations/`, and `audit/` are the three unbounded
  stores (audit also does sync `safeStorage.encryptString` per entry and re-reads every
  session file whole on every `audit:status`). The watchlist and research index show the
  house style for bounds — apply it.
- **Take PDF parsing off the main thread** (pdf.ts, 532 lines, `inflateSync`, up to 40 MB
  decompressed) — a `worker_threads` move, mechanical since the module is already pure.
  Same class: `extract.ts` regex passes and `voice.ts:82` RMS loop.
- **Reuse the render window** (render.ts:137) — a fresh partition + BrowserWindow per
  rendered page is a renderer-process startup per page; a deep-research round pays it up
  to 8×. Pool one hidden window per proxy-config generation; also fix the 20s deadline
  timer that is never cleared (:236).

---

## Part 2 — Quality

### 2a. Fix the known bugs first (small, high-severity, all in the untested band)

| Bug | Where | Fix |
| --- | --- | --- |
| Hooks called after early return — count differs by role | MessageBubble.tsx:243,255 vs :298-300 | Hoist the three `useAppStore` reads above the returns |
| Stop button aborts the wrong controller — `abortRef` is per-hook-instance, so bubble-initiated turns (regenerate / second opinion / escalate) can't be stopped from the composer | useLMStudio.ts:1922, InputBar.tsx:49 | Move the abort controller into the store (also enables 1a's callback lift) |
| `BrowserWindow.fromWebContents(...)!` throws if the window closes during a pending confirm — reachable during deep research or a terminal confirm | 11 sites: tools.ts ×4, store.ts, audit.ts, traces.ts, attachments.ts, index.ts ×2, updates.ts | Null-check helper; treat "no window" as "decline" |
| `getAllWindows()[0]` on background update download with all windows closed (macOS) throws in an event listener | updates.ts:67 | Same helper; skip the notify |
| Stale effect deps capture first `load`/`refresh` | App.tsx:54-59 | Fix deps, drop the eslint-disable |
| `updates.ts` `setInterval` never cleared; re-reads settings via sync disk read | updates.ts:104 | Clear on quit; use the 1c settings cache |

### 2b. Close the two privacy gaps that contradict the docs

- **`baseUrl` is not constrained to loopback** (store.ts:539, net.ts:128). A remote value
  sends conversation content off-machine on the *deliberately un-proxied* local session.
  Constrain to loopback/private addresses at normalization, with an explicit opt-out
  setting if remote LM Studio is a real use case — the current behavior is the worst of
  both: silent and un-proxied.
- **Chat traffic bypasses the activity log** — `useLMStudio.ts:340` fetches
  `/chat/completions` directly from the renderer, so the log's implicit "everything is
  here" claim excludes the highest-volume path. Either route through `auditedFetch` or
  state the exclusion in the Privacy UI. (Also: `store:setSettings` spreads unknown keys
  into `config.json` verbatim — normalize should drop them.)

### 2c. Test what the strategy docs already flagged

- **`markdown.ts` has no test** — it is the one sanitization boundary (XSS surface), and
  ROADMAP-v1.2 §3 proposes writing claim annotations into rendered markdown *after*
  DOMPurify. Write the pinning suite before touching that pipeline again.
- **Finding H is only half closed.** The loop left `useLMStudio.ts`, but 2,292 lines
  remain: compaction, consultation, claim-check, revision, plan mode, second opinion,
  escalation, voice, stats, audit. Continue the extraction that worked: each concern to a
  headless module with the hook as thin glue, each extraction landing with tests. Target:
  the hook under 500 lines by the end of this ladder.
- **Component smoke tests** for the three fixed bugs in 2a, so they stay fixed — the
  hooks-order bug is invisible to every existing test by construction.
- CI runs on macOS only; add a Linux leg (tests already skip display-dependent checks
  gracefully).

### 2d. Structure: shrink the god files, dedupe the idioms

- `tools.ts`: replace the 470-line switch with a dispatch table (name → handler module);
  each tool owns its formatting. This also gives Feature A (below) its extension point.
- `search.ts` (1,403): split into provider clients / image providers / thumbnail pipeline /
  cache / SSRF+fetch pipeline — five jobs, five modules.
- `SettingsModal.tsx` (2,331): one component per tab; the 9 `tab ===` branches are already
  the seams.
- Shared helpers, each currently copy-pasted: `uid()` (×6 across both processes),
  `errorMessage(err)` (the ternary appears in 20 of 40 main files), `conversationsDir()`
  (duplicated with its path-traversal regex in traces.ts — a tightening will miss one
  copy), the bounded-worker-pool (hand-rolled ×3), the read-modify-write queue (×2).
- `store:getSettings` shallow-merges defaults while `setSettings` deep-normalizes — reads
  and writes have different guarantees; route both through `normalizeSettings`.

### Sequencing

Ship as two releases, measured the way this repo measures things:

- **v1.4.7 — "the fast one":** 1a + 1b + 1c + 2a. User-visible claim: long replies stream
  at full speed with no UI stutter; Stop always stops. Measure: time-to-render a 2,000-line
  streamed reply before/after; allocations per token; `memory_search` latency at 2k chunks.
- **v1.4.8 — "the bounded one":** 1d + 2b + 2c + 2d. User-visible claim: startup time flat
  in conversation count; install size bounded; privacy log complete or honestly scoped.

---

## Part 3 — Two new features

Both chosen to compound what is already built rather than open new fronts. The routing
ladder made tool *choice* trustworthy; the honesty ladder made answers *checkable*. The
next rung on each:

### Feature A — Bring-your-own tools: MCP client with the house discipline

**What.** Sigma Oasis becomes an MCP (Model Context Protocol) client: a user can connect
local MCP servers (stdio) and, explicitly opt-in, remote ones — and their tools join the
native 21 under exactly the regime the native tools already live under:

- Schemas ingested into the same registry the eval harness grades against; descriptions
  rewritten (or wrapped) into the same use-when / do-not-use-when decision-rule format,
  because that format measurably fixed tool confusion for small models.
- Per-role allowlists, embedding subsetting, the 6-tool turn cap, per-tool budgets, and
  identical-call reuse all apply unchanged — `toolSelection.ts` doesn't care where a
  schema came from.
- Every remote MCP host enters the egress allowlist as a named host with a purpose, shows
  in the activity log, follows the proxy, and gets a consent dialog on first use. Tool
  output is prefixed `UNTRUSTED_HEADER` like all foreign text. Ephemeral chats refuse
  MCP tools that declare network access.
- The eval harness gains fixture generation for connected servers, so "did adding this
  server degrade tool choice" is a measured question — the same way Layer 1 was.

**Why this one.** It is the largest capability multiplier available per line of code:
the hard parts (routing, subsetting, budgets, grounding, egress mediation, eval) are
built and tested; MCP is "only" a transport + schema adapter behind the `tools.ts`
dispatch table from 2d. It turns a 21-tool app into an unbounded-tool app while keeping
the two properties competitors give up first: measured tool choice and a complete
network story. No other local-first chat client offers MCP *with an egress allowlist
and an activity log*.

**Honest risks.** Third-party descriptions are prompt-injection surface (mitigated: the
untrusted header, and description-wrapping rather than pass-through); small models degrade
as tool count grows (mitigated: subsetting already caps the per-turn schema count; the
eval measures the rest); remote MCP is a new egress class (mitigated: opt-in, named
hosts, never wildcards).

### Feature B — The fact ledger: verification that compounds

**What.** Today the claim-check and grounding passes spend model calls and searches
verifying a claim, render a badge — and throw the work away. The ledger keeps it. A claim
that survives verification is written to a local, queryable store:

```
{ claim, normalized entities, verdict, source URL, source tier, checked-at, content hash }
```

- **Recall before search.** A factual turn consults the ledger first; a hit within its
  freshness window is injected as reference context labelled "verified <date> from
  <source>" — the answer cites it, and the check that would re-settle it is one click.
- **Freshness is typed, not guessed.** Prices and availability expire in hours, addresses
  and dates in months, historical facts effectively never. An expired hit is *presented
  as a lead, not an answer* — it seeds the search query rather than the reply.
- **Contradictions are events.** When a re-check contradicts a ledger entry, the entry is
  updated and the change surfaces ("this differs from what was verified on <date>") —
  which is exactly the class of stale-world error (the bankrupt retailer in v1.4.6's
  notes) that currently gets caught only when the grounding pass happens to fire.
- **Same storage discipline as everything else:** local JSON via the bounded-store
  pattern, per-source purge, visible in Settings → Memory alongside the vector store,
  never populated from ephemeral chats.

**Why this one.** It converts the app's most expensive habit — verification, 2 + 2×N
round trips per claim-checked turn — from a per-turn cost into accumulating intelligence.
On a local model, avoided searches and avoided round trips are the difference between a
20-second answer and a 3-second one, so this is a *speed* feature wearing a *quality*
coat. And it deepens the moat: the honest-answer machinery becomes a compounding asset no
fresh install has.

**Honest risks.** A ledger can launder a wrong verification into confident reuse —
mitigated by the freshness types, by always showing provenance, and by the standing rule
that a contradiction beats a cache hit. Entity normalization is genuinely hard —
mitigated by starting with the claim classes `toolGrounding.ts` already extracts
mechanically (money figures, addresses, URLs, contacts, dates).

**Runner-up, noted for later:** the in-app LoRA loop (the Layer 4 trace factory already
exports MLX-ready SFT data; the missing piece is an in-app training/eval/adopt cycle).
Deferred because it is Apple-Silicon-only today and both features above serve every
platform.

---

## Rejected along the way

| Idea | Why not |
| --- | --- |
| Virtualize the message list first | Treats the symptom; with memo + a streaming tail slice, full-list renders stop happening at all. Revisit for 1,000-message chats. |
| Web Worker for markdown | The O(n²) re-parse is the bug, not the thread it runs on. Incremental parsing fixes the cost; a worker would add serialization overhead to hide it. |
| Move chat streaming into the main process to unify the audit path | Largest refactor for the smallest gap; disclosure in the Privacy UI plus optional routing achieves the honesty goal without rebuilding streaming. |
| SQLite for conversations/memory | The bounded-JSON pattern with an index file gets 90% of the win without a native dependency in a zero-dependency test culture. Revisit if the fact ledger outgrows it. |
| A dedicated router model, LangGraph, `tool_choice: required` | Re-rejected for the same reasons as in STRATEGY-routing-and-tools.md. |
