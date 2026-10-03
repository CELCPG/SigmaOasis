# Evals: the index

Every suite runs live against a locally loaded model, gated behind `LMSTUDIO_EVAL=1` so CI stays
offline, and every one scores mechanically: no model grades another model's answer. How the runs
work, the shared flags (`EVAL_CASES`, `EVAL_PASSES`), what each answer suite judges and the caveats
printed with every run are in [method.md](evals/method.md). Results land in `.eval-results/*.json`.

Until 4.2 this was one 7,970-line file. It was split, not rewritten: every section moved whole, in
its original words, into the file named below.

## Suites

| Suite | What it measures | Command | Latest headline | File |
| --- | --- | --- | --- | --- |
| Tool choice | correct-tool, spurious-call, arg-validity and loop rates over 24 fixtures; MCP servers on the wire | `LMSTUDIO_EVAL=1 npm run eval:tools -- <model>` (`EVAL_SUBSET=1`, `EVAL_MCP_STUB=<n>`) | v2.5, qwen3.8-9b: 57/63 · 90% correct-tool, 0 spurious, with 0, 4 or 12 MCP servers connected | [tools.md](evals/tools.md) |
| Library grounding | offline reference questions answered from retrieved passages, cited, no invented measurement | `LMSTUDIO_EVAL=1 EVAL_SUITES=library npm run eval:answers -- <model>` | v1.7: 23/28 answered, 22/28 cited, **0/28** unsupported measurements | [answers.md](evals/answers.md) |
| Quantitative + deliberation | the number right or wrong, bare vs. with the Workbench, and after one think-harder pass | `LMSTUDIO_EVAL=1 EVAL_SUITES=quant,deliberate npm run eval:answers -- <model>` | bare 10/18 · 56% vs. Workbench **20/20 · 100%**; CSV questions 0/6 → 6/6 | [answers.md](evals/answers.md) |
| Multi-turn analysis | follow-ups over one dataset, sessions vs. stateless | `LMSTUDIO_EVAL=1 EVAL_SUITES=multiturn npm run eval:answers -- <model>` | v1.8.1: session follow-up re-reads 30/30 → 18/27 with the playbook step | [answers.md](evals/answers.md) |
| Deep research | the brief checked against its passages, rung on vs. off, loopback fixture corpus | `LMSTUDIO_EVAL=1 EVAL_SUITES=research npm run eval:answers -- <model>` | v1.9.1: null — clean corpus 12/12 both arms; thin corpus 9/9 rung on vs. 8/9 off; nothing invented | [answers.md](evals/answers.md) |
| Reasoning + think-harder | multi-step problems, the draft vs. the draft after review-and-revise | `LMSTUDIO_EVAL=1 EVAL_SUITES=reasoning npm run eval:answers -- <model>` | v1.9.1: review fixed 9/36 wrong drafts on a 7B that does not reason internally; two that do drafted every case right; it broke none | [answers.md](evals/answers.md) |
| Project-wide recall | sibling-chat facts asked in a fresh chat, recall vs. bare, with controls | `LMSTUDIO_EVAL=1 EVAL_SUITES=projects npm run eval:answers -- <model>` | v1.11: recall **21/24** vs. bare 3/24; controls 15/15, none pulled off topic | [project-recall.md](evals/project-recall.md) |
| Market indicators | synthetic tickers, tool arm vs. no tools | `LMSTUDIO_EVAL=1 EVAL_SUITES=market npm run eval:answers -- <model>` | v1.12: tool 6/6 figures and 2/2 charts; bare declined only 3 of 6 | [market.md](evals/market.md) |
| Orchestrated mode | orchestrator + specialists vs. answering directly | `LMSTUDIO_EVAL=1 EVAL_SUITES=orchestrate npm run eval:answers -- <model>` (`EVAL_ORCH_LEAN=1`; `EVAL_SUITES=synthesis`) | v1.12.1: 21/21 vs. 20/21 with tools held, 0 consults; synthesis 6/6 either way at 3× the time | [orchestrated.md](evals/orchestrated.md) |
| Fact ledger | twenty questions asked twice in fresh chats, bare vs. ledger | `LMSTUDIO_EVAL=1 EVAL_SUITES=claims EVAL_CLAIMS_ARMS=bare,ledger npm run eval:answers -- <model>` | v2.6: second-ask searches 20/20 → **9/20**; contradictions surfaced 6/6 | [fact-ledger.md](evals/fact-ledger.md) |
| Code Mode | the ledger fixtures through `run_code` vs. native tools | `LMSTUDIO_EVAL=1 EVAL_SUITES=claims EVAL_CLAIMS_ARMS=bare,code npm run eval:answers -- <model>` | v2.7: 16/20 in both arms, code 2.7× slower; the default stays native | [code-mode.md](evals/code-mode.md) |
| Long documents | outline-then-fill vs. bare on twelve document requests | `LMSTUDIO_EVAL=1 EVAL_SUITES=longform EVAL_LONGFORM_ARMS=bare,outline npm run eval:answers -- <model>` | v2.6: null (every section 9/12 → 10/12); the default stays off | [long-documents.md](evals/long-documents.md) |
| Mid-turn steering | a steer queued at the first round boundary: delivered, honoured, still answered | `LMSTUDIO_EVAL=1 EVAL_SUITES=multiturn EVAL_STEER=1 npm run eval:answers -- <model>` | v2.7: delivered 10/10, honoured 9/10 | [steering.md](evals/steering.md) |
| ZIM packs | the library suite with a Kiwix ZIM registered beside the packs | `LMSTUDIO_EVAL=1 EVAL_SUITES=library EVAL_ZIM=<path\|fixture> npm run eval:answers -- <model>` | v2.8: no loss — 28/28 retrieved, 27/28 answered against 28/28 without | [zim.md](evals/zim.md) |
| VIBE | where the brevity line goes; the tool-choice suite with VIBE on | `LMSTUDIO_EVAL=1 EVAL_SUBSET=1 EVAL_PASSES=3 EVAL_VIBE=1 npm run eval:tools -- <model>` | v3.1: VIBE on 54/63 · 86% correct-tool, the same as VIBE off | [vibe.md](evals/vibe.md) |
| The agent | twenty small repositories through the shipping engine: solved, false claims, collateral, Undo, cost | `LMSTUDIO_EVAL=1 npm run eval:agent -- <model>` | baselines owed: both 2026-09-28 attempts voided by PCIe errors on the bench | [agent.md](evals/agent.md) |
| Head-to-head | blind critic comparisons of two builds over 18 tasks | see `docs/head-to-head/README.md` | round 11 (v2.2): task column 2 won · 0 lost · 16 tied | [head-to-head.md](evals/head-to-head.md) and the round files below |
| Measurement (Track M) | what every run records: per-round latency, committed baselines, the offline wire gate, the live world, the latency bench | in the file, per instrument | the instrument, not a score | [measurement.md](evals/measurement.md) |
| Speed (Track S) | S1–S6 and what would measure each | `test/promptCache.test.ts` today | nothing measured yet | [speed.md](evals/speed.md) |

