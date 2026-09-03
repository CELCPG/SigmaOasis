# Strategy: Capability multipliers — post v2.2.0

**Status: v2.3 (C1, the Electron upgrade) shipped 2026-09-02 with round 14 as its gate; v2.4 in progress — C5 done, C4 mostly done (the grounding split and the Settings split; the hook extraction is deferred to v2.5 with its reason in the v2.4 notes), C2 landed, C3 measured and narrowed to the two unbounded stores, both now bounded, B1 closed by evidence, B2 measured to a zero noise floor with the instrument fixed (both below); v2.5 — A1 (the MCP client) landed and gated: with the app's own per-turn selection, correct-tool and spurious-call rates are identical at 0, 4 and 12 connected servers (the raw-list finding and the table are in `docs/evals.md`), B3 closed by evidence; v2.6 — A2 (the fact ledger) landed and gated by the `claims` suite (second asks that searched 20/20 → 9/20, every unchanged case answered from a dated entry, every changed price surfaced as a contradiction; seconds did not fall, stated), A3 (standing questions) landed, A4 (outline-then-fill) built behind a switch that ships off pending the `longform` suite, plus the four OpenClaw adoptions (memory origins, standing grants, the privacy audit, MCP approval modes) — `STRATEGY-openclaw-adoptions.md`.** Written 2026-09-01 against v2.2.0 (commit d130348), after reading the
five earlier strategy documents, the v2.1/v2.2 release notes, `docs/evals.md`, the
head-to-head record (`docs/head-to-head/rounds.json`, verdicts 8–13), and the source tree.
Companions: `STRATEGY-routing-and-tools.md` (Layers 0–4, shipped), `STRATEGY-speed-and-quality.md`
(Parts 1a–1c, 2a–2d shipped; 1d and Part 3 open), `STRATEGY-depth-and-reasoning.md` (Features
A and B shipped; items 5–7 open), `STRATEGY-harness-adoptions.md` (Tier 1 mostly shipped;
Tiers 2–4 open), `STRATEGY-market-analysis.md` (all three phases shipped).

The one-line thesis: **the honesty and interface ladders are built and measured; the next
two releases should spend on features that multiply what the app can do, on the platform
debt that gates them, and on the three problems the evals say are still open — with the
head-to-head bench demoted from roadmap generator to release gate.**

---

## Part 0 — Where v2.2.0 stands

### What the record shows

- 396 commits in five weeks; 2,574 node checks plus eight real-Electron check suites; CI on
  macOS and Linux; signed, notarized, auto-updating releases on three platforms.
- Every earlier strategy named its eval gate and most gates exist: tool choice, library
  grounding, quantitative (bare vs Workbench), deep research, reasoning, multi-turn,
  project recall, market indicators, plus the 18-task blind head-to-head.
