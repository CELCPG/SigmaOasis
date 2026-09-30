# Mid-turn steering

Part of the [evals index](../evals.md).

## Mid-turn steering (v2.7)

`LMSTUDIO_EVAL=1 EVAL_SUITES=multiturn EVAL_STEER=1 npm run eval:answers -- <model>` runs the
multi-turn suite as it is — five datasets, three turns each, session and stateless arms — with
one change: at the second turn of every case a steer waits for the loop's first round boundary,
through the same hook the app's composer feeds, and says *end your reply with a final line that
says exactly STEER ACK*. A constraint no fixture needs and every reply can show, so the check is
a regex. Three numbers: **delivered** (the turn reached a boundary at all — a turn answered in one
round never does), **honoured** (the reply obeyed it), and **still answered** (the steer did not
cost the turn its answer).

qwen3.8-9b, one pass (2026-09-03):

| steered turns | delivered at a boundary | honoured | still answered the question |
| --- | --- | --- | --- |
| 10 | **10/10** | **9/10** | 9/10 |

The mechanism is the app's: the message goes on the wire after the previous round's tool
results and before the model reads them, and the record — the bubble, the audit kind
`user_steer` with the round, the trace export — says where. The one miss is case 03's session
arm, which also missed its third, unsteered turn; the stateless arm of the same case honoured
the steer and answered. The suite's other numbers did not move: first turns 5/5 in both arms,
follow-ups 8/10 and 10/10, the session arm's re-reads 4/10 — the same picture v1.8 recorded.
