# Roadmap: Sigma Oasis 4.1 — the release that turns switches on

Written by Apex, 2026-09-29, approved by Colin the same night, from a read-only review of `main` at 4.0.1 (e9e44fe). Four passes: the
agent loop, speed, answer accuracy, and evals/foundations. File:line references are to that commit.
Nothing here is measured yet; the plan's first job is to make it measurable.

## Where 4.0.1 stands

- **The agent's improvements exist but none is on.** 4.0 shipped 19 experiments (A1–A10, C1–C8),
  all default-off, because `eval:agent` has never recorded a baseline. Out of the box a user gets
  the bare loop.
- **The baseline is blocked by the bench, not the code.** Both attempts were voided by PCIe errors
  on the 5070's slot (`docs/evals/agent.md:79-96`). These are *corrected* errors: the link retries
  the packet. They cost time; they do not change a token.
- **Speed.** The biggest losses are structural: a full window drops one message per turn and
  re-reads everything; pre-model providers run in series (auto search measured 8.8 s before the
  model is asked anything); reasoning tokens re-render the app; thinking runs on utility calls.
- **Accuracy.** Grounding is regex triggers plus text-matching checks. Live-world questions are
  the weak spot: the ledger can answer today's weather with an earlier day's value, the app's own
  search sends the user's sentence verbatim, and web answers carry no citations.
- **No eval covers what broke in 4.0.1** (live questions), and no speed metric covers what A1/A3
  claim to improve (prefill time per round).

## The release plan

- **4.0.2 (this week, bug fixes only, all size S):** the six real bugs below. No behaviour change
  beyond the fixes.
- **4.1.0 (about three weeks):** Track M first, then Tracks S, A and G, each item shipped only if
  its gate holds. Experiments flip on by measurement.
- **4.2:** the larger items: structured plan round, measured web-trigger classifier, reranker,
  god-file splits, draft-model decoding.

## 4.0.2 — bugs found in the review

1. **Helpers ignore the worktree.** `runHelper` builds its toolbox with `root: spec.workspace`
   (`engine.ts:437`), but the task runs in `worktree?.path` (`engine.ts:108`). With worktrees on,
   a general helper edits the user's real folder and the A7 reviewer reads the unchanged files.
   Fix: pass the task's root; pass the experiments to helpers too.
