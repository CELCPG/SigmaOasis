# Sigma Oasis — Agentic tool calling & model routing

Status: **Layers 0–4 shipped** (v1.3–v1.5) · complete · Author: Colin Long

> **Where this stands (2026-08-03).** All four layers are shipped, pinned
> by 731 node:test checks. Measured on the live harness (19 fixtures,
> `gemma-4-e4b-agentic` 4B vs `google/gemma-4-12b-qat`):
>
> | | 4B agentic | 12B QAT |
> | --- | --- | --- |
> | correct-tool | 12/16 (75%) | 15/15 (100%) |
> | spurious · arg-validity · loop | 0% · 100% · 0% | 0% · 100% · 0% |
>
> The 4B started at 9/16. Live-probing its seven failures showed three were
> not under-calls at all but well-formed calls in content-formats nothing
> parsed — `<call>name{json}</call>` and two JSON-blob shapes
> (`{"tool_calls": [...]}`, `{"tool_call": name, "args": {...}}`). Teaching
> `nativeToolCall.ts` all three (same rule: malformed drops, bare argument
> objects with no tool name are never guessed) recovered those fixtures
> exactly, 9/16 → 12/16. The four that remain: two plain-prose under-calls,
> one bare-args emission, one reasoning-format miss. Two measurements shaped
> what shipped:
>
> - **The 1d preamble backfires on reasoning models.** Forcing it on
>   (`EVAL_FORCE_PREAMBLE=1`) dropped the 4B to 44% — the model talks itself
>   out of calling. The reasoning gate is now evidence, not heuristic.
> - **Under-calling is model-fixable, not prompt-fixable** — 56% → 100% by
>   size class alone, and 75% → 100% from the 4B's remaining failures. That
>   is 2d's entire premise, validated with data.
>
> Shipped beyond the spec: the eval also runs in-app (Settings → Models →
> Run eval) on the same shared runner as the CLI (`lib/evalRunner.ts` — the
> two shells cannot drift), chunked runs (`EVAL_FIXTURES=a-b`), a per-request
> timeout, and scores folded into the model picker (0c). Deliberate
> deviations: 2b's signal priority is image > code > finance > factual
> (finance vocabulary is more specific than `looksFactual`; abstention is the
> safety net), and in orchestrated mode a classified turn goes straight to
> the specialty slot with delegation intact. Findings A–H are all closed —
> Layer 3 (3a arg repair + schema gate, 3b identical-call reuse, 3c per-tool
> turn budgets) landed in `agentLoop.ts` with two new loop options
> (`repairIterations`, `toolBudgets`) and 12 new checks. Post-Layer-3 eval on
> the 4B is unchanged (9/16, no repair or budget events fired) — expected:
> Layer 3 guards execution quality, and the 4B's dominant failure is still
> under-calling, which Layer 2's routing/measurement work already showed is a
> model-size problem, not a loop-mechanics problem. Layer 4 (the trace
> factory) landed as `main/ipc/traceExport.ts` with two shells that cannot
> drift — in-app (Settings → Privacy → Export traces (SFT), IPC
> `traces:export`) and CLI (`npm run export:traces`). 4a/4c: OpenAI JSONL with
> redaction at the boundary and a schema-version content stamp; 4b: labels
> from the verification stack (positive requires mechanical evidence of a good
> ending; contradicted/errored/capped turns export to the rejected file;
> unsettled turns are unlabeled and excluded); 4d is `docs/trace-export.md`.
> Everything below is the
> original proposal, kept as the record of *why*.

v1.1/v1.2 built the *honesty* ladder — prevent → detect → review → settle. This
document is the *competence* ladder: getting a 7B model running on someone's
laptop to pick the right tool, with the right arguments, and to hand work to
the right slot. It follows the same two design principles, because they are
what made the grounding layer work:

1. **Decide in code what code can decide.** `looksFactual()` beats every
   version of "please remember to search" we tried. Model judgment is the
   fallback, not the first resort.
2. **Every decision is visible.** A routing choice the user can't see is a
   routing choice they can't correct.

---

