# Strategy: Depth & Reasoning — post v1.4.7

**Status: v1.4.8 groundwork and Feature A (the Almanac: packs, BYO folders, `reference_lookup`, app-initiated lookup, network-aware grounding, playbooks, first 7-pack tranche) shipped for v1.5.0 · items 3–4 (model profiles, think-harder) and Feature B next.** Written against the v1.4.7 codebase (commit 984aaba). Companion to
`STRATEGY-speed-and-quality.md` (Part 3 proposed MCP + fact ledger) and
`STRATEGY-routing-and-tools.md` (Layers 0–4, shipped). Those made answers honest and the
app fast. This one asks a narrower question: **how does the app make a 9–30B model on
LM Studio deeper and smarter than its weights** — for search, research, planning, data
analytics, programming, and as an offline reference for basic life needs.

---

## Part 0 — What a small model is bad at, and what the app already fixes

A 9–30B model in Q4–Q8 has three structural weaknesses. The app already addresses one
and a half of them; the other one and a half are this document.

| Weakness | What it looks like in chat | Shipped answer | Gap |
| --- | --- | --- | --- |
| **Thin, stale, confabulated knowledge** — the long tail isn't in the weights, and what is there is confidently wrong | Invented dosages, dates, product names, statutes | Grounding rules, app-initiated `web_search`, claim check, tool grounding, deep research, durable memory | **All of it needs the network.** Offline there is *nothing*: no reference corpus, and the grounding rules ("verify with web_search") send the model into a failing tool loop. First aid is a starter-card prompt, not content (`EmptyState.tsx:32`). |
| **Weak multi-step computation** — arithmetic, unit conversion, aggregation, sorting, anything over a table | Wrong totals, wrong percentages, "approximately", plausible-but-off charts | `finance_calculator`, `date_calculator` (exact, but narrow) | **No general computation.** Data analytics = the model eyeballing a truncated CSV. `run_terminal_command` is a shell with a confirm dialog — right for building, wrong for "sum column C" (unsandboxed, off by default, needs a Python install). Attachments truncate at 20K chars (`attachments.ts:100`) — a 60-page PDF loses 90% of itself silently. |
| **Shallow procedure** — it doesn't know *how an expert would go about it* (triage order, EDA order, what a good financial plan checks first) | Generic answers that skip the step that mattered | Role slots with hand-written system prompts (Coder, Finance Coach); plan mode | Procedure lives in 4 static slot prompts, not retrievable per domain. A first-aid question and a tax question get the same "helpful assistant". |

The framing that falls out of the table — and the answer to "how does the app make the
model more powerful": **move knowledge, computation, and procedure out of the weights and
into the app**, then keep the model to the job it is actually good at — reading, choosing,
composing, and explaining. Everything below is that principle applied.

```
                       ┌──────────────────────────────┐
   knowledge  ───────► │  reference library, memory,   │
   (Feature A)         │  fact ledger, web             │
                       ├──────────────────────────────┤        ┌───────────────┐
   computation ──────► │  calculators, code sandbox    │ ─────► │  9–30B model  │ ──► answer + citations
   (Feature B)         │                               │        │  reads/chooses │
                       ├──────────────────────────────┤        │  /composes     │
   procedure  ───────► │  playbooks, routing, plan,    │        └───────────────┘
   (A + updates)       │  budgets, verification passes │
                       └──────────────────────────────┘
```

---

## Feature A — The Almanac: an offline reference library with playbooks

**What.** A local, indexed, citable corpus the model reads *before* it answers, plus
retrievable *procedures* for the domains the app claims to serve. Fully offline; nothing
about it touches the network unless the user downloads a pack.

**A1. Reference packs.** Curated, openly licensed text bundles, one per domain, shipped
as plain Markdown/JSON with per-document provenance (title, source, license, date). First
tranche, all public domain (US federal works) so licensing is a non-issue and provenance
is real:

| Pack | Source (public domain) | Why |
| --- | --- | --- |
| First aid & emergencies | US Army FM 4-25.11 *First Aid*; FEMA *Are You Ready?*; MedlinePlus first-aid encyclopedia | The starter card that has no content behind it |
| Emergency preparedness | Ready.gov / FEMA guides; USGS/NOAA hazard guides | Fits the "offline for basic life needs" mission literally |
| Personal finance & tax basics | CFPB consumer guides; IRS Publications 17 / 501 / 590 / 936; SEC investor bulletins | Complements `finance_calculator`: the tool computes, the pack explains the rule |
| Health reference | MedlinePlus health topics & drug info (NLM) | Where confabulation is most dangerous |
| Nutrition & food safety | USDA FoodData / MyPlate; FDA / FSIS food-safety guides | Common, offline-relevant |
| Home, tools & repair | CPSC safety guides; DOE Energy Saver; USDA extension basics | Second starter card with no content |
| Legal & civic basics | USCIS civics; USA.gov guides; state-agnostic consumer-rights basics | Cheap, useful, and where models invent statutes |

