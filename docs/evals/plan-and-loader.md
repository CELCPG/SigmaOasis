# Plan and loader defects (v3.0.1)

Part of the [evals index](../evals.md).

## Two things a plan claimed about a process that had died (v3.0.1)

Found and fixed on 2026-08-28, the day after round 8, against the tree that shipped as 2.0.0 —
and not merged until after 3.0.0, which is why it sits here and not beside round 8. Before it
landed, each of the three defects below was re-read against 2.8.0's source, and again against
3.0.0's, and all three were still there: `resolvePlan` still returned silently on a missing resolver, no load path settled a
plan with no outcome, and `load()` still ended in `setConversations` from the file list, in an
effect keyed on `baseUrl`. The fix was carried onto the plan block as rounds 9–14 left it — one
live status region, a census in place of the fraction on a dead plan, status ink through tokens
— and where that changed a figure or a sentence here, the 2.8.0 one is given.

### PT4: the plan that came back from disk still claiming an executor

Round 8's PT2 settled that a plan which has ended must say so instead of still asking to be
approved. It settled the four endings the executor is present for. It could not settle what
happens when the executor is not present at all, and nothing looked there.

Everything that makes a plan live is a *process* — the approval resolver in `planApprovals`, the
step loop, the abort signal, all `hooks/planMode.ts` — and none of it is on disk. Reaching disk
mid-flight takes no special path: `renameConversation` is not gated on `streaming`, so renaming
the chat while a plan is open is enough. What comes back is a plan object with no `outcome`, and
a plan with no outcome is making a claim about a process. There are exactly two such claims, and
**both were false and both rendered**.

#### The inert half: waiting to be approved

`approved:false`, no outcome, every step `pending` — exactly the shape `awaitingApproval` looks
for. **Before**:

```
📋 Plan — 0/3 steps done                                awaiting approval
○ 1. Work out the water
     1 gal × 3 people × 14 days.
     Tools — none planned; this step reasons only
○ 2. Check the reference library
     Tools — may use: library_search, web_search
○ 3. Compile the checklist
     Tools — may use: library_search

  [ ▶ Run this plan ]  [ Cancel ]     Nothing has run yet. Tools each step may use …
```

Both buttons are live and both are inert. `resolvePlan` calls `planApprovals.get(messageId)`,
gets `undefined`, and returns — no branch, no notice, no state change. Every press is answered
with nothing at all.

#### The animated half: running

`approved:true`, no outcome, one step still marked `running`. **Before**:

```
📋 Plan — 1/4 steps done                                         running
✓ 1. Work out the water
◌ 2. Check the reference library          ← pulsing, in the accent ink
     Tools — may use: library_search, web_search
○ 3. Compile the checklist
○ 4. Write it up
```

This is the worse of the two and it was the one not reported. The dead buttons at least require
a press before they lie; `animate-pulse` in `--accent-ink` asserts, continuously and without
being touched, that work is happening *right now* in a process that stopped existing — and rows
3 and 4 carry the same `○` as a step genuinely waiting its turn. Nothing ever resolves it,
because the thing that would have resolved it is what died.

#### After, both

```
📋 Plan — 3 steps: 3 never ran                  abandoned when the app quit
– 1. Work out the water                                          never ran
     1 gal × 3 people × 14 days.
– 2. Check the reference library                                 never ran
– 3. Compile the checklist                                       never ran

  The app quit while this plan was waiting to be approved, so nothing ran and
  nothing here can start it. Send the request again for a fresh plan.
```

```
📋 Plan — 4 steps: 1 done, 1 cut off, 2 never ran   abandoned when the app quit
✓ 1. Work out the water
⊘ 2. Check the reference library                              cut off here
     Tools — may use: library_search, web_search
– 3. Compile the checklist                                       never ran
– 4. Write it up                                                 never ran

  The app quit while this plan was running, so it ended where the rows say and
  nothing here can pick it up. Send the request again for a fresh plan.
```

