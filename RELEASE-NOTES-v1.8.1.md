# Sigma Oasis v1.8.1 — the app remembers

A small model's fourth weakness, after thin knowledge, weak arithmetic and shallow procedure, is
that it loses the thread of a long conversation: it re-remembers a figure from ten turns ago
approximately and states it confidently. This release gives the app its own memory of what a
conversation has established — mechanical, exact, never paraphrased — and measures it in the one
regime where memory actually matters. It also closes out the v1.8 sessions story with a measured
improvement to how the model uses them. Pinned by 1,345 node checks (28 new since v1.8.0).

## The conversation ledger

- **What it is.** Every turn, the app rebuilds a running record of what this conversation has
  *established* — figures a tool computed (`total revenue: 139306.12 — run_python, turn 1`), files
  attached, Python session variables still defined, and constraints you stated in your own words
  (*"My budget is $2,000"*, *"I have a nut allergy"*). No model call; the exact strings from tool
  results and your messages, never reformatted.
- **What it refuses to record.** Anything an assistant said. A reply's figures already pass
  through the grounding ladder; repeating one into the ledger would launder an unverified number
  into a "fact". The ledger is the app's memory of the conversation, not the model's.
- **How it reaches the model.** From the fourth turn on, only when it has something to say, as
  turn notes: *use these exact values when a question refers back; do not restate them from
  memory; if a figure is not here, compute it.* Disclosed under the reply — *📒 Ledger: 2 computed
  facts, 1 file, 1 constraint from 7 turns.* Settings → Models → Conversation ledger, on by default.
- **Why not the summary that already existed?** That one is written by a model, only when history
  is dropped, and it paraphrases — which is exactly the failure. The ledger keeps `139306.12`.

## Measured, in the regime that matters

A new eval suite (`EVAL_SUITES=ledger`) establishes a fact on turn 1, buries it, then asks for it
back without restating it — ledger arm vs. bare, identical otherwise. The first suite was a **null
result** — five turns is short enough that the bare model just reads the turn-1 tool result out
of history — and it is recorded as such. So a long-regime variant compacts the establishing turn
out of the wire history using the **app's own history planner** and asserts it is gone, exactly as
a real long conversation loses it. Against a 9B, three passes:

| establishing turn compacted out | recall | stability |
| --- | --- | --- |
| **ledger** | **15/15 · 100%** | 0 flaky |
| bare | 3/15 · 20% | 2 flaky |

Bare's three successes are all recomputation against a still-attached CSV, not memory. Where
nothing is recomputable — a stated budget and deadline — bare said *"I don't have any record of a
project with a budget or deadline in this conversation"* three passes out of three; the ledger arm
said *"You told me at the start that your budget is $2,000 and the deadline is Friday."*

The measurement also caught a real gap on the way: a 9B answered a total straight off
`analyze_file`'s profile without ever running Python, and the ledger — which read only
`run_python` — recorded nothing. The model then told the truth about its own empty ledger rather
than inventing, which is the design working; the extractor was too narrow, and profile statistics
are now facts. [`docs/evals.md`](https://github.com/CELCPG/SigmaOasis/blob/v1.8.1/docs/evals.md)
has the full sequence, including what did not work first.

## Sessions: the habit, measured and moved

v1.8.0 measured that a 9B told variables persist still re-read the data file on 6 of 10
follow-ups. One step in the data-analysis playbook now says: *run_python keeps its variables —
build on the dataframe you already loaded; check the Session variables list before reading a file
again.* Two 3-pass runs, differing only in that step: session follow-up re-reads fell from
**100% to 67%** while the stateless control stayed at 100% in both. Narrowed, not closed — and
now a number future work is judged against.

## Also

- The eval harness **refuses to start unless the model answers a probe** — a 90-minute baseline
  once ran against a stopped LM Studio server and produced 0/0 across the board; it now fails in
  about a second with the fix named. Multi-pass headlines report the aggregate, not pass 1.

## Upgrade notes

Auto-update from v1.8.0 or earlier. One new setting, on by default (Settings → Models →
Conversation ledger). Nothing else changes.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.8.0...v1.8.1