Not shipped, deliberately: Red Cross (copyrighted), wikiHow (CC-BY-NC-SA — incompatible
with an MIT app), Wikipedia as a bundled pack (CC-BY-SA is fine but the size isn't — see
"how it grows").

**A2. Bring your own corpus.** Point the app at a folder (Markdown, text, PDF, HTML). It
becomes a named pack with the same indexing, provenance, and citation. This is what turns
"reference library" into "my second brain": manuals, course notes, company docs. Bounded
per pack (documents, bytes), and — like memory — never populated from ephemeral chats.

**A3. Playbooks.** A playbook is a short procedure for a domain, written like the slot
prompts already are but *retrieved, not static*: "For a first-aid question: 1 — establish
if this is life-threatening and say to call emergency services first; 2 — ask/assume
these facts; 3 — quote the reference, don't paraphrase dosages; 4 — end with when to seek
care." Fifteen to twenty of them across the pack domains plus analysis/coding/planning.
When the pre-flight classifier (`routing.ts`) or the pack retriever recognises the domain,
the matching playbook rides in the turn-context header — the same KV-cache-friendly slot
the grounding block uses. Playbooks are what make a 9B model *act like* it has method,
which is measurably closer to expertise than a bigger model without one.

**A4. Retrieval, and how it reaches the model.**
- Index = the hybrid the app already trusts: BM25 + embeddings with RRF and MMR
  (`retrieval.ts`, `researchIndex.ts`) — but *durable* (per-pack JSON index under
  `userData/library/`, bounded-store pattern from `STRATEGY-speed-and-quality.md` 1d),
  and keyword-only when no embedding model is loaded, so it works on a machine that runs
  exactly one model.
- One tool, `reference_lookup { query, pack? }`, in the same use-when/do-not-use-when
  format as the other 21, subject to the same allowlists, subsetting, and budgets. Returns
  passages with `[pack › document › section]` citations.
- **App-initiated, like `looksFactual()`:** when the classifier says health / finance /
  legal / preparedness, or when the network is off, the app runs the lookup itself before
  the model speaks and hands the passages over — the same "remove the option to
  confabulate" move that `web_search` pre-flight makes today.
- The grounding block becomes network-aware: offline, "verify with web_search" is
  replaced by "verify against the reference library or say you cannot", and the badge says
  *unverified (offline)*. This alone fixes the worst offline behaviour the app has now.
- Answers cite passages inline; the bubble shows a "From the library" strip exactly like
  "From memory" does. Provenance is always visible; a model claim that a pack passage
  contradicts is flagged by the existing tool-grounding pass (the passage *is* tool
  output).

**Why this one.** It is the only feature that makes the *offline* half of the mission
true, and it attacks the failure that costs the most (a confident wrong dosage) with the
mechanism the app already trusts (retrieve, cite, ground). It also compounds with what is
planned: the fact ledger from `STRATEGY-speed-and-quality.md` is a library pack the app
writes itself; MCP servers become another retrieval source behind the same tool.

**Honest risks.** Medical/legal content invites over-reliance — mitigated by playbooks
that lead with "call emergency services", by never paraphrasing dosages (quote + cite),
and by provenance in every strip. Pack size and freshness — mitigated by shipping packs
as downloadable, versioned bundles with a manifest, not inside the app binary, and by
showing each pack's date. Retrieval quality on 9B — mitigated by hybrid ranking and by
playbooks telling the model to *quote*, which small models do better than synthesise.

**How it grows.** (1) Kiwix ZIM as a pack format — offline Wikipedia / WikiMed at the
user's choice, read in-process (Kiwix-JS is pure JS; full-text needs the libzim WASM
build) — this is the "depth of knowledge" ceiling raiser, and it is user-supplied so
licensing and size are the user's call. (2) A community pack format so others contribute
domains. (3) The fact ledger writing into a `verified-claims` pack.

---

