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

**Code Mode, per slot, default off.** A slot set to *code* or *both* under Settings → Models
gets `run_code`: a Python program in the sandbox that calls the app's other tools as coroutines
through a generated `tools` module — search, then read the best page, then compute over what it
says, in one program. Every call the program makes is a real tool call: the slot's allowlist
minus the sandbox's own tools, the same per-turn budget the loop charges, the same execution
path, an audit line prefixed `[code mode]`, filed under the program's block. The sandbox gains
no network of its own; the check suite proves a bridged program still cannot reach loopback.
The module is a pure function of the tool table, byte-identical for an unchanged set. The
measurement below decides the default.

**Persona and rules.** A slot's system prompt is its persona; *standing rules* under Settings →
Models are how it operates, appended after the persona on every turn and before a project's
instructions, and disclosed under the reply. Reviewers and critics see the persona only.

**Skills.** A folder you install under Settings → Skills: `skill.json` with a decision-rule
description and trigger phrases, an optional method file the model is handed when a phrase
matches — in place of the built-in playbook for that turn, disclosed as *🧩 Skill: name* — and
optionally a library pack, an MCP server spec (saved switched off, under the same confirmation
words and approval modes as a server you added by hand) and Python helper files staged into the
sandbox by name. Installed from a folder only, through a confirmation that lists everything the
folder carries; the source is copied, never referenced again. No registry, no URL install, no
update channel: OpenClaw's registry is where its exfiltrating skill came from, and a folder on
your disk read by an installer that shows you what it holds is the whole supply chain here.
`docs/skill-format.md` is the format. The built-in playbooks stay as they are — a skill is the
user's own method, and the library suite's numbers are untouched because nothing bundled
changed.

## Measured

**Steering.** The multi-turn suite with a steer queued at every second turn's first round
boundary — a constraint the reply must show — on qwen3.8-9b:

| steered turns | delivered at a boundary | honoured | still answered |
| --- | --- | --- | --- |
| 10 | 10/10 | 9/10 | 9/10 |

The suite's own numbers did not move. The full account is in `docs/evals.md`.

**Code Mode.** The fact-ledger fixtures with a `code` arm: no app-run search, one tool, the
model's program does the searching through the bridge.

| arm | answered | searches per ask | programs per ask | s/ask |
| --- | --- | --- | --- | --- |
| native | 16/20 | 1.0 | — | 19–25 |
| code | 16/20 | 1.4 | 1.6 | 51–60 |

The same sixteen answered and the same four failed; every code case ran a program that called
the tools; it took 2.7 times as long. A null result on the score, at a cost, so the default is
native — the strategy's prior, measured. The mode ships for the case this suite does not
contain: several tools whose results feed each other.

## Measured, and not built

**Spill.** The strategy scheduled a mechanism for oversized tool results: above a threshold,
the wire gets head, tail and a locator, and a `read_spill` tool fetches ranges. Before
building it the record was read: across the 121 tool results in the 23 conversations saved on
this machine — 82 searches, 9 fetched pages, 3 research briefs, 3 Python runs — the largest
was 6,387 characters, and none reached the 8,000-character cap spill would replace. The cap
has never fired here. Spill answers a case the record does not contain, so it is not built;
the cap's silent drop of a tail stays a stated limitation.

## Not in this release

- **Bundled skills.** The built-in playbooks stay TypeScript rather than being repackaged as
  skills: their selection is by domain classifier, not trigger phrase, and repackaging would
  change the library suite's selection path, which the gate says must not move. A skill is the
  user's own method.
- **Code Mode as a default**, per the measurement above.
- **Spill**, closed by evidence above.

## Upgrade notes

- The audit log gains one entry kind, `user_steer`. Logs written by earlier versions verify
  unchanged; a v2.6 build reading a v2.7 log skips the new kind.
- The tool table gains `run_code`. It is on under Settings → Tools like the other Workbench
  tools but rides the wire only for a slot set to *code* or *both*; a native slot never sees it,
  and the tool-choice eval grades the native toolbox.
- Settings gains a *Skills* tab. Skills live under `skills/` beside your settings; a skill's
  pack is a pack, and its server is a server under Settings → MCP named `skill-<id>`.
