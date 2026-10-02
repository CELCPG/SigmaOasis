# Tool choice: MCP tools on the wire

Part of the [evals index](../evals.md).

## MCP tools on the wire (v2.5)

`LMSTUDIO_EVAL=1 EVAL_MCP_STUB=<n> EVAL_PASSES=3 npm run eval:tools -- <model>` connects `n`
stub MCP servers (three tools each, deliberately overlapping descriptions) through the real
manager, puts their tools on the wire after the 25 built-ins exactly as the app does, and asks
the scope's question: does their presence move the built-in correct-tool and spurious-call
rates? A call to a stub tool is spurious by construction — no fixture expects one.

**The first run measured the wrong list, and the wrong list is a finding.** Through v2.4 the
tool-choice eval had always sent the whole toolbox: 25 schemas, which is not what the app
sends — the app ranks tools by embedding against the user's text and caps a turn at six. With
MCP servers connected the whole-toolbox list stops being a harmless overstatement:

| MCP tools on the wire (unranked) | clean per pass | correct-tool | what the model did |
| --- | --- | --- | --- |
| 0 (25 schemas) | 22, 22, 22 of 24 | 57/63 · 90% | — |
| 12 (37 schemas) | 4, 4, 4 | 3/60 · 5% | **called nothing** on 57 of 72 runs |
| 36 (61 schemas) | 0, 0, 0 | — | every request refused: 10,271 tokens over an 8K window |

qwen3.8-9b at 8,192 context, temperature 0, three passes, no flaky case in any row. That is a
9B facing 37 schemas: it does not pick the wrong tool, it stops picking. And at 61 the request
does not fit. Neither is the app's turn, which is why `EVAL_SUBSET=1` now exists: the eval
ranks with the same cosine over LM Studio's `/v1/embeddings` and caps at the same six, per
fixture, so the number below is the app's.

Since v4.3 an `EVAL_SUBSET=1` run is its own arm: `arm: 'subset'`, written as
`subset-toolchoice-*.json`, outside the model picker's score line and never merged with a
whole-toolbox run by `eval:diff`. Through 4.2 it was written as a whole-toolbox run.

**The app's list, measured** (`EVAL_SUBSET=1`, same model, context, temperature and passes):

| MCP servers connected | schemas registered | on the wire per fixture | clean per pass | correct-tool | spurious |
| --- | --- | --- | --- | --- | --- |
| 0 | 25 | 6.0 | 22, 22, 22 of 24 | 57/63 · 90% | 0/9 |
| 4 (12 tools) | 37 | 6.0 | 22, 21, 22 | 57/63 · 90% | 0/8 |
| 12 (36 tools) | 61 | 6.0 | 22, 22, 22 | 57/63 · 90% | 0/9 |

The one non-clean pass in the 4-server row is `18-no-tool-explain`, which LM Studio answered
with an HTTP 500 on the second pass and correctly on the other two — a server hiccup, recorded
as flaky, not a model choice. With the app's selection in place, connecting servers changes
nothing the model sees unless a server's tool outranks a built-in for the user's text, and
on these 24 fixtures none did: the same six tools went on the wire, the same 57 calls were
right, and no stub tool was ever called. The scope's reserved-slots mitigation (§4.5) stays
unbuilt, with this table as the reason.

## The distill, re-measured after 4.1 and 4.2 changed the descriptions (v4.3)

4.1 dropped the tool descriptions' Example lines (S5, `adceca4` — the only change to
`src/shared/tools/defs` between 4.0.1 and 4.2.0) and added the live fixtures. Both arms re-run on `qwen3.8-9b-distill` (68,608-token window, temperature 0), four separate one-pass
runs each, 2026-09-30 night, no server error in any run. The whole-toolbox runs are the first
tool-choice baseline, `baselines/toolchoice-qwen3.8-9b-distill.json`; the subset's baseline was
re-recorded the next day, below.