The header is v2.4's census, not the fraction the branch drew: a dead plan says what became of
every step, and the census walks `STATUS_LABEL`, so the new status is counted by construction.
Its label is `Cut off` — the word the glyph's `role="img"` announces and the word the census
uses — and it sits before `Never ran` in the table so the header tells the story in order.

**One predicate, not two special cases.** The sweep keys on `claimsALiveProcess` — *this plan has
no outcome* — rather than on the awaiting-approval shape it was first written against. Written
the narrow way it passes every test about the buttons and leaves the pulsing row exactly as it
was; that is round 5's recurring species (*a check whose vocabulary is narrower than the class it
guards*) and a mutation asserts it: swapping the predicate back to `awaitingApproval` fails two
named cases and nothing else.

**Why two new words, and not four existing ones.**

| | belongs to | why it could not be reused |
| --- | --- | --- |
| outcome `cancelled` | the reader | Cancel at the gate. Crediting them with a decision the app took away is the same misattribution as the dead button, moved into the badge where it is harder to notice. |
| outcome `stopped` | the reader | Stop, at the gate or on a running plan — *stopped by you*, in as many words. |
| step `stopped` | the reader | the same word one level down, and the same objection. |
| step `failed` | the step | it did not fail; a process ended around it. Drawn in failure red, it blames the work for the quit. |
| step `skipped` | the plan | reads *never ran*, which is the one thing this step did do. |

So `abandoned` at the plan level and `interrupted` at the step level. `abandoned` names the agent
and claims no extent — the rows carry that, which is what lets one badge serve both halves.
`interrupted` renders `⊘`: third in the circle family, after the empty `○` and the in-flight `◌`,
so it reads as the end of the story the pulse was telling.

**Measured, on the block's own composited background.** Badge and glyph share one new status ink
token, `--text-info` (`#1d4ed8` light, `#60a5fa` dark), the way the other outcomes and their
glyphs took `--text-ok|warn|danger` in round 9: **5.71:1 light / 7.89:1 dark**, the badge
semibold — the heaviest text in the block and above every line of step copy (`5.05:1 / 6.26:1`),
which is the bar the other four outcomes are held to. Worst case over the eight surfaces those
three were measured on: **5.38:1 / 6.05:1**. The note is `--text-secondary`, **8.60:1 /
10.31:1**, above the step copy and below the badge in weight. The glyph is not a single raw step
because the one it was first written as, `blue-600`, measures **4.40:1 light and 3.88:1 dark**: a
glyph carrying the whole meaning of its row, missing AA on both canvases at once. Caught by the
test, not by eye. (On the branch this was written on it became a raw pair — `blue-900`/`blue-300`
for the badge, `blue-700`/`blue-400` for the glyph. By 2.8.0 status prose takes no raw palette
step at any darkness, so the pair became a token, and the glyph's values are the badge's too.)

**Where the fix goes.** At conversation load, not at render. A render-time check against a mutable
module registry is not a thing React re-renders on, and it leaves the persisted plan lying about
itself for the next reader; `abandonOrphanedPlans` settles the plan object the way `endPlan`
settles the other four, so the block stays a pure function of what it is handed. It is
deliberately not written back to disk on the spot — the sweep is a pure function of what is on
disk, so it re-derives identically on every load and the settled plan reaches the file with the
conversation's next ordinary save. No startup write for a plan the reader may never open. Nor is
it written into the session audit, which v2.5 taught to carry plan steps: the log of the session
that ran the plan ends where that process ended, `planLedgersFromAudit` already returns that plan
open, and that is the record's own true account. An `abandoned` line written at the next launch
would be the app recording, as if witnessed, an ending it only inferred.

**The one thing that makes it a sweep and not a rename.** Through 2.8.0 `load()` re-ran whenever
the base URL changed, which the reader could do with the buttons on screen or a step mid-flight.
CL1 below removes that trigger; the next caller of `load()` can bring it back. A sweep with no
liveness check would abandon a plan whose executor is right there — the same defect, mirrored, a
true statement replaced by a false one. `livePlans` is the executor's own record: added the
instant the plan message exists, released in a `finally` that covers every path out of
`runPlanTurn`, including the ones that leave without recording an outcome. A leak there is silent
and one-way — the id stays "live" forever and the orphan it names is the one plan the sweep would
never settle — so the release is asserted at the source, and asserted to be the only one.

