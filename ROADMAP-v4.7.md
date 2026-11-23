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

## Status (2026-11-23, L0, K2, M1 and S1 done)

| goal | state | measured |
| --- | --- | --- |
| L0 the screenshot harness | **done** | `scripts/capture-screenshots.js` on `3d50909` captured chat and agent scenes with the rail's rows, every user bubble and each reply's body blank. The cause was the harness and not the app: a hidden window's frame clock stops after its first paint, so anything mounted after the stubbed IPC answered stayed at its entrance animation's first frame (`row-enter`, `oasis-enter`, `block-fade-in` at `currentTime` 0, opacity 0; all finished once the window was shown). Now every scene shows the window inactive and settles each finite animation before the capture. 18 channels the 4.x renderer calls had no stub and logged "No handler registered"; all are stubbed, and the version shown is `package.json`'s. Checked under xvfb: 23 scenes (welcome, chat and agent in both themes, both VIBE scenes, and all 15 Settings tabs), each exit 0 with no missing handler |
| K2 `eval:diff` across unequal pass counts | **done** | A never-banded line that reads WORSE while the run's count is no higher than the baseline's, with unequal pass counts on the two sides, now carries a note: it is a rise in the rate and not in the count, with both counts and pass counts (J2's case reads "1 in 100 runs over 4 passes in the baseline, 1 in 50 runs over 2 passes in the run"). The verdict is unchanged, still WORSE: whether such a line should decide one is the gate's rule (decision 4). No note when the count rose, when the pass counts are equal, or when the rate did not rise. `test/evalDiff.test.ts` (one test, 4 cases), `docs/evals/claims.md`. `npm run typecheck` clean; `test.sh --only evalDiff replayGate` exit 0 |
| CI's Linux leg | **fixed** | `test/agentConnection.test.ts`'s "server that is down" read two wordings of a closed pooled socket (ECONNREFUSED, ECONNRESET) and met undici's third, "other side closed", on a commit that touched no code under test. It reads all three; the product's sentence is the same in each. Green on macOS, Windows and Linux (`359f569`) |
| M1 Tailwind 4 | **done** | tailwindcss 3.4.19 → 4.3.5 with `@tailwindcss/postcss` (autoprefixer removed; Lightning CSS prefixes). The configuration moved from `tailwind.config.js` into `index.css`: `source(none)` and v3's two `@source` globs, v3's `dark` variant to the selector, `hover:` without v4's `(hover: hover)` wrapper, the tokens in `@theme` and the variable-backed inks in `@theme inline`. The app's own CSS sits in the utilities' cascade layer after the utilities, so v3's specificity order holds (unlayered, every rule there would beat every `dark:` and `hover:` utility). **Pinned to v3 where v4 differs:** the palette for the 12 families in use (v4's OKLCH steps would have moved every raw colour the contrast tests measured); the type scale's line heights as lengths (v4's ratios shortened every `text-[10px]` line inside a `text-xs` block, 16 → 13.3px); and six preflight rules (border colour, button cursor, placeholder colour, `<option>` padding, the range slider's box, search fields). **The upgrade tool's damage, reverted:** it rewrote four non-class strings that looked like classes: the longform eval's arm `'outline'` → `'outline-solid'` (`answerEval.ts`), a Settings reset key and a Settings search keyword (`GroundingTab.tsx`), and a code comment (`vibeOrb.ts`). **One regression no screenshot could show:** the minifier keeps the last of a prefixed/standard pair, `.glass-panel` wrote the standard `backdrop-filter` first, and Chromium ignores `-webkit-backdrop-filter`, so every glass surface lost its blur over backgrounds too smooth to show it; the order is fixed and `test/tailwindBuild.test.ts` fails on it (shown by reintroducing it). **Measured:** all 38 scenes (welcome, chat and agent in both themes, both VIBE scenes, all 15 Settings tabs in both themes) against a v3 build of `5c672df`: every one within v3's own run-to-run noise (≤ 0.03% of pixels, a clock and a pulsing dot), 26 byte-identical; every element's full computed style in all 38 scenes compared under both builds, with each remaining difference accounted for (`space-y`/`divide-y` moving a margin or border to the other sibling at the same pixels, an invisible outline written two ways, a clock, an animation). The tests that compiled Tailwind through v3's API (`styleCheck`, `chromeContrastCheck`, `planBlock`) use v4's; the three that read colours inside the page read Tailwind 4's `oklab()` through one exact parser (`test/cssColor.ts`; the old "first numbers" reading turned a violet chip grey and dropped minus signs). CSS 107 → 84 KB. `npm test`: node suite 3,984 / 3,984 (+7 `tailwindBuild`, +5 `cssColor`) and every Electron suite at 4.6's counts (Workbench self-skips without Pyodide here, and MCP secrets reads 18 for want of a keychain; CI runs both). `npm audit`: the five through Tailwind 3 are gone (decision 6 has what is left) |
| S1 `npm audit` (decision 6) | **done, on its own branch** | On `claude/eager-dirac-re88vg`, from 4.6.0's `main` (`3d50909`) and independent of M1, so the runtime change is reviewed apart from the styling. `npm audit` on 4.6.0's lockfile today: **13 (1 low, 8 moderate, 4 high) → 0**. Within each major: **Electron 44.5.1 → 44.11.5** (GHSA-jr5w-w6x2-84p9, the eMudhra intermediates), **DOMPurify 3.4.16 → 3.5.0** (GHSA-c6gr-qvv4-5v3f, -cg2g-xh64-v4q7, -mrv2-3pqr-j5jr), **Vite 7.3.6 → 7.3.8**; in the lockfile only, undici 7.30.0 → 7.30.2 and node-gyp's 6.29.0 → 6.29.1, source-map-js 1.2.1 → 1.2.4, fast-uri 3.1.8 → 3.1.9, postcss-selector-parser 6.1.4 → 6.1.6. **minimatch** (GHSA-g3hv-75wg-m249, 7.0.0–11.0.0): no electron-builder 26.x fixes it (26.18.1 still pins `@electron/universal` 2.0.3, which asks for `^9`, and `app-builder-lib` asks for `^10`), and npm's offered fix is electron-builder 24. So `package.json`'s `overrides` gives those two `minimatch` `^11.0.9`, and keeps `glob@7` and `dir-compare` under them on `^3.1.5`, since an override reaches the whole subtree and both call minimatch 3's default export, which 11 does not have. Both packages use only the named `minimatch` and `Minimatch`, which 11 keeps. `npm install` dropped all 13 `libc` entries on `@rollup/rollup-linux-*` again; they are restored, in their old place, so the lockfile diff touches none. **Measured:** `npm ci` from the committed lock; `npm run typecheck` clean; `xvfb-run -a npm test`: node suite 3,971 / 3,971, and 13 Electron suites at 4.6's counts, markdown (DOMPurify's boundary) 62 / 62. Workbench self-skips here: this container cannot reach Pyodide's CDN. `npm run build:unpack` packages on Electron 44.11.5 with minimatch 11 in `app-builder-lib`'s file matcher, and the asar holds `out/`, `package.json` and the runtime `node_modules` only, as before. One node test failed on 4.6.0 unchanged too, under this container's Node 22.23.5: the agent connection's "server down" case met undici's "other side closed". It is `359f569`, taken from this branch as is. The Mac dry run of the Electron bump is Colin's (decision 6) |
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
4. **Should a false-claim WORSE whose count did not rise decide a verdict?** K2 only says so
   beside it; the verdict is still WORSE, as 4.6's decision 7 left it. Changing that is a change to
   the gate's rule and so yours.
5. **K1's baselines are re-scored on your PC.** A committed baseline keeps no report, so moving
   them to rule 4 needs the full results in `.eval-results/`, and `test/evalRescore.test.ts`
   requires every committed baseline to carry the current rule. The rule, its labelled entry and
   its test can be written here; the re-score and the stamp cannot.
6. **`npm audit`: S1 takes it from 13 to 0 on its own branch, `claude/eager-dirac-re88vg`.**
   Advisories published since 4.6.0 shipped had put 4.6.0's own lockfile at 13 and this branch at
   12, none of them M1's. S1 patches all 13 within their majors (the Status row has each version):
   Electron to 44.11.5, DOMPurify to 3.5.0, Vite to 7.3.8, the rest in the lockfile, and minimatch
   through `overrides`, since no electron-builder 26.x fixes it and npm's only fix is 24. Every
   suite is green, the markdown check included. **Yours:** (a) **the Mac dry run of
   `claude/eager-dirac-re88vg`** (`RELEASING.md`, *Release dry run*, *Use workflow from* that
   branch), because Electron moved six minors and the build now runs minimatch 11, before it
   merges; (b) **the merge order with M1:** both rewrite `package-lock.json`, so whichever merges
   second takes the other's `package.json` and runs `npm install`, then puts back the 13 `libc`
   entries if npm drops them, and checks `npm audit` reads 0. The minimatch overrides can go once
   electron-builder ships a minimatch of 11 or later.
7. **What the migration pinned, for L2, L3 and L6 to keep or drop on purpose:** v3's palette
   (v4's OKLCH steps are more saturated), its line heights as lengths, `hover:` on touch-first
   devices, the pointer on buttons, gray-400 placeholders, and the two gradients in sRGB
   (`/srgb`; v4 interpolates in OKLab). Each is a line in `index.css`'s header; each change is a
   design decision with its own before and after.