## Where each section went

Code comments and release notes cite sections of this file by heading; each heading is here.

| Section | File |
| --- | --- |
| What each suite judges; Caveats, printed with every run | [method.md](evals/method.md) |
| Measured, 2026-08 (qwythos-9b, temperature 0); The grounding ladder reaches quantities (v1.9.2); The answer that went to the wrong channel (v1.9.2) | [answers.md](evals/answers.md) |
| Project-wide recall, measured (v1.11) | [project-recall.md](evals/project-recall.md) |
| Market indicators, measured (v1.12) | [market.md](evals/market.md) |
| Orchestrated mode, measured (v1.12.1) | [orchestrated.md](evals/orchestrated.md) |
| Six dimensions that should not depend on model size (v1.12.2); Rounds 2–6 | [head-to-head.md](evals/head-to-head.md) |
| Round 7 (v1.17.1) | [head-to-head-round-7.md](evals/head-to-head-round-7.md) |
| Round 8 (v1.17.3); A note on the version numbers in this document | [head-to-head-round-8.md](evals/head-to-head-round-8.md) |
| Rounds 9–11 (v2.1, v2.2) | [head-to-head-rounds-9-11.md](evals/head-to-head-rounds-9-11.md) |
| Findings worth keeping | [findings.md](evals/findings.md) |
| Findings worth keeping: the "Pending fold-in" sections | [findings-pending-fold-ins.md](evals/findings-pending-fold-ins.md) |
| MCP tools on the wire (v2.5) | [tools.md](evals/tools.md) |
| The fact ledger: does verification compound? (v2.6) | [fact-ledger.md](evals/fact-ledger.md) |
| ZIM packs (v2.8) | [zim.md](evals/zim.md) |
| Mid-turn steering (v2.7) | [steering.md](evals/steering.md) |
| Code Mode (v2.7) | [code-mode.md](evals/code-mode.md) |
| Long documents: outline-then-fill (v2.6) | [long-documents.md](evals/long-documents.md) |
| VIBE: where the brevity line goes (v3.0); VIBE's tool-choice arm (v3.1, M3) | [vibe.md](evals/vibe.md) |
| Two things a plan claimed about a process that had died (v3.0.1); CL1: the loader that deleted what disk could not return (v3.0.1) | [plan-and-loader.md](evals/plan-and-loader.md) |
| The agent, measured (v3.1, `eval:agent`) | [agent.md](evals/agent.md) |
| The unrun-claim guard: a report that says the tests pass when the task does not show it, marked; the detector read for tense, mood and subject, one rule on both sides of the gate, 4.4's "3 in 99" corrected (v4.5, H3, H3b) | [claims.md](evals/claims.md) |
| Track M: what every run now records (v4.1) | [measurement.md](evals/measurement.md) |
| Speed: Track S (v4.1) | [speed.md](evals/speed.md) |

A section that says "above" or "below" was written for the single file. The order is kept inside
each file, and this table gives the rest.