| Case | What is on disk | Live | What the block does |
| --- | --- | --- | --- |
| **TP** — inert half | `approved:false`, no outcome, 3 × `pending` | — | `abandoned when the app quit`; 3 × `never ran`; **no** gate control; the gate note |
| **TP** — animated half | `approved:true`, no outcome, `done` + `running` | — | same badge; `⊘ cut off here`; the rest `never ran`; no `animate-pulse` anywhere; the mid-run note |
| **TP** — approved, nothing started | `approved:true`, all `pending` | — | all `never ran`, and still the mid-run note: the reader had already decided |
| **TN** — the gate is genuinely open | the inert half, byte for byte | **yes** | untouched; still `▶ Run this plan` / `Cancel`, **2** enabled controls |
| **TN** — a step is genuinely running | the animated half, byte for byte | **yes** | untouched; still `running`, still pulsing |
| **TN** — already ended | any of `completed` / `cancelled` / `stopped` / `failed` | — | untouched; the ending it had, and its own object identity back |
| **TN** — no plan at all | an ordinary user message | — | the same object, handed straight back |
| **TN** — a second load | the plan already settled | — | nothing further; the same conversation object |
| **TN** — mixed conversation | one finished plan, one orphan | — | only the orphan moves; the finished plan keeps its identity |
| **TN** — a step that never reached its forecast | `interrupted`, forecast `read_note` | — | not faulted for the unrun forecast; its own status already says why |

**Who is allowed to write which ending**, guarded at the source, because the failure would
otherwise be silent — the badge and the glyph would still render, just about the wrong agent:

- the literal `'abandoned'` appears, comments stripped, in exactly **one** place in
  `planState.ts`, and `status: 'interrupted'` in exactly one;
- `planMode.ts` — the executor — contains neither word, and still forwards the reader's two as the
  gate's `PlanDecision`: `'stopped'` from its own abort listener, `'cancelled'` from the Cancel
  button's resolver;
- `abandonPlan`/`abandonOrphanedPlans`, comments stripped, contain neither `'cancelled'` nor
  `'stopped'`;
- `runPlanTurn` registers in `livePlans` before it opens the gate, and releases exactly once, in a
  `finally`;
- `load()` calls the sweep, calls it *before* `setConversations`, and passes it `livePlans`.

