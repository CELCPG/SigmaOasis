# Sigma Oasis v2.7.0 — the loop opens up

v2.6 was about what the app keeps. This release is about the turn itself: what the reader
can do while one runs, what a model can do inside one, and what a slot is made of. As
before, every item was measured where a model is involved and the measurement decides the
default; the privacy core is unchanged.

## What ships

**Mid-turn steering.** Type while a turn runs and press *Steer* (or Enter). The message goes
into the conversation at once, ahead of the reply being written and marked *queued*, and is
handed to the model at its next round — after the tool results it was reading, before it is
asked again — without stopping the work it has done. The bubble then says where it landed
(*steered in mid-turn, before round 3*), the audit log carries it as its own kind at that
point, and the trace export shows it in the turn. A steer the turn ends before delivering
becomes the next turn on its own; nothing typed vanishes. Attachments and plan mode still wait
for the turn.

*(further sections — pending)*

## Measured

**Steering.** The multi-turn suite with a steer queued at every second turn's first round
boundary — a constraint the reply must show — on qwen3.8-9b:

| steered turns | delivered at a boundary | honoured | still answered |
| --- | --- | --- | --- |
| 10 | 10/10 | 9/10 | 9/10 |

The suite's own numbers did not move. The full account is in `docs/evals.md`.

*(Code Mode — pending)*

## Measured, and not built

**Spill.** The strategy scheduled a mechanism for oversized tool results: above a threshold,
the wire gets head, tail and a locator, and a `read_spill` tool fetches ranges. Before
building it the record was read: across the 121 tool results in the 23 conversations saved on
this machine — 82 searches, 9 fetched pages, 3 research briefs, 3 Python runs — the largest
was 6,387 characters, and none reached the 8,000-character cap spill would replace. The cap
has never fired here. Spill answers a case the record does not contain, so it is not built;
the cap's silent drop of a tail stays a stated limitation.

## Not in this release

*(pending)*

## Upgrade notes

- The audit log gains one entry kind, `user_steer`. Logs written by earlier versions verify
  unchanged; a v2.6 build reading a v2.7 log skips the new kind.
