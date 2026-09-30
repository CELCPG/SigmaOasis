# Sigma Oasis v4.2.0 — a plan the agent keeps, a web trigger that was measured, and a library that reads the question

4.1 measured first and spent the measurement on speed. 4.2 builds the larger pieces the 4.1 plan
held back: the structured plan round the 4.0 roadmap specified, per-family thinking, a web trigger
trained and scored on a labelled set instead of grown one miss at a time, a library that can
re-rank what it hands over, draft-model decoding for the models that gain from it, and the four
largest files split along their own seams. Every new behaviour that costs a model call or changes
how the agent works is off by default until `eval:agent` or its own bench says otherwise.

## The agent, measured

`qwen3.8-9b-distill`, the same 26 cases, two passes a run, 2026-09-30:

| run | passes (solved of 26) | false claims | collateral |
| --- | --- | --- | --- |
| 4.1 engine (twice) | 18, 21 · 20, 19 | 0/104 | 7/104 |
| **4.2 engine, experiments off** (twice) | 14, 16 · 17, 21 | 0/104 | 12/104 |
| 4.2 + `planRound` | 14, 16 | 1/52 | 5/52 |

- **With its experiments off, 4.2's agent is 4.1's.** The requests it sends are byte-identical
  (both engines' first rounds captured and compared, with and without the document and chore
  tools), and the tools run the same code. Its first run's 14 and 16 sat below every 4.1 pass; its
  second's 17 and 21 did not. The spread is the noise floor 4.1's notes record: one pass of the
  same code ranges from 14 to 21.
- **`planRound` stays off.** Against its own engine's run it held the solved rate and cost one
  false claim in 52 — the one thing the gate never trades. `thinkByPhase` with the new family
  profiles was not measured tonight (its arm was cut for the repeat that settled the noise).
- The gate needs four passes and a noise band before it can decide a default by itself; that is
  4.3's first item.

## The agent

- **A plan round** (A4, as the 4.0 roadmap specified; the new `planRound` experiment, off). On a
  task's first turn one request, with no tools, asks for the steps as JSON — grammar-constrained
  where the server allows, retried without the constraint on a 400, read tolerantly. Three steps
  or more become the checklist, filed in the history as the model's own `todo_write`. Each round
  names the current step in a transient message, never in the system prompt, so the prompt cache
  keeps its prefix; a finished step's output is the first thing set aside. A step closes only with
  evidence — after an edit, a passing command or a read — and an unbacked tick is taken back once.
  A check that fails after a change, or a stuck warning, earns one replan per task. `planFocus`
  is unchanged, so its 4.1 measurement stands.
- **Thinking by the family's prior** (A3). What the coming round is — first, the user's, after a
  failure, the likely report, after a read, after an edit — is labelled, and each family's profile
  says which of those think. Qwen3 and Magistral think on the first round, after a failure or a
  stuck note, and before the report, and start closed after a read or an edit; R1 distills close
  only after a read; Gemma 4 and gpt-oss cannot close theirs, so a quiet round is capped at 8K
  instead, and a round of nothing but thinking is re-asked with a plain note. The existing
  `thinkByPhase` experiment uses the profile.
- **A 4.0 bug under both experiments:** the transient plan message counted as the user speaking,
  so every round thought. It no longer does.
- **Longest single step** — Settings → Agent: 16K (default), 8K or 4K output tokens per round,
  through the app, jobs, the CLI and `eval:agent` (`EVAL_ROUND_MAX_TOKENS`). 4.0.2's truncation
  repair handles a round the cap cuts.

## Whether a turn needs the web, measured

The web trigger was regex word lists that grew one miss at a time; 4.0.1 missed the weather, the
futures and the next game. 4.2 trains a classifier and keeps the lists as overrides.

- **A labelled set**, `test/fixtures/webTrigger/labelled.jsonl`: 858 prompts written as people type
  them — 227 live, 261 web, 370 none — with the hard negatives ("futures" in Rust, "my next game",
  "weather the storm", "a poem about rain") and the 4.0.1 session. 215 are held out by a hash of the
  id and never seen by training or threshold choice.
- **A classifier in plain TypeScript**: logistic regression over word and character n-grams,
  trained by a deterministic script (`scripts/train-web-trigger.sh`), 115 KB of weights, about
  50 µs a message. A regex hit still decides; creative and coding intent still veto.