The guards are checked by mutation rather than by reading, and were checked again after the port
rather than carried over. Thirteen deliberate breaks — load stops calling the sweep; the liveness
argument is dropped; the sweep is made a no-op; the sweep spends `'cancelled'`; the executor
spends `'abandoned'`; the predicate narrows back to `awaitingApproval`; `abandonPlan` leaves the
running step alone; it marks it `'stopped'` instead; the executor leaks its registration; the note
stops discriminating; the glyph takes the reader's Stop amber; the row is labelled `Stopped by
you`; the badge borrows the neutral ink of `cancelled` — each caught, by 1–29 named tests,
and never by the same set twice. The last was caught by nothing on the first run: `OUTCOME_CLASS`
has said since v1.12.3 that hue separates the outcomes, and no test measured it. It does now, in
both themes, and that is the test that catches it.

### The gap the branch recorded, closed before it landed

Adding one measured glyph to the plan block meant measuring the five already there, and on the
2.0.0 tree three of them missed AA on the light canvas:

| glyph | light, 2.0.0 | dark, 2.0.0 | 2.8.0 |
| --- | --- | --- | --- |
| `✓` done — `green-600` / `green-400` | **2.81:1** | 11.52:1 | `--text-ok` 5.59:1 / 10.44:1 |
| `✗` failed — `red-500` (no dark override) | **3.21:1** | 5.33:1 | `--text-danger` 5.46:1 / 8.63:1 |
| `■` stopped — `amber-600` / `amber-500` | **2.72:1** | 9.34:1 | `--text-warn` 5.33:1 / 9.67:1 |

Each was a single value where the ink that works on one canvas cannot work on the other — the
mechanism `--text-*` exists to solve, and the same one that put `blue-600` at 4.40:1/3.88:1
before the test caught it. The branch recorded it rather than retinting every step status inside
a fix about process liveness. Round 9's status inks closed it in the meantime, which is why the
new status follows them onto a token instead of staying the one raw pair in the block.

### What this does not cover

- **The measured shapes are fixtures, not recorded runs.** Both `before` blocks are rendered from
  the persisted shape, and the persistence routes are read off the source rather than reproduced
  by quitting the app mid-flight.
- **A conversation saved mid-flight is still saved mid-flight.** The sweep settles what comes
  back; it does not stop the half-written plan reaching disk in the first place, and does not try
  to.
- ~~**`load()` still replaces the store wholesale.**~~ **Fixed — see CL1 below.** Tracking it
  down found a larger defect than the one PT4 left: the same replacement deletes every open
  ephemeral conversation, with no live turn involved at all.
- **The real-tree check lost its two live rows.** `test/planAccessibilityCheck.ts` (v1.18's)
  seeds its plans on disk, so its awaiting and running fixtures now come back abandoned. It was
  turned to measure that instead — the shipped build's load path, not a unit test of it: no run
  control on either, no row still announced `Queued` or `Running`, `Cut off` distinct from
  `Stopped by you` and `Failed`. Run against the built app: 175 checks pass; with the load sweep
  switched off in the same build, 15 fail, among them `["Run this plan","Cancel"]` back in the
  tree over a resolver that does not exist. What it can no longer read from the tree is
  `Queued`, `Running`, the two live header words, a live plan's fraction and the approval
  footer's control names; those are pinned only in markup (`test/planBlock.test.ts`) until
  something drives a real plan turn.
- **No blind comparison.** This is a defect found and fixed between rounds, not a scored one.

## CL1: the loader that deleted what disk could not return (v3.0.1)

PT4 left one line open: *`load()` still replaces the store wholesale, and a base-URL change
during a live turn discards that turn's in-memory progress.* Following it found something larger
than the turn.

`load()` ended in `setConversations(list)` — the store's entire array replaced by whatever
`listConversations()` returned — and it was in an effect keyed on `settings.baseUrl`, so it ran
again every time the reader edited the LM Studio address. Conversations are local files and have
nothing to do with the server address; the two were in one effect because both need settings to
have loaded, not because either depends on the URL. That coupling is the whole reason "the store
becomes the file list" was a thing that could happen *mid-session*.

Three things the store can hold that a list of files structurally cannot:

| | what memory has | what the replacement did |
| --- | --- | --- |
| **An ephemeral conversation** | the entire chat | deleted it |
| **A turn in progress** | the assistant message being streamed into | deleted it, and orphaned the stream |
| **A conversation just created** | an empty chat, upserted and not yet saved | deleted it, leaving `activeConversationId` pointing at nothing |

**The ephemeral row is the one that matters most, and it needs no live turn.** "Never written to
disk" is the entire feature, and `useConversations` says in as many words that the refusal is
implemented in two layers *"because the no-trace promise should survive a renderer regression"*.
Both layers work. Then the loader deletes the conversation from RAM, on a change of server
address, and the promise is kept perfectly right up to the point where the chat disappears.

**The turn row is the quieter one.** The executor holds `assistantMsg.id` in a closure and patches
by id. After the replacement, `patchMessage`'s `.map()` matches nothing — no throw, no branch —
so the stream keeps arriving, every token is written into an object nothing renders, and the
turn's own `finally` then saves the reloaded conversation back over the file.

### The rule, and why it needs no timestamps

**Memory is never behind disk.** The renderer is the only writer of these files; main persists
only what the renderer hands it; and every call site pairs its `saveConversation` with an
`upsertConversation` of the same object (`turnHelpers`, `useConversations`, `useProjects`,
`useLMStudio` — which reads `final` back out of the store before writing it — and, since 2.x,
`App.tsx`'s scheduled-job digest, which does the same). Re-read against 2.8.0, where there are
eleven such sites and main still writes no conversation file of its own. So for any
conversation the store holds, its copy equals the file or is ahead of it. Preferring memory is
never a loss.

That makes the reconciliation three lines and no comparison logic: memory's copy where both have
it, disk's where only disk has it, and memory's kept where disk cannot have it at all.

### The boundary two rules were sharing, and getting wrong in both directions

The first version of this fix passed nine tests and was wrong, and the tenth test — written to
pin the history limit, not to catch anything — found it. The cap and the merge decide the same
boundary, and each is wrong alone:

- **Cap the merged list** and an ephemeral chat can push a saved conversation over the edge,
  deleting a *file* on behalf of a conversation that has none. That is this defect pointed
  outward.
- **Merge against the capped list** and a conversation the cap just dropped looks exactly like
  one disk never had — so it is added back from memory while its file is deleted, and the history
  limit quietly stops being a limit for the rest of the session.

Both are silent. `planLoad` decides them together: membership from the **whole** disk list,
content from the capped one, returning `{ keep, prune }` so the caller cannot get the order
wrong. *"Disk cannot hold this"* and *"disk was told to stop holding this"* are different facts,
and only the first earns a place back in the store. Pinned by a mutation in each direction.

The `historyLimit` guard came along with it, out of the hook and into a tested function. It was
never covered — `useConversations.ts` is not on the test build's file list — and it is the number
that decides what gets **deleted**: a `0`, or the `NaN` a half-typed settings field produces,
would prune the entire history off disk. Seven values now assert the fallback.

| Case | On disk | In the store | Result |
| --- | --- | --- | --- |
| **TP** — ephemeral chat | `c1` | `c1`, `eph` (ephemeral) | both kept; `eph` is the same object, not a rebuild; `prune` empty |
| **TP** — turn in progress | `c1` with 0 messages | `c1` with the streamed message | memory's `c1`, message intact |
| **TP** — chat just created | `c1` | `c1`, `new` (unsaved) | both kept |
| **TP** — a cap that would delete a file for a fileless chat | `c1`, `c2`, limit 2 | `eph` | all three kept, **nothing** pruned |
| **TN** — startup | `c1`, `c2` | *(empty)* | exactly the file list, same objects |
| **TN** — disk-only conversation | `c1` | *(empty)* | disk's object, untouched |
| **TN** — past the cap | `c1`, `c2`, `c3`, limit 2 | `c1`, `c3` | `c3` dropped from the store *and* pruned — memory does not rescue it |
| **TN** — nothing on disk | *(empty)* | `eph` | `eph` kept, nothing pruned |
| **TN** — inputs | either | either | neither array sorted or mutated in place |

Seven mutations, each caught, and each caught again after the port: the memory-only branch
removed (the original defect — 5 tests); disk winning over memory for a shared conversation;
membership read off the capped list; the cap applied to the merged list; `historyLimit` no longer
rejecting a `0`; `load` re-keyed on `baseUrl`; `load` slicing the list itself beside `planLoad`.

### What this does not cover

- **The reconciliation is now unreachable in practice, on purpose.** With `load()` keyed on
  "settings have arrived" it runs once, against an empty store, where the merge is the identity.
  It is kept and tested because `setConversations`-from-disk is the loaded gun, not the trigger:
  the next caller of `load()` — a refresh button, a settings import — inherits a safe contract
  rather than this defect.
- **Two rules still both have to hold for the merge to be right.** "Memory is never behind disk"
  is an invariant of every call site, checked by reading them, not by a guard. A future writer
  that saves a conversation without upserting it would break the merge silently.
- **`activeConversationId` can still dangle.** A conversation past the cap is dropped from the
  store whether or not it is the active one. Older than this change and untouched by it.
- **No blind comparison.** A defect found while writing up another one.