## Feature B — The Workbench: a sandboxed code runtime for analysis and verification

**What.** A local, network-free, filesystem-scoped code sandbox the model can use as a
calculator, a spreadsheet, and a verifier — the *program-of-thought* pattern that turns a
model that is bad at arithmetic into one that is exactly right, because it wrote the
program and the app ran it.

**B1. Runtime.** Pyodide (CPython compiled to WASM) hosted in an Electron utility process
(or hidden BrowserWindow) with a strict CSP: no network, no Node, no real filesystem — a
virtual FS the app populates per turn with the attached files. Bundled wheels: numpy,
pandas, matplotlib (optional download to keep the base ~30 MB compressed). Same on macOS,
Windows, Linux; no Python install required; sandbox by construction rather than by policy.
A JS runtime (Node `vm` is *not* a sandbox — QuickJS-WASM if wanted) is a later add.

**B2. Tools.**
- `run_python { code, files? }` — executes, returns stdout, the last expression, and any
  files written (tables as CSV/JSON, figures as PNG). Wall-clock and memory limits;
  budgeted per turn like every other tool; the code and its output are shown in the
  bubble as a collapsible "Ran code" block, so a user can audit and re-run.
- `analyze_file { path, question? }` — the app-initiated entry: for a CSV/XLSX/JSON
  attachment it loads the file into pandas, returns shape, dtypes, head, nulls, and a
  descriptive summary *mechanically* — no model call — so the model starts from facts
  about the data instead of a 20K-char slice of it. (XLSX via a small zip+XML reader,
  same no-native-deps rule as `pdf.ts`.)
- Figures render inline; tables render as Markdown with a "download CSV" affordance.

**B3. Verification, not just computation.** The sandbox becomes the checker for two
things the app currently cannot check offline:
- **Numeric claims.** `toolGrounding.ts` already extracts money figures and dates from a
  reply. When a reply contains arithmetic over stated inputs, a mechanical pass can
  recompute (or ask the model to emit the computation as code) and flag mismatches — the
  same "a model never grades itself" rule, applied to numbers.
- **Code answers.** When the Coder slot returns a function and a test, run the test.
  Pass/fail is a real signal a 9B model can act on; the existing revise-with-improvement-
  gate (`reviseAgainstFindings`) already knows how to consume findings.

**B4. Where it plugs in.** A tool in `toolSchemas.ts`/`tools.ts` (behind the dispatch
table planned in 2d); an attachment path in `attachments.ts` that stops truncating
tabular files and hands them to the sandbox instead; a `RanCodeBlock` next to
`ClaimCheckBlock`; the "Data" starter card and a `Data Analyst` slot whose playbook (A3)
says: describe → compute → chart → caveat, and never state a number you didn't compute.

**Why this one.** It converts the app's weakest claim ("data analytics and programming")
into its most demonstrable one, and it is the largest per-model capability multiplier
available: on quantitative tasks, small-model + code execution reliably beats large-model
without it. It is also the second leg of the offline mission — a spreadsheet question
needs no network at all. And unlike `run_terminal_command` it is safe *by construction*,
which is the property this app sells.

**Honest risks.** Bundle size and cold start (Pyodide ~10 MB core + ~15 MB for
numpy/pandas; 2–4 s first load) — mitigated by lazy loading on first use and by keeping
matplotlib an optional download. Small models write buggy code — mitigated by the
one-repair-round rule the agent loop already has, by returning tracebacks verbatim, and
by `analyze_file` doing the routine parts mechanically so the model writes less code.
WASM has no threads by default — fine for the workloads in scope; a 5-million-row CSV is
out of scope and should say so.

---

## Part 2 — General updates that make small models act bigger

Ordered by leverage per line. The first three are prerequisites or near-free with A/B.

1. **Stop truncating attachments; index them.** Any text/PDF over the inline budget goes
   through the durable chunker from A4 (per-conversation, ephemeral for ephemeral chats)
   and is retrieved by relevance per turn, the way fetched pages already are. Tabular files
   go to B2. This is the single biggest "depth" fix and reuses `researchIndex.ts` almost
   unchanged.
2. **Network-aware grounding.** Detect offline (a failed loopback-vs-egress probe, or a
   user toggle "work offline"), and swap the grounding block, the classifier's pre-flight
   action (library instead of web), and the badge wording. Today offline is the app's
   worst mode; it should be a first-class one.
