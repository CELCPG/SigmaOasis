# Sigma Oasis v1.9.1 — think harder, on the models where it works

Sigma Oasis has offered a **think harder** button since v1.6: draft an answer, review it, revise.
Three suites had measured it and found nothing. This release explains why, and — for the first
time — measures a case where it plainly works, so the button can tell you which of those two you
are about to get before you press it. Pinned by 1,369 node checks.

## The answer depends entirely on which model you loaded

The earlier nulls were asking a model that already deliberates internally whether it would like to
deliberate again. Measured on three models across two classes, 14 multi-step reasoning problems
each, no tools — draft versus the same draft after one review pass:

| model | draft correct | after review | review **fixed** | review **broke** | cost |
| --- | --- | --- | --- | --- | --- |
| qwen3.8-9b · reasons internally | 14/14 | 14/14 | 0 | 0/14 | 1.7x |
| gemma-4-12b-qat · reasons internally | 10/10 completed | 10/10 | 0 | 0/10 | 1.7x |
| **mistral-7b-instruct · does not** | 6/42 · 14% | **15/42 · 36%** | **9/36** | **0/6** | 4.8x |

On a model that thinks before it answers, the internal deliberation *is* the think-harder pass, so
an external one has nothing to add — two families agree, and no revision has ever broken a correct
answer. On a model that does not, one review pass **more than doubled correctness and broke none
of the answers that were already right**. The mistral run is three passes, identical in all three
with zero flaky cases, because a 3-of-12 single-pass result is exactly the size this project has
repeatedly caught being noise.

**So the button now says what it will do for the model you have loaded** — no change expected at
~1.7x, or about a quarter of wrong answers fixed at ~5x — instead of staying silent on the branch
where the feature works. On a model it does not recognise it says nothing at all: the classifier is
a name heuristic, and an unknown name is not evidence.

Two qualifications the same numbers show, kept in the notes rather than rounded off: the reviewer
revises 39 of 42 drafts rather than detecting errors — it rewrites by default and happens to help a
quarter of the time — and 4.8x is a fixed review cost sitting on top of a 3-second draft, about 16
seconds against 3 in absolute terms.

## A research run no longer dies quietly when planning fails

A real chain, found by instrumenting a failed run. The planner fails on a reasoning model → the
fallback re-uses your raw question as the search query → the privacy filter correctly refuses to
send a first-person sentence to a search engine → and the error blamed the search provider for a
search that was never sent. Every link behaved as designed and the result was a dead end with a
misleading explanation.

Now the fallback derives keywords instead of sending your sentence verbatim, and when nothing
survives the filter the run says so in those terms: **"No search was sent — the query was refused
by the privacy filter."** A round that surfaces no new sources ends the loop and writes the brief
from what it has.

## Runaway thinking is reported as itself

A 12B reasoning model handed the four hardest problems in the suite spent **1497 of 1500 tokens
thinking and returned an empty answer**. Uncapped, it ran until the connection dropped and surfaced
as `fetch failed` — a network error for something that was never a network problem. Empty answers
now name the cause and the token split, are not retried (asking again at temperature 0 spends the
same minutes to fail the same way), and generation is capped so a runaway cannot masquerade as a
transport fault.

That cap took two attempts and the first one is in the notes too: 4000 tokens, chosen against the
model's context window, changed nothing — because the binding limit is the transport, not the
context.

## Also

- The thin-sources research regime is now measurable, and was measured: still null, with the reason
  identified in the synthesis prompt rather than left as a shrug.
- The eval harness probes the model server for liveness before a long run, so an unloaded model
  fails in a second instead of after several minutes.

Every measurement above, including the nulls and the failed first attempt at the cap, is in
[`docs/evals.md`](https://github.com/CELCPG/SigmaOasis/blob/v1.9.1/docs/evals.md).

## Upgrade notes

Auto-update from v1.9.0 or earlier. Nothing changes by default: think harder remains opt-in per
message, it just now describes what it was measured to do on your model. No settings changed.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.9.0...v1.9.1