- **Held out, 215 prompts:**

  | | precision | recall | false alarm |
  | --- | --- | --- | --- |
  | live — 4.1 rules | 75.0% | 10.3% | 1.3% |
  | live — rules + classifier | 93.2% | 70.7% | 1.9% |
  | web or live — 4.1 rules | 78.7% | 30.3% | 10.8% |
  | web or live — rules + classifier | 87.6% | 75.4% | 14.0% |

  `test/webTrigger.test.ts` holds recall at or above the rules' and caps the false alarms. The
  prompts are written, not traced from real use; `docs/web-trigger.md` says how to add examples and
  retrain.
- **"latest version" is live now**, so the ledger stays out of it — the known gap 4.1 pinned.

## The library

- **Re-rank** — Grounding & checks → *Re-rank library passages*, off. For health, first-aid,
  finance and building questions only, the answering model reads up to fifteen candidate
  passages and names the ones that answer, in JSON, 80 tokens at most, thinking closed; its picks go
  first and the fused order fills the rest. Any failure, or four seconds, keeps the fused order.
  About 2,500 prompt tokens a lookup.
- **A sample answer for the ranking** — Grounding & checks → *Expand library questions with a sample
  answer*, off, same domains, only with embeddings: two or three
  sentences, embedded locally and averaged with the question's vector for the semantic ranking. It
  never reaches keyword search, the passages, or any request but the local model server.
- **The wrong-section guard**, on: when two passages score within 0.05, the one whose section
  heading shares a word with the question goes first. It fixes the chlorination-for-boiling mix-up
  the 2.x strategy recorded.

## Draft-model decoding

- **A *Draft model* per role** — Settings → Roles, none by default, the role's own and embedding
  models excluded, same-family models marked. The help says when it helps (dense, same family, much
  smaller) and that MTP models such as the 9B distill already draft; the fit sentence counts the
  draft's weights and cache.
- **On the wire last**: `draft_model` is the request's final field, so the bytes before it match
  4.1 and the prompt cache still hits. A server that refuses it before the first token is asked once
  more without it, and the pair is skipped for the session with a quiet note on the LM Studio tab.
  The draft is pinned after its model and keeps its *Keep loaded*.
- **Acceptance in the stats line** ("60% of 80 drafted accepted") when the server reports it.
- **`bench:latency -- <model> --draft <id>`** runs both arms in every repeat.

## Underneath

- **Four files split along their seams**, every public name re-exported from the old path:
  `ipc/search.ts` 1,683 → 388 lines (ten modules in `search/`), `ipc/library.ts` → an 83-line
  facade (nine modules in `library/`), `MessageBubble.tsx` 1,433 → 793 (seven sibling components),
  `ipc/deepResearch.ts` 1,080 → 420 (six phases in `deepResearch/`).
- **`docs/evals.md`**, 7,970 lines, is a 63-line index; the content moved, byte for byte, into 22
  files in `docs/evals/`, with a table from every old heading to its new home.

## Measured

On Windows: `npm run typecheck` clean; the node suite 3,569 of 3,569 (4.1's 3,484 and 85 new);
every Electron check — render 25, style 74 and 123, tab traversal 43, modal focus 179, field
contrast 22, settings kit 12, button names 20, plan accessibility 175, main bundle 20, markdown 62,
workbench 53, MCP secrets 19, transport 24.

## Not in this release

- The family thinking profiles and the 8K quiet cap are priors with scripted-model tests, not yet
  an `eval:agent` arm; `planRound` was measured once (above) and stays off.
- Re-rank, the hypothetical answer and draft models are off and unmeasured on a model.
- Dependency upgrades: `docs/dependencies-4.1.md` has the order; none was made.
- Agent replies do not show draft acceptance yet.

## Upgrade notes

- New settings: *Longest single step* (Agent), *Draft model* (Roles, none), *Re-rank library
  passages* and *Expand library questions with a sample answer* (Grounding & checks, off),
  `agent.experiments.planRound` (off). A 4.1 settings file reads unchanged.
- Code that imported from `ipc/search.ts`, `ipc/library.ts`, `ipc/deepResearch.ts` or
  `MessageBubble.tsx` keeps working; the new folders sit beside the facades.
