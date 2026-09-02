# Sigma Oasis v2.4.0 — the sound base

v2.3 changed the runtime and nothing else. This release changes nothing the reader can see
and a great deal of what the next releases stand on: the debt the strategy said gates the
capability work, paid down where it was measured to matter and left alone where it was
measured not to. Every change is gated by the same 2,574 node checks and nine Electron
suites, unchanged in count except where a new check was added.

## One streaming core

Two clients read LM Studio's `/chat/completions` stream — the main process for the app's own
completions (plans, summaries, deliberation) and the renderer for the chat — and they had
drifted: one split on blank lines and read the first `data:` line of each event, the other
read every `data:` line; one knew about tool calls, usage, `finish_reason` and error frames,
the other only text. `src/shared/sse.ts` is now the parser both use, and its contract is
written in one place: a frame is one `data:` line; `[DONE]` ends the stream and nothing after
it is read; tool-call arguments stay the raw string the server sent, joined fragment by
fragment and parsed only by the loop's repair and schema layers; a reply that hits its token
budget **drops the tool calls it was still writing** — running a call whose JSON the model
never finished is worse than running none, and the truncation is already reported — and
usage is kept whenever its final chunk arrives. Pinned by a new `sse` suite and the existing
parser tests, one of which changed its expectation to match the contract and says so.

## The grounding file is seventeen modules

`lib/toolGrounding.ts` had grown one section per bench round since v1.12 to 4,003 lines,
the largest file in the tree. Its seventeen section markers are now
`lib/groundingChecks/<section>.ts`, cut mechanically with the compiler assigning every
declaration to its section and resolving cross-references; the barrel re-exports all of it,
so no import site and no test changed. One cycle in the section graph was broken by moving
one function.

## The Settings modal is a frame and nine tabs

`SettingsModal.tsx` was 2,546 lines, one component holding twenty-three pieces of state and
nine tab bodies. Each tab body is now `components/settings/<Tab>Tab.tsx`, extracted
mechanically as a prop-drilled component: the compiler listed what each body referenced from
the modal's scope (five to fourteen names, `draft` and `update` on every tab), those became
the tab's props, and the three helpers the tabs share moved with them. No state, hook or
handler moved, so ordering and behaviour are unchanged; the modal is 468 lines and holds the
frame, the draft and the save. Gated by the three suites that boot the real Settings UI —
modal-focus, tab-traverse and plan-accessibility — plus typecheck.

## Bounded stores

Two stores had no bound at all. Each now has one, in the watchlist's house style: stated,
shown in its settings panel, and refused rather than silently trimmed where the data is the
user's.

- **The audit directory** wrote one file per launch, appended for the life of the launch,
  and never removed one; the Privacy panel read every file whole to count its lines, and
  nothing ever got smaller. It is now kept to the newest **40 launches and 200 MB**, oldest
  pruned first, once per launch before the first entry is written — so the session being
  written is never the one pruned and a log open in front of you cannot vanish. The panel
  states the bound and what this launch pruned, because the log's whole point is that
  nothing happens to it unseen.
- **Long-term memory** appended chunks forever into one JSON file rewritten whole on every
  save. It is now capped at **5,000 chunks** (on the order of 60 MB with 768-dimensional
  vectors). A save that would cross the cap is **refused with a message naming the cap and
  where to make room** — never trimmed: a memory is the user's, and an app that quietly
  forgot the oldest to make space would be doing what the feature exists to prevent. The
  Memory panel shows the count against the cap.

Both pinned by node tests; the caps are injectable so the tests need no 200 MB files.

## The library suite's noise floor, measured, and what it turned out to be

The strategy scheduled retiring three flaky failure shapes the August runs kept producing.
Measured first, three passes on qwen3.8-9b at temperature 0 with the suite as it stood:
**27, 27, 27 of 28 answered — no flaky case at all**, one stable failure. The shapes were a
different model class's; on this one the floor is zero. What the run found instead:

- **The scorer was flagging correct arithmetic.** Nine of 84 replies were marked as stating
  an unsupported measurement, and every one of the nine was the same two conversions in
  every pass — "90 °F (32 °C)" and "165 °F (74 °C)" — plus one genuine miss. The scorer
  matched numbers only; the app's own checker has accepted a conversion of a supported
  figure since v1.9.2. The scorer now applies the app's rule, pinned by tests, and the
  genuine one stays flagged: "20 feet" for a generator, which the pack states in a section
  the ranker never sent.
- **The one stable failure is a retrieval mechanism, not a model.** "How do I make flood
  water safe to drink" needs "a rolling boil for one minute". The pack says it twice. The
  EPA document says it in the second chunk of a long unheaded opening section, and the
  v1.7 rule that caps a section at one passage sends the first chunk; the preparedness
  document's dedicated "Boiling" section ranks below flood-specific passages even at depth
  ten, because the question never says *boil*. Recorded, with its cause, for the retrieval
  work that would fix it; not patched around here.
- **The instrument now runs the turn the way the app does.** The arm sent the lookup's
  passages and no tools, so a model that answered by *calling* reference_lookup — as prose
  the app's extractor reads, or natively — was scored on the call's text. The arm now offers
  the tool and executes it exactly as the handler does, scrubs the turn-notes echo before
  scoring as the app does, and records per case how the completion ended and how many calls
  the model made; the multi-pass report counts failing runs by shape. After-measurement:
  *(pending — see the commit record)*.

## Measured, and left alone

- **Startup is already flat in conversation count.** The strategy scheduled an index file
  and lazy loading. Measured first: the built app on synthetic profiles of 30-message
  conversations, launch to composer — 100 conversations 0.7 s, 1,000 conversations 0.5 s.
  Not built. Neither are sidecar image blobs: the largest real conversation on the bench
  machine, 228 KB with five inline images, re-serializes in milliseconds.
- **The follow-up re-read costs milliseconds, not seconds.** The multi-turn record shows
  four of five re-reading follow-ups doing it inside their single analysis call. The
  memoized read the strategy proposed would have saved the parse and none of the model's
  time. Closed with the evidence, not built.

## Not in this release, and why

- `useLMStudio.ts` stays at 1,457 lines. Its verification tail (grounding, code check, the
  revision gate — about three hundred lines) closes over the turn's locals and comes out
  only with a context object threaded through; that is v2.5 work, done the way the loop
  itself was extracted, with tests landing beside it.
- PDF parsing still runs on the main thread and the page renderer still opens a window per
  page. Both are specified and mechanical; neither was measured to hurt in this release's
  profile, and they were left for the release that measures them.

## Hygiene

Twenty-one agent worktrees removed and sixty-four merged branches deleted; four version
markers that named releases that never existed now say the release they shipped in; the
two unmerged branches (`claude/sharp-babbage-4991d6`, a real change about plans surviving a
restart that conflicts with main; `v1.4.0`, which predates its tag) are left for a person.

## Upgrade notes

Auto-update from v2.3.0. No new settings, no migrations. The one behavioural change is the
streaming contract above: a reply cut off at `max_tokens` mid tool call no longer attempts
the truncated call.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v2.3.0...v2.4.0