## 0. Diagnosis — what the current code actually does

Read against `src/renderer/src/hooks/useLMStudio.ts`, `src/main/ipc/tools.ts`,
and `src/main/ipc/store.ts`:

| # | Finding | Where |
| --- | --- | --- |
| A | **Every model sees all 15 tools, every turn.** `tools:list` returns the globally-toggled set; `runTurn` passes it unchanged to every slot, and `runConsultation` hands the same list to every specialist. Tool schemas are ~1.5–2.5 K tokens — and `planAndCompact` already subtracts `estimateTokens(JSON.stringify(tools))` from the history budget, so the whole list is directly evicting conversation. | `tools.ts:842`, `useLMStudio.ts:895`, `:919` |
| B | **Tool gating is global-only.** `ToolToggles` is a flat 15-boolean record on `AppSettings`. There is no per-role or per-turn notion of which tools a slot should hold. | `store.ts:45-61` |
| C | **Delegation is chosen from truncated prose.** `consultModelSchema` builds the specialist roster from `systemPrompt.slice(0, 140)` — a persona fragment, not a capability declaration. The orchestrator is asked to infer who is good at what from half a paragraph. | `useLMStudio.ts:448` |
| D | **`@mention` is a bare substring match.** `lower.includes('@coder')` matches inside code fences, quoted text, and URLs. | `useLMStudio.ts:239` |
| E | **Malformed tool arguments execute anyway.** `JSON.parse` failure falls through to `executeTool(name, {})` with a comment saying so. No schema validation before dispatch, no repair round. | `useLMStudio.ts:1060-1066`, `:539-544` |
| F | **The only budget is a round counter.** `MAX_TOOL_ITERATIONS = 8` and `MAX_DELEGATIONS_PER_TURN = 5`. Nothing detects the same call with the same args repeating, and nothing caps a single tool. | `useLMStudio.ts:53-55` |
| G | **Nothing measures any of this.** 30 test files, none of which exercise tool *choice*. Every proposal below is unfalsifiable until that changes. | `test/` |
| H | **The loop lives inside a React hook.** 1 747 lines, unreachable from `node:test` — which the v1.2 checklist explicitly forbids ("logic lands where the `node:test` suite can reach it"). | `useLMStudio.ts` |

The one decision made mechanically — `looksFactual` → forced pre-search — is
the part that works. Generalize it.

---

## Sequencing

| Layer | Ships | Effort | Risk | Unblocks |
| --- | --- | --- | --- | --- |
| 0 · Extract the loop + tool-choice eval | v1.3 | M | Low | everything |
| 1 · Shrink and shape the decision | v1.3 | M | Low | — |
| 2 · Explicit, mechanical routing | v1.4 | L | Med | — |
| 3 · Repair & budget the loop | v1.4 | S | Low | — |
| 4 · Traces & SFT | v1.5 | L | Med | needs 0 |

Layers 1–3 are where the near-term accuracy is. Layer 4 is the compounding
one, and it is worthless without Layer 0 to prove it moved anything.

---

## Layer 0 — Measure first (v1.3)

**0a. Extract `agentLoop.ts`.** Lift `runTurn`'s tool loop out of the hook into
a plain module taking `(messages, tools, deps: { stream, executeTool, audit })`.
The hook keeps React concerns (patching, streaming lock, voice); the loop
becomes a testable state machine with injectable transport. This is a
refactor with no user-visible change, and nothing else in this document is
honestly testable without it.

**0b. A tool-choice eval harness.** `test/fixtures/toolchoice/*.json`:

```json
{ "prompt": "what's in ~/Downloads", "expect": { "tool": "list_directory" } }
{ "prompt": "write me a haiku about rain", "expect": "no_tool" }
{ "prompt": "what did Phish play in Hampton in 1997", "expect": { "tool": "web_search" } }
```

Four scores, per model:

- **correct-tool rate** — right tool named on turns that need one
- **spurious-call rate** — a tool called on `no_tool` fixtures (the expensive
  failure: latency and egress on "write me a poem")
