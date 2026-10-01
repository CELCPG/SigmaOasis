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
