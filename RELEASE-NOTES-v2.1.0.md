# Sigma Oasis v2.1.0 — the interface stops teleporting

v2.0.0 closed eight adversarial rounds on what the app shows. This release is about how it
moves. Every state change that used to happen between two frames — a reply loading in jolts, a
rail snapping shut, a modal vanishing, a tool block shoving the page down, a conversation row
relocating — now travels, and every claim below was verified by watching the style writes and
frame timings over CDP, not by eyeball. Pinned by 2,129 node cases plus the render, style,
contrast, markdown, workbench and transport check suites, all green.

## Streaming reads as a flow

Three causes of the jerky load, one fix each:

- **The tail is paced.** Tokens arrive in bursts — a slab of text, a silence, another slab —
  and publishing each burst whole made the reply load in visible jolts. A display cursor now
  glides toward the buffered content per animation frame, faster the further behind it is, so a
  burst smooths out over roughly a quarter second without ever trailing the stream by more than
  1,200 characters (a cache hit or reconnect jumps the backlog instead of replaying it as
  typewriter). The slice never splits a surrogate pair, so half an emoji never renders as �.
- **The view follows after paint.** Autoscroll used to fire on the token event, which measured
  layout *before* the new text painted — the view trailed the reply by one flush and visibly
  bounced. A frame loop now reads layout after paint and glides the residual distance, keeping
  the reply's base anchored above the composer. Measured against a live qwen3.8-9b stream: the
  bottom gap averaged **0.5px** across 2,279 streamed characters, worst case one line-height,
  reclaimed within frames.
- **The newest words fade toward full ink** instead of popping in.

Occluded windows keep the old chunk-flush deliberately: Chromium stops animation frames behind
another window exactly like it throttles timers, while network callbacks keep firing — so the
pacer detects stale frames, degrades to whole-chunk publishes, and resumes gliding by itself
when the window is visible again.

## Rails glide, the composer grows with its text

Both side rails swapped between two differently-sized elements, so collapsing one moved the
whole chat column in a single frame. Each rail is now one shell whose width transitions between
its two faces, with the open face pinned to its full width — the shell wipes across finished
text rather than re-wrapping it every frame. The composer set its height by hand in three
places (keystroke, prefill, submit-clear) and two of them snapped; one layout effect now drives
all three and glides between measured heights. Measured: **15 intermediate widths** per rail
collapse, zero frames over 24ms, worst frame 18ms.

## Modals arrive and leave

All four modals were `if (!open) return null`, which cannot animate out — by the time the state
says closed, the DOM is already gone. They now stay mounted one exit's worth of time longer:
backdrop fades, panel rises in, then reverses out. A leaving overlay stops taking clicks — it
is on screen for another 150ms, and one that swallowed them would read as a frozen app. The
project editor renders its exit from held state, because its content derives from the very
state that closing it clears. Measured: 13 opacity and 15 transform steps in, 10 steps out to
fully transparent, no overlay left behind, and the dialog keeps its accessible label for every
frame of its exit.

## Disclosures open to their own height

Every disclosure in a message — tool-call arguments, a reasoning trace, a second opinion, a
claim check, a code run, a plan step — was either absent or full height, with everything below
jumping by that height in one frame. One Disclosure component now sizes the row in `fr`, so it
animates to the content's own height with nothing measuring anything. Tool and code blocks
landing mid-reply grow into place on the same mechanism. The body still mounts lazily, which is
not only about weight: a collapsed body left in the DOM keeps its buttons in the tab order, and
keyboard focus would walk into a section nobody can see. Measured on a real reasoning trace: 13
height steps out to 270px opening, 10 back to zero closing, nothing clipped.

## Conversation rows travel to their new places

The rail sorts by last activity, so answering in an older chat moved it to the top and shoved
every row above it down a slot between two frames — nothing about that read as movement. The
list now measures where each row landed, puts it back with a transform, and releases it, so the
sort resolves as motion you can follow. Watched live: the promoted row inverted by 118px, three
rows by −39px, all four released over 260ms and settling at zero. Project groups fold through
the same Disclosure as the rest of the app, and new rows fade in instead of blinking into the
list.

## Reduced motion is honored everywhere

Every mechanism above checks `prefers-reduced-motion` at the OS level: the stream publishes
whole chunks, modals and disclosures mount and unmount immediately, rows do not travel. Nothing
to configure — the app reads the system setting.

## What Chromium taught us, recorded so it stays learned

Three silent failure modes are documented in the code where they were found, because each
looked correct and wasn't:

- `grid-template-rows` does not interpolate inside `@keyframes` — 0fr→1fr snaps to the end
  value on the first frame — while the identical *transition* interpolates in thirteen. Every
  growing block is therefore rendered closed and opened on the next frame.
- Reusing an entry animation with `animation-direction: reverse` for the exit fails silently:
  an animation whose name does not change is never restarted, so the leaving panel re-reads the
  finished entry at its reversed end — invisible from its first frame. Exits get their own
  keyframes.
- A fill-mode of `both` on an entrance animation keeps its last keyframe applied forever, and
  animation declarations outrank inline style — which would have silently overridden the row
  transforms on every row that had ever been mounted. The entrance uses `backwards`, and that
  choice is load-bearing.

## Also

- The head-to-head task set was rewritten to be build-neutral: task rationales and critic
  questions now describe what a task makes happen, never what a build does with it, and a new
  suite test enforces that mechanically — no glyphs, class names, source paths, or measured
  constants in anything a blind critic can see, and the critic view is pinned to be exactly the
  projection it claims. Through round 8, four tasks quoted constants that could de-blind a pair;
  that history is recorded in `docs/evals.md`, not quietly fixed.
- `chromeContrastCheck` scraped a rail's className as a fixed string; it now reads the template
  literal and restores the open width.

## Caveats, which are real

- The frame timings and step counts were measured on one machine (Apple silicon, macOS 26) —
  they are evidence the animations interpolate, not a performance guarantee for every device.
- Behind another window the stream intentionally jumps in chunks; smoothness costs animation
  frames, and occluded windows do not get any.
- The follow-scroll glide is functional motion (it tracks arriving content); reduced-motion
  users get whole-chunk publishes, which the glide treats as jumps and snaps instead.

## Upgrade notes

Auto-update from v2.0.0. Nothing changed meaning: no new settings, no migrations, and no
behavioural change to any tool, check, or record — this release is entirely about the frames
between two states the app was already in. Reduced-motion users opt out of all of it
automatically via the OS preference.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v2.0.0...v2.1.0