2. **A cut-off `write_file` ends as "completed".** `streamRound` reports `truncated`, the engine
   never reads it (`engine.ts:336-348`); a call cut at 16K tokens is dropped (`stream.ts:110,136`)
   and the loop can finish with nothing written. Malformed text-form calls are dropped silently
   (`nativeToolCall.ts:168-171`). Fix: a repair message ("your call was cut off; write it in
   smaller parts") and continue.
3. **MCP tools and `run_python` run unbudgeted in the agent.** The agent's budget table
   (`engine.ts:70-75`) replaces the chat's, and the MCP default applies only when no table is
   passed (`agentLoop.ts:334-339`). Fix: merge the two tables.
4. **The ledger keeps live values for two years.** Any number with a unit is a "measurement" with
   730-day freshness (`shared/factLedger.ts:67`), and a snippet counts as a source
   (`lib/factLedger.ts:97`). A snippet's "72°F" can answer tomorrow's weather question and cancel
   the search (`contextProviders/factLedger.ts:67`). Fix: never file or serve ledger entries on
   live-world turns; require a fetched page, not a snippet. (Inferred from code; pin with a test
   first.)
5. **Page extraction matches substrings.** "rain" scores on "training" (`browseExtract.ts:55-58`).
   Fix: word boundaries.
6. ~~**`eval-answers.sh` cannot run on Windows.**~~ Not a bug: Git Bash resolves
   `node_modules/electron/dist/electron` to `electron.exe`, so the Linux line already works.

**Shipped on `fix/4.0.2`** (see `RELEASE-NOTES-v4.0.2.md`): 1–5, and one more the tests found —
an amount ending a sentence ("costs $18.50.") matched no money pattern, so no page could back a
price. On 3: `run_python` and `reference_lookup` stay unbudgeted in the agent by design (local,
covered by the round cap); the fix is the MCP default.

## Track M — measure first (blocks everything else)

- **M1. Record the agent baseline on the machine we have.** Change the GPU gate: a rise in
  corrected PCIe replays marks a case's *timing* as tainted but keeps its *solved / false-claim /
  collateral* scores. Run the stable set on the 9B (the reference) and the 35B-A3B (second arm),
  3 passes, overnight when nobody is gaming. If the hardware is fixed later, re-run timing only.
- **M2. Commit baselines.** A `baselines/` folder outside the ignored `.eval-results/` and an
  `eval:diff` script that fails when the stable set's solved rate drops or false claims rise.
  The roadmap already says baselines are "committed and diffed"; today they are neither.
- **M3. Per-round latency in every eval record:** TTFT, prefill ms, prompt tokens, cached tokens
  (if LM Studio reports `cached_tokens`), decode tok/s. A1 and A3 claim prefill wins; nothing
  records prefill today.
- **M4. A cache-friendliness test with no model.** Serialize consecutive turns' requests and
  assert the first differing byte falls after the previous user message, never inside the system
  prompt or the tool list. It would have caught S1 and S5.
- **M5. A live-world suite.** Loopback fixture pages for dated weather, scores and futures; score
  web tools on the wire, search ran, answer taken from the page, no ledger answer, date correct.
  Add live questions to the tool-choice fixtures too.
- **M6. Offline CI gate.** Replay the scripted model through `eval:tools` and `eval:agent` and hash
  the tool schemas, so a wire change or a regression cannot merge unseen.
- **M7. A real-model latency bench per release:** fixed prompts, cold vs warm, turn 1 vs turn 10
  vs a conversation past its window; the split across gather / pin / compaction / prefill /
  decode / verify, appended to a results file like `bench:render`.

## Track S — speed

1. **Low-water mark for chat history (S).** `planHistory` (`contextBudget.ts:287-301`) keeps what
   fits with no margin, so a full chat drops one message, re-summarizes and re-reads the whole
   context every turn. Trim to 60–70% when over. Same fix as agent A1; turn A1 on if M1 holds.
   Expected: a long chat stops paying ~100 s of re-prefill per turn at 30k tokens.
2. **Providers in parallel, search with a deadline (S–M).** Ledger → search → library run in series
   (`contextProviders/index.ts`). Run the library lookup alongside; give auto search a 3–4 s soft
   deadline, then let the model call `web_search` itself. Expected: 1–8 s off factual TTFT.
3. **Reasoning through the paced tail (S).** `onReasoning` patches the store per chunk
   (`chatTurn.ts:437-441`), re-sorting the Sidebar and recomputing the context meter. Route it
   through `streamingTail` like answer text; add reasoning to the render-bench stub.
4. **Think only where it pays (S–M).** Closed-think prefill on every verification and utility call
   (`verification.ts:294-310` lacks it); a per-slot thinking setting (auto/on/off); A3 thinking by
   phase in the agent. Expected: 2–10 s per turn on reasoning models.
5. **Stable, smaller tool payloads (S).** On a ranking failure fall back to the previous turn's set,
   not the whole allowlist (up to ~8k tokens, ~25 s cold, `turnHelpers.ts:291-317`); keep web
   tools once a conversation has them; cut tool descriptions 30–40% (drop the Example lines).
6. **Parallel read-only tool calls (S–M).** Calls in a round are awaited one by one
   (`agentLoop.ts:449`). Run `web_search`, `fetch_webpage`, `reference_lookup`, `memory_search`,
   `read_file`, `grep`, `glob` concurrently; keep result order; charge budgets before dispatch;
   tell the model to batch independent reads.
7. **Small costs (S).** Cache query embeddings for 60 s (the same text is embedded up to ~4× per
   turn); highlight an open code block incrementally (`markdown.ts:351-361` is quadratic).
8. **Draft-model decoding (4.2, M).** The 9B already runs MTP drafting at n=2 through LM Studio's
   own config on the 5070, so an in-app draft model only matters for dense models without MTP.
   Measure before building.

## Track A — agentic capability

1. **Repair, not silence (S).** The 4.0.2 truncation fix, plus a parser for the Hermes/Qwen
   `<tool_call>{"name","arguments"}</tool_call>` form (`nativeToolCall.ts` misses it).
2. **A stuck detector (S–M).** Today only exact duplicate calls are caught, and any write clears
   that (`engine.ts:379`). Count consecutive failures per tool and path: at 3, a thinking round
   with "you are stuck; re-read and change approach"; at 5, stop and say why.
3. **Cap every tool result (S–M).** `read_file` can return 2,000 lines, and the last 4 results are
   never trimmed (`context.ts:28,94`). Cap a result at ~15% of the budget, head and tail kept,
   with an offset hint; add the planned spill store and `read_spill`. Also stop ignoring
   `fitContext`'s over-budget report (`engine.ts:327-328`).
4. **Turn on what measures well.** Order by risk: A2 shaped results and A5 verify round first,
   then A1 low-water mark, then A3 thinking by phase, A4, A7 reviewer. Each needs solved held and
   false claims not up on the stable set.
5. **Tools by phase (S–M).** The agent sends all ~25 schemas every round (`engine.ts:157`); the
   chat's per-turn selection is not used. Offer read tools while exploring and edit tools while
   acting, or reuse `toolSelection.ts`.
6. **A real plan round (M, 4.1 or 4.2).** A4 as built is a reminder message. Build it as specified:
   a structured-output first round whose steps become the checklist, the current step named in
   the system prompt, evidence required to close a step, a replan after a failed check.
7. **Sturdier edits (S).** An indentation-tolerant unique-match tier in `editMatch.ts`, and a
   `multi_edit` tool reusing `patch.ts`.

## Track G — grounding and accuracy

1. **The ledger fix from 4.0.2**, plus freshness keyed to the question's topic, and a decision
   that a search snippet is a lead, not a source.
2. **Better app-run search (M).** Rewrite the question into 1–3 queries with one structured-output
   call; keep the subject when the privacy trimmer cuts (`search.ts:198-199` can reduce "weather
   for my run in Richmond today" to "what's the weather like"); ask each provider for recent
   results; on live questions, read the top 1–2 pages rather than snippets only.
3. **Citations on web answers (S–M).** Number the turn's web sources, ask for [n] after each
   sentence that uses one, and extend the broken-citation and wrong-source checks to them.
4. **Check sourced replies, not only unsourced ones (M).** The model check runs only when no source
   was consulted and needs Second Opinion (off by default) (`turnTail.ts:364`). Add a same-model,
   one-claim-at-a-time check against this turn's sources; it covers the scores, times, dates and
   names the text checks skip. Turn think-harder on automatically for models without built-in
   reasoning (+22 points measured on mistral-7b).
5. **Year-tagged library documents (S).** The finance pack states 2025 figures; "this year"
   questions get them without the web. Tag each document with the year it applies to; force the
   web and name the year when stale.
6. **A measured web trigger (M, 4.2).** Replace patch-per-miss regexes (`grounding.ts:146-210`)
   with a similarity classifier trained on ~300 labelled prompts from exported traces; keep the
   regexes as overrides; report hit and false-alarm rates.
7. **Reranking (M, 4.2).** Model re-rank of the top ~15 passages in health and finance, and query
   expansion with a hypothetical answer.

## Track F — foundations and privacy (runs alongside)

- **SECURITY.md is behind the product.** It still describes `run_terminal_command`/`write_file`
  and misses the agent engine, permission modes, `.sigma/` hooks and commands, chores and trash,
  `browse`, MCP as agent tools. It also says everything leaving the machine is logged, which the
  agent's `run_command`, hooks, `git` for worktrees and local MCP servers do not honour. Qualify
  the claim or add a guard *before* A8 hooks, C7 commands or C8 MCP-for-agent turn on.
- **Redaction tests for trace export** covering `.sigma/` paths and document contents (C1).
- **Split the god files touched by this round first:** `ipc/library.ts` (1,709 lines) and
  `ipc/search.ts` (1,537) by Track G, `agent/tools.ts` (855) by Track A. `docs/evals.md` (7,825
  lines) into one file per suite.
- **Test build from a tsconfig**, not the hand-kept list in `scripts/test.sh:59-155` that has hidden
  a bug before.
- **Dependencies:** align electron-builder 24 with electron-updater 6 before signing work; update
  `marked` (it sits on the XSS path behind DOMPurify); vite/electron-vite majors after.

## Gates for 4.1.0

- `eval:agent` stable set: solved ≥ baseline; false claims and collateral not up (9B and 35B-A3B).
- Live-world suite: answered from a fetched page on ≥ 90%; zero ledger answers to live questions.
- Latency bench: TTFT at turn 10 of a full chat and on a factual turn both down against 4.0.1,
  numbers recorded, not estimated.
- Cache test green: no request changes bytes before the previous user message.
- `npm run typecheck`, the node suite and every Electron check, as for 4.0.1.

## Decisions (Colin, 2026-09-29)

1. **Corrected PCIe replays taint a case's timing only**, so the baseline runs on this machine now.
2. **Reference models for the gates:** the 9B distill on the 5070; the 35B-A3B is the second arm.
3. **A search snippet is a lead, never a verified claim.** Done in 4.0.2 for the ledger.
4. **Scope:** Tracks M, S, A1–A5, G1–G5 and F's security items in 4.1; the plan round, classifier,
   reranker and draft decoding in 4.2.