| arm | clean per pass (of 28) | correct-tool | spurious (no-tool) | loops | invalid arguments |
| --- | --- | --- | --- | --- | --- |
| the whole toolbox | 22, 22, 22, 22 | 84/100 · 84% | 0/12 | 16/112 | 0 |
| the subset (`EVAL_SUBSET=1`), ranked only — not quite the app, see below | 23, 23, 23, 23 | 80/100 · 80% | 0/12 | 0/112 | 0 |

No fixture flipped between runs: the noise floor here is zero, and every miss is a choice.

- **Both arms:** `05-web-search-fx` ("EUR to USD") and `27-live-futures` ("s&p futures this
  morning") call `market_data`, whose description says it is daily history and not for live
  quotes; in the subset `05` sometimes calls nothing.
- **The whole toolbox:** `01-list-directory` and `16-shop-compare` call the right tool and then
  loop against the stubs to the cap; `09-datetime` calls nothing; `24-reference-own-docs` lists
  directories.
- **The subset:** `02-read-file` calls `read_note`, `03-write-file` calls `memory_save`,
  `25-live-weather` calls `memory_search`. These runs did not record which six tools each fixture
  put on the wire, so whether the expected one was among them is not known from them. Since 4.3
  (E5) a subset run records each fixture's `wire`, and the failure line says whether the expected
  tool was offered.

Against the subset arm of 2026-09-28 (4.0's descriptions, `vibe.md`), on the 24 fixtures both ran:
21 of 24 then and now. `02-read-file` was lost, `24-reference-own-docs` gained. The descriptions
lost their Example lines and the model lost nothing measurable.

### What the chat really sends (2026-10-01, E5)

The first run that recorded each fixture's wire showed every subset miss to be the ranking's: the
expected tool was never offered — the live weather and futures questions included, which the
chat forces the web pair onto (`webToolsForTurn`, since 4.0.1). The subset arm had only ranked.
It now composes the turn as `chatTurn.ts` does, and the baseline above was re-recorded on it:

| subset arm | clean per pass (of 28) | correct-tool | gained | lost |
| --- | --- | --- | --- | --- |
| 9/30: ranked only (not the app) | 23, 23, 23, 23 | 80/100 | — | — |
| **10/1: as the chat composes the turn** (the baseline) | **22, 22, 22, 22** | 76/100 | `05`, `25`, `27` | `09-datetime`, `10-create-note`, `16-shop-compare`, `22-price-near-miss` |
| 10/1: forced tools on top of the cap (eval only, `EVAL_FORCED_ON_TOP=1`) | 23, 23, 22, 23 | 79/100 | `09`, `10`, `16`, `22` back | `26-live-score`, `27` to `market_data` |

The losses are the chat's own: four tools are always on and the cap is six, so a forced web pair
evicts both ranked picks (`withForcedTools`, by design since 4.0.1 — and it evicts by wire order,
not by rank as its comment says). "What time is it right now?" reaches the model with no
`get_current_datetime`, and "make a note…" with no `create_note`; both are on by default. The
shopping and market tools in the other rows are off by default. Putting forced tools on top of the
cap measured BETTER than the chat as it is (+0.75 clean a pass, band ±0.50) on the eval's full
toolset; the app keeps its behaviour in 4.3, and the decision is ROADMAP-v4.3's F6.

`02-read-file` and `03-write-file` lose to `read_note` and `memory_save` in the ranking itself —
the embedding ranks the notes and memory tools above the file tools for "read the file …" and
"write … to a file". Recorded for 4.4; a ranking change is a wire change and needs its own arm.

## Two switches decided beside same-day controls (v4.4, G2 and G4, 2026-10-01 night)

`qwen3.8-9b-distill` on the 5070, temperature 0, `eval:tools`' subset arm — the chat's own
selection (`selectTurnTools`, `withForcedTools`), the web pair forced as the chat forces it. Every
arm ran four one-pass runs interleaved with four of its control's in one session (ROADMAP-v4.4,
G1), and `eval:diff` read each against that control.

Two changes to the arm itself first:

- **It ranks as the app ranks.** Through 4.3 the arm embedded `name: description`; the app
  (`main/ipc/toolRank.ts`) embeds the description alone. The two rank the file requests
  differently, so every number below is on the app's text, and none is comparable with 4.3's
  subset baseline.
- **The default toolset** (`EVAL_TOOLSET=default`): the 20 tools a fresh install turns on (Code
  Mode off) — the Assistant slot's toolbox. `03-write-file`, `15-shop-requirements`,
  `16-shop-compare` and `22-price-near-miss` expect tools that are off by default and are not
  scored there; 24 fixtures are.

| arm (clean per pass) | default toolset, of 24 | whole toolbox, of 28 | fixtures that moved |
| --- | --- | --- | --- |
| control — the cap (4.0.1–4.3), the ranking alone | 21, 21, 21, 21 | 21, 21, 21, 21 | — |
| **forced tools on top of the cap** (G2, `FORCED_TOOLS_ON_TOP`) | **23, 23, 23, 23 — BETTER**, +2.00 (±0.00) | 23, 23, 23, 23 — BETTER, +2.00 (±0.00) | default: `09-datetime`, `10-create-note` gained, none lost · whole: `09`, `10`, `16`, `22` gained; `26-live-score`, `27-live-futures` lost to `market_data` (off by default) |
| **file tools first** (G4, `FILE_TOOLS_FIRST`) | **22, 22, 22, 22 — BETTER**, +1.00 (±0.00) | 23, 23, 23, 23 — BETTER, +2.00 (±0.00) | default: `02-read-file` · whole: `02`, `03-write-file`; none lost |
| control, its own session | 21, 20, 21, 21 | — | (one loop in one pass) |
| **both switches** (as 4.4 ships) | **24, 24, 24, 24 — BETTER**, +3.25 (±0.71) | — | `02`, `09`, `10`; none lost |

No arm made a spurious call on a no-tool fixture, looped, or sent an invalid argument. The bands
are zero where both sides repeated themselves exactly — at temperature 0 this suite does, pass
after pass — so a fixture that moved, moved every time.

- **On top of the cap (F6).** With four tools always on and a cap of six, a forced web pair took
  both ranked places: "what time is it right now?" went out with no `get_current_datetime` (the
  model called `date_calculator`), and "save a note titled 'gift ideas'…" — which the web
  classifier forces the web pair onto — with no `create_note` (the model called `memory_save`). On
  top, both keep their tool. The cost is the wire: 6.7 tools a fixture on average instead of 6.0,
  8 on a forced turn. On the whole toolbox a kept ranked pick can be the wrong one —
  `market_data`, off by default, took the live score and futures questions.
- **File tools first.** "Read the file notes/todo.md…" ranked `read_note` (0.622) and
  `list_directory` (0.609) into the two places, `read_file` fourth (0.603); "save … to a file
  called groceries.txt" put `write_file` ninth (0.554). A named file — a path with an extension, or
  a document or data file name; not a web address, a folder, or `node.js` — now puts `read_file`,
  `write_file` and `propose_patch` (those the slot has) in the ranked places first.
  `namesLocalFile` is lexical and narrow on purpose; `test/toolSelection.test.ts` pins what it
  takes and refuses. The whole-toolbox arm cannot move: the fix is in the per-turn selection and
  no description changed, so the whole toolbox's wire is byte-identical.
- **Eviction by rank** (`withForcedTools` now drops the lowest-scored pick, as its comment always
  said): the run counts the fixtures where that sent another wire than eviction by wire order —
  **0 of 28**. The chat forces the web pair together or not at all, and two forced tools take both
  ranked places whatever their order; the order matters only for a single forced tool (a sticky
  web tool, a provider's late force), where it now keeps the better-scored pick.

Both switches are on in 4.4 by the rule (BETTER beyond the band, beside a same-day control, no new
false claim — this suite has none to make). The agent never reads the chat's selection
(`src/main/agent` has its own tools), so neither switch moves `eval:agent`.