- **arg-validity rate** — arguments that pass the tool's own JSON schema
- **loop rate** — turns that hit `MAX_TOOL_ITERATIONS`

Gated behind `LMSTUDIO_EVAL=1` so CI stays offline, matching the existing
no-network test posture. Report lands in `scripts/eval-tools.ts` and prints a
table. These four numbers are the scoreboard for the rest of this document.

**0c. Surface the score in the model picker.** `modelInfo.ts` already refuses
to claim tool support a model doesn't have. Once a model has been evaluated
locally, show it: "tool choice 8/10 · 1 spurious." Users pick a tool-calling
model on evidence instead of on a badge.

---

## Layer 1 — Shrink and shape the decision (v1.3)

Nothing here requires training. It is the cheapest accuracy on offer, and it
attacks finding **A** directly: small models degrade sharply as the tool list
grows, and 15 schemas is well past where a 7B holds the distinction between
`web_search`, `fetch_webpage`, and `deep_research`.

**1a. Per-role tool allowlists.** `ModelConfig.tools?: string[]` — `null`/absent
means "all globally-enabled tools," so existing settings migrate untouched via
the established `{ ...defaults, ...current }` merge. Coder holds file + terminal;
Researcher holds search/fetch/deep_research; Finance Coach holds the calculator.
Settings → Models gains a checkbox grid per slot. This also fixes a quiet
security wart: today the Finance Coach can call `run_terminal_command`.

**1b. Per-turn subsetting by relevance.** Even inside a role, most turns need
two tools, not seven. Embed each tool's description once at startup through the
existing `/v1/embeddings` path (`embeddings.ts`, `retrieval.ts`), cosine-match
against the user turn, and send *always-on* tools (`get_current_datetime`,
`memory_*`) plus the top-k matches, capped at ~6. Degrades to the full
allowlist if embeddings are unavailable — it is an optimization, never a
gate. Expect the largest single win in the table, and it buys back 1–2 K
tokens of history on every turn.

**1c. Rewrite tool descriptions as decision rules.** Current descriptions name
the tool; they don't tell a small model when *not* to reach for it. Each
description gets three parts — use when / do not use when, naming the correct
alternative / one canonical argument example:

```
web_search — Search the public web for facts you cannot verify from context.
Use when: names, dates, titles, numbers, or anything after your training cutoff.
Do not use when: the answer is in a local file (read_file), in the user's notes
(read_note), or in long-term memory (memory_search).
Example: {"query": "Phish Hampton 1997 setlist"}
```

The confusion pairs to attack explicitly: `web_search` vs `deep_research`
(one query vs a budgeted multi-query campaign), `fetch_webpage` vs
`web_search` (URL in hand vs not), `memory_search` vs `read_note` (recall vs
retrieval), `list_directory` vs `run_terminal_command` (never shell out for
something a typed tool does). The inline example is the inference-time form of
the "exact JSON schema paired with the output" discipline from the SFT
literature — and it costs a schema edit, not a training run.

**1d. One line of reasoning before a call.** For non-reasoning models, add to
the grounding block: *"Before calling a tool, state in one sentence why it is
needed and what you expect back."* Do **not** add this for reasoning models —
Qwen3, R1 distills and gpt-oss already emit chain-of-thought that
`reasoning.ts` splits out, and a second mechanism produces doubled thinking in
the answer body. Gate on the same signal the splitter uses. The sentence
renders in the tool-call block, so the user sees the model's stated reason
next to what it actually did — which is the existing disclosure philosophy,
applied one level down.

**Tests.** Allowlist filtering per slot; subsetting keeps always-on tools and
respects the cap; embedding-failure fallback returns the full allowlist;
CoT preamble is suppressed for reasoning models.

---

## Layer 2 — Explicit, mechanical routing (v1.4)

**2a. Capability declarations replace truncated personas.** Add
`ModelConfig.capability?: string` — one line, author-written, in the shape
*"send me X; don't send me Y."* The `consult_model` roster becomes structured
rather than a prose slice:

```
Coder — send me: code, refactors, stack traces, file edits. Don't send me:
open-ended research. Tools: read_file, write_file, run_terminal_command.
Context: 32K. Vision: no.
```

