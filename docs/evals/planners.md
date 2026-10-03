# The think-first planners

Part of the [evals index](../evals.md).

## A grammar beside `thinking: false`, measured on four planners (v4.5, H2)

`npm run probe:planners -- --planner all` (scripts/probe-planners.ts) asks plan mode, the
outline, deep research's planner and its query reformulation on a live model, twice each: the
caller's own request as the app sends it (a `json_schema` grammar beside `thinking: false`, no
prefill) and the same request asked plainly (no grammar, so `thinking: false` becomes the
closed-think prefill, the JSON shape said in the prompt, the reply read tolerantly). The callers
are the compiled production modules (their own request builders and parsers); only electron, the
store, the network seam and the model pin are stubbed. Twelve realistic prompts per planner per
arm, interleaved ABBA across prompts, one row per call. Valid means the caller's own reader found
a usable answer (a real plan, not its fallback); schema-valid is stricter and is what the
grammar guarantees.

4.4 (G5) found that a `<think>` family ignores the pairing in LM Studio: the re-rank's 80 tokens
all went to reasoning. These four have larger budgets, so the question was whether they answer
late or not at all. qwen3.8-9b-distill, LM Studio on the Intel Arc Pro B65, 2026-10-03, no other
model busy:

| planner | arm | valid | schema-valid | median s | p90 s | median tokens | thought first | timeouts / reasoning-only |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| plan mode (no token cap) | grammar | 12/12 | 12/12 | 14.0 | 15.9 | 558 | 12/12 | 0 / 0 |
| | prefill | 12/12 | 9/12 | **8.8** | 13.2 | 336 | 0/12 | 0 / 0 |
| outline (cap 1,500) | grammar | **3/12** | 3/12 | 31.9 | 33.8 | 1,500 | 12/12 | 0 / **8** |
| | prefill | **12/12** | 11/12 | **7.7** | 9.4 | 355 | 0/12 | 0 / 0 |
| research planner (cap 700) | grammar | 12/12 | 12/12 | 5.3 | 6.6 | 212 | 12/12 | 0 / 0 |
| | prefill | 12/12 | 10/12 | **4.4** | 6.0 | 182 | 0/12 | 0 / 0 |
| reformulation (cap 400) | grammar | 11/12 | 11/12 | 9.0 | 12.9 | 266 | 12/12 | 0 / 0 |
| | prefill | 9/12 | 0/12 | 3.5 | 5.4 | 127 | 0/12 | 0 / 0 |

- **Every grammar call thought first** (48 of 48 in the grammar rows). Plan mode and the research
  planner answered late (+5.8 s and +1.3 s median, paired); the outline's 1,500 tokens were spent
  thinking in 8 of 12 (the reply was cut mid-thought) and one more answer was cut mid-JSON — it
  wrote no outline in 9 of 12.
- **Applied** where the plain request was no worse on validity and faster: plan mode, the outline
  and the research planner, on a `<think>` family only (`THINK_TAG_MODELS`, the re-rank's
  detection). Every other family (Gemma 4 among them) is sent today's request byte for byte;
  `test/plannerRequests.test.ts` pins it against bodies captured from the code before H2.
- **Left**: the reformulation. Plain was faster (3.5 s against 9.0 s) but valid 9/12 against 11/12
  (a detail re-ask: 8/12): the model flattens the nested `{"queries":[{"queries":[…]}]}` the prompt
  describes into one list, or a list of lists, and the reader falls back to the old queries. A
  reader that accepts those shapes would be a change to measure on its own; until then the
  reformulation keeps the grammar on every family.
- **The outline's section calls were never in this**: they send no grammar, so a `<think>` family
  already gets the closed-think prefill there (the retry for a model that reopens its thinking
  stays).
- **Plan mode's tool disclosure under the plain request** (a detail re-ask, 4 tool-enabled prompts,
  both arms): every step carried its `tools` list except one tool-free closing step ("Output the
  prioritized fix list") that omitted the field; plan #9 left the schema in both plain passes, and
  the detail re-ask shows why. The reader shows an omitted field as an empty list.
- Plain replies depart from the schema more often (an extra key, three queries where two are
  allowed, a bare string among the sub-questions); the planners' readers were built for exactly
  that and kept every one but a malformed research plan (1 of 24 plain research-planner calls
  over both passes fell back to the one-question plan; 0 of 12 grammar calls did).
