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
runs each, 2026-09-30 night, no server error in any run. They are the first tool-choice baselines:
`baselines/toolchoice-qwen3.8-9b-distill.json` and `…-subset.json`.

| arm | clean per pass (of 28) | correct-tool | spurious (no-tool) | loops | invalid arguments |
| --- | --- | --- | --- | --- | --- |
| the whole toolbox | 22, 22, 22, 22 | 84/100 · 84% | 0/12 | 16/112 | 0 |
| **the app's subset** (`EVAL_SUBSET=1`) | **23, 23, 23, 23** | 80/100 · 80% | 0/12 | 0/112 | 0 |

No fixture flipped between runs: the noise floor here is zero, and every miss is a choice.

- **Both arms:** `05-web-search-fx` ("EUR to USD") and `27-live-futures` ("s&p futures this
  morning") call `market_data`, whose description says it is daily history and not for live
  quotes; in the subset `05` sometimes calls nothing.
- **The whole toolbox:** `01-list-directory` and `16-shop-compare` call the right tool and then
  loop against the stubs to the cap; `09-datetime` calls nothing; `24-reference-own-docs` lists
  directories.
- **The subset:** `02-read-file` calls `read_note`, `03-write-file` calls `memory_save`,
  `25-live-weather` calls `memory_search`. The results file does not record which six tools each
  fixture put on the wire, so whether the expected one was among them is not known; recording it
  is a small change to `eval-tools.ts` worth making before the next run.

Against the subset arm of 2026-09-28 (4.0's descriptions, `vibe.md`), on the 24 fixtures both ran:
21 of 24 then and now. `02-read-file` was lost, `24-reference-own-docs` gained. The descriptions
lost their Example lines and the model lost nothing measurable.
