# Roadmap: Sigma Oasis 4.7 — the evals finished, and the interface brought to its own guide

Written by Claude Code on 2026-11-20, after Colin's four answers to the review of 4.6.0
(`3d50909`): (1) the evals lead, with strong UI polish beside them; (2) adopt an icon library;
(3) tune the dark theme toward the glass spec; (4) move the root documents into `docs/`.
Work runs on `claude/fervent-fermi-nleick` behind a draft pull request. Nothing is tagged or
released from it.

## Why

4.6 left seven measurement items (*What is left (4.7)* in `ROADMAP-v4.6.md`). Two are code
(claims rule 4, `eval:diff` across unequal pass counts) and five need the B65 or the B60.

The review of 4.6.0's interface, on a build of `3d50909`, found the app has drifted from
`sigma_oasis_visual_style_guide.md`:

- **Two icon systems.** Settings draws line icons; the rest of the app uses 176 emoji and symbol
  glyphs across 34 components, which each platform renders with its own font.
- **Small type.** 110 uses of 9, 10 and 11 px text, densest in the right panel and plan blocks.
- **Native controls on glass.** Five raw `<select>`s (the project picker, the agent bar, the
  project modal).
- **Layout.** The window's minimum is 900 px with two side panels and 11 `sm:` breakpoints in the
  whole renderer. The front door's last card row sits behind the composer, and the Strategy control
  overflowed the right panel in a Linux capture.
- **Meaning.** A finished agent checklist is struck through and reads as cancelled; a reply shows
  six actions permanently.
- **The dark theme** reads flat against the guide's glass (depth, the top streak, the orbs).
- **The repository's root** holds 55 release notes, 10 roadmaps and 7 strategy files, and the
  README is 77 KB.
- **The screenshot harness had drifted** (L0, below), so none of the above could be seen without
  fixing it first.

## The goals

K is measurement and leads. L is the interface. M is engineering.

| goal | what | needs |
| --- | --- | --- |
| K1 | **Claims rule 4**, "a prediction is not a claim" (4.6's decision 6): the frame in `asserted()`, a labelled entry, a test, `CLAIMS_RULE` 4, the baselines and the replay fixture re-scored with every flip listed | code |
| K2 | **`eval:diff` across unequal pass counts** (4.6's decision 7): say so beside a false-claim WORSE whose count did not rise | code |
| K3 | **Re-rank's citing loss, finished**: C1 + C2's other two passes beside a same-day control; `4.6/rerank-cite` merges only if cited comes level | the B65 |
| K4 | **The 9B's B65 agent baseline**: `long-discount-rules` alone, pass 4, then the baseline from H1's two passes and J7's two | the B65 |
| K5 | **The `feature-top-words` runaway**: cases 5, 6, 7, 9 with a long deadline and a per-case stream capture | the B65 |
| K6 | **Gemma's repeat-penalty probe** (J6), and a newer llama.cpp for the peg-gemma4 HTTP 500 | Gemma's server |
| K7 | **The 35B through the connection, passes 3 and 4**, if it is to have its own baseline | the B60 |
| L0 | **The screenshot harness works again** on 4.x | code |
| L1 | **One icon set.** `lucide-react` (ISC, bundled, no network) replaces the emoji and symbol glyphs; Settings' hand-drawn icons move to it too, so there is one source. A check refuses an emoji in a control | after M1 |
| L2 | **A type scale.** 11 px is the floor and is for labels; anything read as a sentence is 12 px or more. The right panel and plan blocks first | after M1 |
| L3 | **The kit's controls outside Settings**: a styled select for the five native ones, and a segmented control that cannot overflow its panel | code |
| L4 | **Layout under pressure**: the right panel folds itself below about 1,100 px, the front door scrolls clear of the composer | code |
| L5 | **Meaning**: a done checklist that reads as done; a reply's actions on hover or focus with the rest in a menu | code |
| L6 | **The dark theme to the glass spec**: panel depth, the top streak on every surface, the orbs, measured against the guide and the contrast checks | after M1 |
| L7 | **The rail**: conversations grouped by date, a mark on one with a task running | code |
| M1 | **Tailwind 4**, which clears `npm audit`'s 5 (4.6's decision 5). Before L1, L2 and L6, so the tokens are moved once | code |
| M2 | **The root documents into `docs/`** (`docs/releases/`, `docs/roadmaps/`, `docs/strategy/`), every link followed, and a README of about a tenth the size that points at them | code |
| M3 | **The renderer in more than one chunk** (1.74 MB today): Settings, VIBE and highlight.js loaded when first used | code |
| M4 | **A way back when the agent's server is down**: the refusal offers the switch, one click (4.6's decision 1) | code |

4.6's rule is unchanged: **a switch turns on by default only if its arm is BETTER beyond the noise
band, beside a same-day control, with zero new false claims.** Nothing in L or M changes a request
the model sees: `agentRequests`' 15 hashes and the replay gate stay as they are.

## How it runs

- **Order:** L0, then K1 and K2, then M1, L1 to L3, L4 to L7, M2 to M4. K3 to K7 run on Colin's
  machines whenever they are free and are not blocked by, and do not block, the rest.
- **Each L goal** ends with the accessibility suites green (style, field contrast, button names,
  tab traversal, modal focus, settings kit) and a before and after capture of the scenes it touched.
- **Screenshots for the README** are captured on the Mac before the release. A Linux capture uses
  different fonts, so the ones taken in this work are for review and are not committed.

## Status (2026-11-20, L0 done)

| goal | state | measured |
| --- | --- | --- |
| L0 the screenshot harness | **done** | `scripts/capture-screenshots.js` on `3d50909` captured chat and agent scenes with the rail's rows, every user bubble and each reply's body blank. The cause was the harness and not the app: a hidden window's frame clock stops after its first paint, so anything mounted after the stubbed IPC answered stayed at its entrance animation's first frame (`row-enter`, `oasis-enter`, `block-fade-in` at `currentTime` 0, opacity 0; all finished once the window was shown). Now every scene shows the window inactive and settles each finite animation before the capture. 18 channels the 4.x renderer calls had no stub and logged "No handler registered"; all are stubbed, and the version shown is `package.json`'s. Checked under xvfb: 23 scenes (welcome, chat and agent in both themes, both VIBE scenes, and all 15 Settings tabs), each exit 0 with no missing handler |
| every other goal | not started | |

## Decisions for Colin

1. **`lucide-react` is a new runtime dependency** (decision 2 of the review said adopt). It is
   bundled into the renderer and makes no request. `docs/dependencies-4.1.md` gets its line with L1.
2. **Moving the root documents changes every link to them** in old release notes, the README and
   published GitHub releases. Links inside the repository are rewritten with M2; links in release
   bodies already published on GitHub will point at paths that no longer exist on `main`, though
   they still resolve at each release's tag.
3. **K3 to K7 are yours to schedule**: none can run from this branch's container, which has no
   GPU and cannot reach LM Studio or `:8081`.