Tools and context/vision facts come free from the role's allowlist (1a) and
`modelCatalog.ts`. Zero runtime cost; it replaces guesswork with a spec.

**2b. A pre-flight router that decides what code can decide.** Before the
orchestrator spends a completion on "who should handle this," run a
classifier in code — the same shape as `looksFactual`, in the same file
family:

| Signal | Route |
| --- | --- |
| image attachment present | a vision-capable slot (`modelCatalog` already knows which) |
| fenced code, stack trace, or a file path | the coding role |
| `looksFactual()` true | the research role |
| currency/rate/amortization vocabulary | the finance role |
| none of the above | **abstain** — the orchestrator model decides |

Abstention is the point: the classifier only claims turns it can claim
confidently, and everything else falls through to model judgment exactly as
today. The decision is shown in the bubble — *"routed to Coder — fenced code
detected"* — the same way memory recall and auto-search are shown, and it is
overridable with an `@mention`.

**2c. Fix `@mention` matching.** Strip fenced and inline code before matching;
require a word boundary. A one-function change and a clear bug class closed.

**2d. Escalation — the routing decision the app doesn't make yet.** "Route to
another model" today means delegation. The other case is a turn that *went
badly*, and v1.2 already produces the mechanical signals for it: `unverified`,
a `contradicted` claim-check verdict, an iteration-cap stop, or a tool that
errored twice. Any of those offers a re-run on a larger or differently-tooled
slot, with the failure stated as the reason. It extends the ladder honestly —

> prevent → detect → review → settle → **escalate**

— because the trigger is a mechanical outcome, never a model saying it feels
unsure. Default: offer, don't auto-run. Silent re-answering hides exactly what
the user needs to see, which is why §5 of the v1.2 roadmap rejected automatic
retry; an offered escalation keeps the contradiction on screen.

**Tests.** Classifier fixtures per signal, including abstention; mention
matching inside/outside code fences; escalation offered on each trigger and
not otherwise; escalation never fires on an ephemeral chat without consent.

---

## Layer 3 — Repair and budget the loop (v1.4)

**3a. Validate arguments before dispatch.** The schemas are already in
`tools.ts`; check against them before `executeTool`, and on failure return a
structured repair message — *"`path` is required and must be a string; you sent
`{}`"* — rather than executing an empty call. One free repair round per call
site, not counted against `MAX_TOOL_ITERATIONS`. This alone should move
arg-validity materially for small models, whose dominant failure is a missing
or misnamed field, not a wrong tool.

**3b. Loop detection.** Same tool + identical arguments twice in a turn
returns the previous result with a note instead of re-running it. Cheap, and
it kills the classic small-model spin where a model re-reads the same file
four times before answering.

**3c. Per-tool budgets, disclosed.** Round count is a blunt cap. Add per-tool
limits (e.g. 3 searches, 2 fetches per turn), checked *before* the call and
stated when hit — "search budget reached (3 of 3)" — matching the deep-research
ledger and the claim-check budget language. Budgets before work, disclosed on
the stop, never reported after the fact.

**Tests.** Schema validation rejects/repairs per tool; repeat-call detection;
per-tool budget enforced before dispatch and surfaced in the bubble.

---

## Layer 4 — Traces and fine-tuning (v1.5)

The SFT strategies from the local-model community all reduce to one hard
problem: *getting clean, correctly-labeled traces*. Sigma Oasis is unusually
well positioned here, and it should ship the trace factory rather than a
training pipeline.

**What the app already produces.** The audit log records `assistant_output` and
`tool_call` events with arguments and outcomes, hash-chained and
keychain-encrypted (`audit.ts`). That is, structurally, the exact sequence SFT
wants: user request → assistant tool call with arguments → tool output →
final grounded response.

**4a. Trace export.** `scripts/export-traces.ts` reads the audit log and emits
OpenAI-format conversational JSONL — `system`, `user`, `assistant` with
`tool_calls`, `tool` results, final `assistant`. Constraints, non-negotiable:
opt-in per export, never touches ephemeral chats (they are RAM-only by
construction and must stay that way), and a redaction pass over paths,
hostnames, keys and obvious PII runs before anything is written outside the
app's own directory.