- Rounds 9–13 of the bench: **20 task wins, 1 loss, 68 ties**. The method (each round built
  from the previous round's ties) worked, and it is now yielding narrow, specific wins per
  round at roughly a day of build-and-judge each. The bench measures the interface and the
  plumbing by design; it cannot say anything about capability, which is where the largest
  unbuilt value sits.

### The residue: proposed, never shipped

| Source | Item | State at v2.2.0 |
| --- | --- | --- |
| harness-adoptions T1.4 | Shared streaming core | **Open.** `hooks/chatTransport.ts` (773 lines) and `main/ipc/llm.ts` (561) are still two SSE clients with separate timeout and reasoning handling. |
| harness-adoptions T2 / speed Part 3A / depth item 6 | MCP client | **Open.** `docs/mcp-client-scope.md` is complete (stdio, tools only, ~2,100 LOC, zero deps); no code exists. Proposed three times. |
| speed Part 3B / depth item 5 | Fact ledger | **Open.** Proposed twice, never started. |
| harness-adoptions T3 | Code Mode in the Workbench | **Open.** |
| harness-adoptions T4 | Spill for oversized tool results; mid-turn steering; replayable tool cards | **Open.** |
| speed 1d | Persistence bounds | **Open.** `conversations:list` (`store.ts:971`) still reads and parses every conversation file at startup; image galleries are still inline data URLs; the audit directory has a per-entry cap and no rotation; no total-size bound on `memory.json`. |
| speed 1d | PDF parsing off the main thread; render-window reuse | **Open.** No `worker_threads` in `main/ipc`; `render.ts` still creates a window per page. |
| speed 2b | Chat traffic in the activity log | **Half open.** The loopback constraint shipped (`store.ts:498`); the renderer still fetches `/chat/completions` directly (`chatTransport.ts:580`), so the log's "everything is here" claim still excludes the highest-volume path. |
| depth item 7 | Outline-then-fill for long answers | **Open.** |
| depth "how it grows" | ZIM packs (offline Wikipedia / WikiMed) | **Open.** |
| routing Layer 4 runner-up | In-app LoRA loop | **Open**, deferred as Apple-silicon-only. |

### The measured problems still open

| Problem | Number | Where measured |
| --- | --- | --- |
| Session follow-ups re-read the data file | 67–73% of follow-ups, after both the playbook step and the ledger were tried | `docs/evals.md`, multi-turn |
| Library suite variance | ±3 cases between identical runs at temperature 0; three named flaky failure shapes (tool call as prose, half-summarized section, echoed turn-notes header) | `docs/evals.md`, library |
| Think-harder is a null result on arithmetic | 7/14 revised, 0 score change, 2.6× latency | `docs/evals.md`, deliberation |
| Bench gap register | 76 gap entries across six dimensions, 41 closed, 27 rated high | `rounds.json` |
| Reference arm | Every automated route closed on the bench machine | `rounds.json` |

### New debt the last five rounds created

- **`lib/toolGrounding.ts` is 4,003 lines** — the largest file in the tree, grown by every
  round since v1.12. It already carries seventeen `// ---- section ----` markers, which is
  the split waiting to happen.
- `SettingsModal.tsx` is 2,546 lines and `useLMStudio.ts` 1,457 (the v1.4.7 target was
  under 500).
- **Electron 31.7.7.** Released mid-2024, out of the supported window since early 2025.
  A privacy app is shipping a Chromium that stopped receiving security fixes eighteen
  months ago. Its bundled Node 20 also lacks `zlib` zstd, which ZIM packs need.
- Twenty-two agent worktrees under `.claude/worktrees/` and some thirty leftover
  `worktree-agent-*` branches.
- Version markers that do not exist: `toolGrounding.ts:1941` says `(v2.3)`,
  `toolGrounding.ts:2362` and `measurements.ts:269` say `(v2.5)`, and the README says
  "since 2.5" twice (lines 51 and 330) — while the shipped version is 2.2.0. These are
  round-internal labels that leaked into user-facing text.

---

## Track A — Capability multipliers

Ordered by value per line, each with the eval that decides whether it ships enabled.

### A1. MCP client (the largest multiplier available)

Execute `docs/mcp-client-scope.md` as written, with the three dsh mechanisms from
`STRATEGY-harness-adoptions.md` Tier 2: deterministic `mcp__<server>__<tool>` names with a
12-hex identity hash on collision, per-outage reconnection budgets, all-or-nothing
generation swaps. MCP tools enter at `tools:list` and leave at `tools:execute`; the
allowlists, subsetting, budgets, argument repair, tool-call block and audit log do not know
where a schema came from. Default-off per server; tool output wrapped in `UNTRUSTED_HEADER`
like every other foreign text.

*Eval gate:* the tool-choice suite gains a **fixture server** (a tiny stdio MCP server the
suite spawns, exposing three tools with deliberately overlapping descriptions). The
question the suite answers: **did connecting a server degrade correct-tool or raise the
spurious-call rate for the 24 native fixtures?** Ship enabled only if both stay within the
`EVAL_PASSES=3` noise floor.

### A2. Fact ledger, as a library pack the app writes

Verification is the app's most expensive habit and today it is thrown away. A claim that
survives the claim check or the grounding pass is written to a `verified-claims` pack:
`{claim, normalized entities, verdict, source URL, tier, checked-at, content hash}`, with
**typed freshness** (prices in hours, addresses and dates in months, historical facts
effectively never). Building it as a pack means recall-before-search, the library, and the
📖 strip share one retriever and one UI, and `Settings → Library` shows it beside the
curated packs with the same purge controls. An expired hit seeds the search query rather
than the reply; a re-check that contradicts an entry updates it and says so in the reply.
Never populated from ephemeral chats. Start with the claim classes `toolGrounding.ts`
already extracts mechanically (money, addresses, URLs, contacts, dates, measurements).

*Eval gate:* a new `ledger` suite — 20 factual questions asked twice in fresh chats: the
second ask must (a) skip the search the first ask ran (calls per turn), (b) cite the ledger
entry with its date, and (c) on the six cases whose fixture source changed between asks,
surface the contradiction rather than the cached answer. The number that must move is
seconds and searches per turn; the number that must not is the unsupported-figure rate.

### A3. Standing questions (local scheduler)

`price_watch` is one instance of a general thing: a question the user wants re-asked. Add
a local scheduler that re-runs a saved deep-research question, re-checks a ledger entry
near expiry, and re-checks tracked pack folders, while the app is open, and delivers
results as a digest conversation. No background daemon, no network the app does not
already use, every run in the activity log under its own purpose. Pairs with A2's
freshness types, which is why it comes after it.

*Eval gate:* none needed for correctness (it composes existing tools); the render suite
pins that a digest chat renders identically to a live one, and the audit suite pins that a
scheduled run writes the same records a typed turn would.

*(v2.6: built as Settings → Jobs, four kinds — research, price, ledger re-check, tracked
folders — hourly/daily/weekly, one at a time, held digests, ten-failure cutoff. A job never
runs a confirming tool. `docs/jobs.md`.)*

### A4. Outline-then-fill for long answers

A JSON-schema outline via `chatCompleteJson`, then sections, so a 9B model writes a
coherent 2,000-word report instead of drifting after 600. Triggered by request shape
(explicit length or document ask) and by deep-research synthesis. Disclosed the way plans
are.

*Eval gate:* a `longform` suite of 12 requests with mechanical rubrics — required sections
present, no section restating another (cosine over section embeddings under a threshold),
figures still traceable to tools. Compare bare vs outlined; ship as default only if the
required-sections score moves and the unsupported-figure rate does not.

*(v2.6: built as `main/ipc/outline.ts` behind a switch that ships off. No tools ride the
sections, so the figure rung has nothing to trace; the rubric is sections present, length
reached, cap not hit, and section redundancy by embedding cosine. Measured: a null result —
every-section 10/12 vs 9/12, redundancy unmoved, 40% slower — so the default is off, with
five findings about a 9B reasoning model recorded on the way in `docs/evals.md`. The one
thing the rubric cannot show: the bare arm's cut-off documents stop mid-sentence, the
outlined arm's do not.)*

### A5. Mid-turn steering and spill (from Tier 4)

Let the user type while a turn runs; delivery at the next agent-loop iteration boundary,
persisted as ordinary messages with a delivery marker. Spill replaces oversized tool
results with head/tail plus a locator that `read_spill` retrieves by range; ephemeral chats
never spill to disk. Both depend on C2 (one streaming core), which is why they sit here.

*Eval gate:* multi-turn suite re-run with a steering message injected at turn 2; the
metric is whether the steer is honored on the next tool round and whether the record
(audit + trace export) shows it where it landed.

### A6. Code Mode in the Workbench

Generate a typed Python SDK (`tools.<name>(args)`) from the tool table, byte-identical for
an unchanged tool set; every SDK call re-enters `tools:execute` with the parent call id.
Ship as a per-slot mode. The honest prior from the orchestration evals is that this may not
help small models; **the suite decides**, and a null result is recorded as one.

*Eval gate:* the quantitative and multi-turn suites in native, code, and both modes.

### A7. ZIM packs

Kiwix ZIM as a pack format — offline Wikipedia and WikiMed at the user's choice. Depends
on C1 (Electron with Node 22 for zstd in `zlib`), and on a vendored xz decoder for older
ZIMs (the tree already vendors a 30 MB Pyodide, so a small WASM decoder is in character).
The durable JSON index will not scale to a ZIM; this is the one place the earlier
"revisit SQLite if a ZIM-scale pack ever lands" note comes due. Retrieval stays keyword-first
over the ZIM's own title index, semantic only over the sections a lookup actually opens.

*Eval gate:* the library suite with a WikiMed ZIM installed — the 28 health/first-aid
cases must not lose retrieval or gain unsupported figures; a new 12-case general-knowledge
set measures what the pack adds.

### A8. Diff-reviewed writes (later)

The Coder slot has file tools and a terminal with a confirmation dialog, but `write_file`
overwrites whole files. A `propose_patch` tool produces a unified diff the app renders and
applies only on approval — the model proposes, the user sees exactly what changes. This is
the same shape as plan approval and the terminal confirm, applied to edits. Listed last
because it is a new surface rather than a multiplier of existing ones.

---

## Track B — The measured problems

### B1. Make the re-read free instead of forbidden — closed, not built (v2.4)

The premise was that a follow-up's re-read costs seconds. The recorded multi-turn runs say
otherwise: in the session arm, four of the five follow-ups that re-read the file did so
*inside their single analysis call* — `df = pd.read_csv(...)` on line one of the same
`run_python` the analysis ran in — so the re-read costs the model about fifteen tokens and
the sandbox a few milliseconds of parsing. Memoizing the read would save the milliseconds
and none of the seconds. The habit is real and harmless; it stays uninstrumented. Recorded
here so the item is not rediscovered.

### B2. Retire the library suite's noise floor — measured to zero, and the instrument fixed (v2.4)

Measured first, three passes on qwen3.8-9b: no flaky case; the three shapes were a different
model class's. What the run found instead: the scorer flagged correct unit conversions (fixed,
the app's rule), the arm did not offer the tool the app offers (fixed: the arm runs the app's
loop and executes the call as the handler does, scrubs the echo, records how each completion
ended), and the one stable failure is a retrieval mechanism — the boil line sits in the second
chunk of a section the v1.7 cap sends one chunk of, and the dedicated Boiling section ranks
below flood passages because the question never says *boil*. The FAST-letters defect was
already fixed by the builder. After: 84/84 answered, 0 flaky, and a finding for round 15 —
with the tool offered, the model called it in 0 of 84 runs, cited less and stated more from
memory. Both tables in the v2.4 notes.

### B3. Think-harder by domain, not by default — closed by evidence (v2.5)

The item assumed a playbook-triggered default to gate. There is none: think-harder is the 🧠
button and nothing else, and has been since v1.5.1. The measurement that would have decided
the gate says no domain would earn one on this model anyway: on the fourteen reasoning kinds
(constraint satisfaction, logic grids, state tracking, rule chains with a non-firing
conditional, over-constrained problems with no solution, and the rest) a 9B drafts 14 of 14
correct, and a review-and-revise pass fixes nothing and breaks nothing — the same null the
quantitative suite recorded. The button stays where it is; no default is added. Recorded here
so the item is not rediscovered.

### B4. Close the high-rated bench gaps, then gate

Of the 27 high-rated gap entries, close what remains open in one round, then run the bench
**once per release** as a regression gate rather than once per week as the roadmap. The
reference-arm work stops: every route is closed on the bench machine and the record says
so; a manual, occasional comparison is the honest substitute.

---

## Track C — Platform and debt that gates A and B

### C1. Electron upgrade (first, alone, measured)

31 → current stable, in its own release with nothing else in it. Then run everything: the
node suite, the eight Electron check suites, `bench:render`, and one bench round, because
the v2.1 animation work documented three Chromium behaviours the fixes depend on, and a
Chromium two years newer may have changed any of them. This is also the security fix the
app most needs and the one that unlocks A7.

### C2. One streaming core

Finish harness-adoptions Tier 1.4: one SSE parser and chunk assembler in `src/shared/`,
used by `main/ipc/llm.ts` and `hooks/chatTransport.ts`. Contract from dsh worth keeping:
usage before finish, nothing after finish, tool-call arguments raw end-to-end, a
max-tokens finish drops possibly-truncated tool calls. With one core, chat traffic can be
counted in the activity log honestly (closing speed 2b) and A5 has a single place to
deliver a steer.

### C3. Persistence that is O(what changed) — measured first, then narrowed (v2.4)

Speed 1d proposed an index file and lazy loading so startup reads `{id, title, updatedAt}`
and conversations load on demand. Measured before building: the built app on synthetic
profiles of 30-message conversations (~15 KB each), launch to composer — 100 conversations
0.7 s, 1,000 conversations 0.5 s, the sidebar showing its first hundred rows either way.
Startup is already flat at that scale; the real profile on the bench machine holds 23. The
index and lazy loading are not built, and neither are sidecar image blobs (the largest real
conversation, 228 KB with five inline images, re-serializes in milliseconds). What remains
of C3 is the two stores with no bound at all: the audit directory (one file per launch,
appended forever, every file read whole for the status panel) and `memory.json` (chunks
appended forever). Each gets a cap in the watchlist's house style — stated, disclosed in
its settings panel, and refused rather than silently trimmed where the data is the user's.

### C4. Split the new god file along its own seams

`lib/toolGrounding.ts` into `lib/grounding/` by its seventeen existing section markers
(correction, figures, measurements, conflicts, contacts, addresses, origin, claimed tools,
run counts, denied work, retrieval account, quotations, arguments, attributions, links,
the pass). Behaviour-neutral; the 2,574 checks are the gate, plus a suite test that the
pass's output is byte-identical over the recorded bench runs. `SettingsModal.tsx` one
component per tab; `useLMStudio.ts` toward the 500-line target by the same extraction that
worked before.

### C5. Hygiene, one afternoon

Prune the 22 worktrees and the `worktree-agent-*` branches; triage
`perf/prefix-cache-and-thinking` (merge or delete); reconcile the `v2.3` / `v2.5` markers
with the shipped version line; take PDF parsing to a worker thread and pool the render
window (both mechanical, both already specified).

---

## Sequencing

| Release | Contents | User-visible claim | Gate |
| --- | --- | --- | --- |
| **v2.3 — the current one** | C1 alone | Same app on a supported Chromium | All suites green; one bench round ties or better on every task |
| **v2.4 — the sound base** | C2, C3, C4, C5, B1, B2 | Startup flat in conversation count; follow-ups faster; activity log complete | Node suite, `bench:render`, multi-turn and library suites vs committed baselines |
| **v2.5 — tools without limit** | A1, B3 | Connect any local MCP server; measured tool choice with it | Tool-choice suite with the fixture server, `EVAL_PASSES=3` |
| **v2.6 — verification that compounds** | A2, A3, A4 | Second asks are faster and cited by date; standing questions; long reports that hold together | `ledger` and `longform` suites |
| **v2.7 — the loop opens up** | A5, A6 | Steer a running turn; code-mode orchestration if it measures | Multi-turn with steering; quant in three modes |
| **later** | A7, A8, LoRA loop | Offline Wikipedia; reviewed edits | Library suite with a ZIM; a patch suite |

C1 before everything because a Chromium change under the animation and modal work is a
risk best isolated; C2 before A5 because steering needs one delivery point; A1 before A2
because the ledger's contradiction events want a live tool source to disagree with; A2
before A3 because the scheduler's most useful trigger is a ledger expiry.

## Measuring it

Every item above names its suite. Two new suites are owed (`ledger`, `longform`) and one
fixture (the MCP test server). All follow the standing rules: temperature 0, three passes,
stable set judged and flaky set reported, no model grades a model, `.eval-results`
baselines committed and diffed. A feature whose suite shows a null result ships **off**
with the result in `docs/evals.md`, as Code Mode is expected to.

## Rejected, again or newly

| Idea | Why not |
| --- | --- |
| A second model provider (Ollama, llama.cpp server) | Re-rejected as a product decision; the loopback base URL already admits any server that speaks the same API, without the app claiming to support it. |
| Continuing weekly bench rounds as the roadmap | Five rounds bought 20 narrow wins at 68 ties; the remaining value is in capability the bench cannot see. It stays as the release gate. |
| Spending more on the reference arm | Five routes closed, documented; the cheapest unblock needs a security setting this session cannot change. |
| SQLite everywhere | Still no; A7 is the one place it is now justified, and only there. |
| Cloud sync, accounts, telemetry | Never. |
| Plugin framework for MCP | The scoped client is 430 lines and zero dependencies; the SDK is 17 runtime dependencies mostly serving the server side. |