3. **Model profiles.** A per-family profile (Qwen3, Gemma, Llama, Mistral, DeepSeek-R1
   distills, Phi) carrying: thinking handling (already in `applyThinking`), recommended
   sampling, whether tool calling is trustworthy at all (the eval harness already
   measures it — surface it as a recommendation), and a *deliberation budget* (below).
   Shown in the model picker; overridable. Small models differ far more than large ones,
   and the app already has the measurements — it just doesn't act on them.
4. **"Think harder" on demand — bounded test-time compute.** A per-message toggle (and a
   playbook-triggered default for math/logic) that runs *draft → critique by a different
   slot → revise*, adopting the revision only through the existing improvement gate; for
   closed-form answers, three short samples with mechanical agreement (or a B3 recompute)
   instead of a vote. Never a confidence score, always disclosed ("deliberated: 3 drafts,
   agreed"). This is where a 30B model on a Mac earns its keep at the cost of seconds,
   not dollars.
5. **Fact ledger** (from `STRATEGY-speed-and-quality.md` Feature B) — build it as a
   library pack the app writes, so recall-before-search and the library share one
   retriever and one UI strip.
6. **MCP client** (Feature A there) — unchanged in value; slots in behind the dispatch
   table. Sequenced after A/B here because it multiplies tools rather than depth.
7. **Long-answer structure for small models.** Outline-then-fill for long requests
   (a JSON-schema outline via `chatCompleteJson`, then sections), which is how a 9B model
   writes a coherent 2,000-word report instead of drifting after 600 words. Cheap; pairs
   with deep research synthesis.
8. **The debt that gates the above** — from `STRATEGY-speed-and-quality.md` Part 2:
   the two privacy gaps (2b), `tools.ts` switch → dispatch table and `useLMStudio.ts`
   split (2d), `markdown.ts` sanitizer tests (2c). A and B both add tools and bubble
   blocks; doing them against the god files makes them worse.

---

## Sequencing

| Release | Contents | Why this order |
| --- | --- | --- |
| **v1.4.8 — the bounded one** | Part 2 item 8 (privacy gaps, dispatch table, hook split, sanitizer tests); item 1 (attachment indexing) | Debt first; attachment indexing is small and exercises the durable index that A needs |
| **v1.5.0 — the Almanac** | Feature A (packs, BYO corpus, playbooks, `reference_lookup`, library strip); item 2 (network-aware grounding); first pack tranche as downloadable bundles | Makes the offline mission true; playbooks immediately lift every domain |
| **v1.5.x** | Item 3 (model profiles); item 4 (think harder) | Both are cheap once playbooks and profiles exist |
| **v1.6.0 — the Workbench** | Feature B (sandbox, `run_python`, `analyze_file`, RanCode block, numeric/code verification); item 7 | Largest new surface; benefits from the dispatch table and the bubble-block patterns A adds |
| **later** | Items 5–6 (ledger as a pack, MCP); ZIM packs; LoRA loop | Compounding features on top of a stable base |

## Measuring it (so it isn't a story)

The eval harness (`scripts/eval-tools.ts`, `lib/evalRunner.ts`) grades tool choice. Add
three small suites, run per model, printed with the same caveats:
- **Library grounding:** 40 offline questions across the packs; score = cited-passage
  present and no claim outside it (mechanical, via `toolGrounding.ts` on the passages).
- **Quantitative:** 30 CSV/arithmetic questions with known answers; score with and without
  the sandbox. This is the number that shows a 9B "getting smarter".
- **Deliberation:** the same 30 with think-harder on; report delta and seconds, so the
  budget in the model profile is a measurement, not a guess.

## Rejected along the way

| Idea | Why not |
| --- | --- |
| Bundle Wikipedia | Size and freshness; ZIM as a user-supplied pack gives the same depth at the user's choice |
| Ship a Python interpreter / use `run_terminal_command` for analysis | Needs an install, no sandbox, network-capable; WASM is sandboxed by construction |
| Node `vm` as a JS sandbox | Not a security boundary; QuickJS-WASM if a JS runtime is ever wanted |
| Multi-agent debate / tree search | 3–10× cost on local hardware for gains that a critic-with-tools + recompute get cheaper; revisit with measurements from item 4 |
| A router / "reasoning" model in the loop | Re-rejected as in `STRATEGY-routing-and-tools.md`; profiles + playbooks are the mechanical version |
| SQLite for the library | Same bounded-JSON reasoning as before; revisit if a ZIM-scale pack ever lands in the durable index |