**4b. Label from outcomes, not from vibes.** This is the part most people
fine-tuning tool use cannot do, and v1.2 handed it to us. A trace is exported
as **positive** only when the turn mechanically ended well: no `error` tool
records, no iteration-cap stop, and either not flagged `unverified` or with
all claim-check verdicts `confirmed`. Traces that ended `contradicted`,
errored, or looped export to a separate file — they are the rejected half of
preference pairs, not garbage. The verification stack becomes a labeling
function.

**4c. Schema-exact formatting, versioned.** Export the tool schemas alongside
the traces and stamp each trace with the schema version that produced it. A
fine-tune trained against yesterday's argument names is a syntax-drift
generator; a version stamp makes stale traces detectable instead of silently
poisonous.

**4d. Train out of band, evaluate in band.** Training happens in MLX-LM,
Unsloth, or llama.cpp LoRA — outside the app, documented as a recipe in
`docs/`. The user loads the resulting GGUF back into LM Studio, and Layer 0's
harness scores it against the base model on the same fixtures. The app's
contribution is traces in and evidence out; it never becomes a training rig.

**Honest expectations.** A LoRA on a few hundred of your own traces reliably
fixes argument-format drift and tool selection *within your fixed toolbox*. It
will not teach a 7B model to reason about delegation, and it re-freezes the
model against the tool schemas of the day it was trained. Layers 1–3 are the
near-term wins; Layer 4 compounds, and only if the harness says so.

---

## 5. Considered and rejected

| Proposal | Verdict | Why |
| --- | --- | --- |
| Adopt LangGraph (or similar) for orchestration | **Rejected** | The loop is already a state machine; the problem is that it lives in a React hook (finding H), not that it lacks a framework. A server-oriented graph runtime brings its own persistence and process assumptions into an Electron app whose whole premise is that nothing leaves the machine. Take the idea — an explicit, inspectable, testable state machine — and skip the dependency. Layer 0a is that idea. |
| A dedicated small "router model" in a fourth slot | **Rejected for now** | A second model load per turn on a laptop that is already holding one, to answer a question a regex answers for the clear cases and the orchestrator answers for the rest. Revisit only if Layer 2b's classifier abstains on most turns — which the eval will tell us. |
| `tool_choice: "required"` on factual turns | **Rejected** | Forcing a call is how you get `web_search("hello")`. The v1.1 mechanism is better: the app runs the search itself and injects the result, so the model never has to be coerced. |
| Let the model rate its own tool choice | **Rejected** | Same reason as numeric confidence scores in v0.9 and v1.2 — a model grading itself says yes. The eval harness grades tool choice against fixtures; the loop grades arguments against schemas. |
| Auto-escalate failed turns to a bigger model silently | **Rejected** | Hides the failure the user most needs to see, and quietly changes which model answered. Offer it, name the reason, let the user press it (2d). |
| Ship SFT before the eval harness | **Rejected** | Unfalsifiable by construction. Layer 4 depends on Layer 0 and is sequenced behind it. |

---

## Cross-cutting checklist

- **Settings migrations.** `ModelConfig.tools` and `.capability` are optional;
  absent means today's behavior, merged through the existing defaults pattern.
- **Egress honesty.** Layer 1b's tool embeddings hit the local LM Studio
  server only. Layer 2's routing initiates no network calls. Layer 4's export
  writes to disk and never uploads.
- **Wire-history hygiene.** Routing reasons, CoT preambles, and eval scores are
  display-only and excluded from what is replayed to models, through the one
  shared serializer.
- **Budgets before work.** Every cap in Layer 3 is checked before the call and
  disclosed on the stop.
- **Tests reach `node:test`.** Layer 0a is what makes that possible for the
  loop; nothing in Layers 1–3 may land as renderer-only logic.
- **README.** Each shipped feature gets a section in the same voice — what it
  does, what it costs, what it deliberately does not do.
