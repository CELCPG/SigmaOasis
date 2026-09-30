# Market indicators

Part of the [evals index](../evals.md).

## Market indicators, measured (v1.12, qwen3.8-9b, temperature 0)

Two synthetic tickers, four questions each — relay the tool's stats, compute a 20-day SMA, state
the max drawdown, produce a chart — tool arm vs. no-tools arm. Expected values recomputed
independently in TypeScript from the same fixture bars.

| arm | figures | charts | used the sandbox | s/question |
| --- | --- | --- | --- | --- |
| **tool** | **6/6** | **2/2** | 4/8 turns | 47 |
| bare | 0/6 | — | — | 27 |

With the tool, **every stated figure reproduces from the series**, and both chart requests
produced a real PNG (close + 20-day SMA, drawn by the model in the sandbox from the staged CSV).
The sandbox ran exactly where computing was needed — both SMA questions, both charts — and the
relay questions were answered from the app's own computed stats, which is what they are for.

Without the tool the tickers are unknowable, and the honest answer is a refusal. The model
**declined on only 3 of 6** — on the other three it stated confident prices and returns for
instruments it has never seen. That is the fabrication behavior from the reviewed sessions
(v1.11.2's laundering fix), now with a number attached, and it is the delta the tool exists to
close.

One scorer bug found and fixed during the run, of the class this file keeps warning about: the
first pass failed a reply that stated the expected drawdown to the exact hundredth — as
"-34.77%" against an expected +34.77, because `numbersIn` keeps the sign. Drawdowns are now
scored sign-agnostically. An eval that fails a correct answer is worse than no eval.

**Second family (mistral-7b-instruct-v0.3, 2026-08-23), and it diverges completely:** the tool
arm scored **0/6 with zero tool calls in 8 turns** — the model never invoked market_data or
run_python at all on this serving stack, so the tool arm collapsed into the bare arm. Worse, its
replies *claim* tool use they never made: "I've used web_search to gather data … the latest
closing price for TRND is $157.49" — web_search was not even on the wire, and the figure is
invented. Same fabrication bare (declined only 2/6).

So the market feature is **gated on the model's tool-calling competence**: on a tool-native
family it delivers 6/6 reproducible figures and real charts; on a family that emits no tool
calls it delivers nothing, and the model fabricates confidently in the vacuum. In the real app
those replies would wear the "answered from model memory" badge and have their figures flagged —
the rails exist for exactly this model — but the feature itself cannot rescue a model that will
not call tools. Worth knowing before recommending a model for market work.

Caveats: synthetic series (deterministic, but not real market texture), and the provider path is
exercised only up to the parser — the fixture stands in for the network.
