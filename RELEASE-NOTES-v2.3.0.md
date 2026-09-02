# Sigma Oasis v2.3.0 — the current one

One change, on its own, measured before anything else is built on it: the app moves from
Electron 31 to **Electron 44** — Chromium 126 → **152**, Node 20 → **24**. Electron 31 shipped
in mid-2024 and left the supported window in early 2025, so a privacy app had been running on a
browser engine eighteen months past its last security fix. That is the whole reason for this
release, and the reason it carries nothing else: a Chromium two years newer under the v2.1
animation work and the v2.2 checks is a risk best isolated, so every suite ran against this
change alone — and then the head-to-head bench ran the same tree under both runtimes, which
found the one thing this release changes besides the runtime.

## What had to change in the tree

Electron's breaking-changes record for majors 32 through 44 was read against the source. Two
things applied:

- **The `console-message` listener** in the Workbench's debug path used the pre-35 positional
  signature; under 35+ the details ride on the event object, and `message.slice` would have
  thrown on the first line the sandbox page logged. One line.
- **Electron no longer downloads its own binary.** Since Electron 42 the `electron` npm
  package fetches its binary on first run instead of in a postinstall script. Every script in
  this repo that runs the app for real — the nine check suites, the evals, the head-to-head
  driver, the pack builder — reaches that binary by path and *skips* when it is missing, so a
  fresh `npm install` would have left CI green with the Electron suites silently not run.
  `scripts/ensure-electron.js` now fetches it at install time, the way the package used to,
  and the check suite fetches on demand rather than skip.

Already in place, and worth saying: the one removal that bites most apps at 32 — `File.path`
— had been replaced with `webUtils.getPathForFile` long ago; the `WebRequestFilter` and
`net.request` changes touch patterns this tree never used.

## What was measured

- **2,574 node checks**, 0 failures, unchanged in count and content.
- **All nine real-Electron suites** green on Electron 44: 25 render, 119 + 72 style, 43
  tab-traverse, 177 modal-focus, 172 plan-accessibility, 62 markdown, 46 workbench, 24
  transport — the animation, contrast, focus-containment and accessibility-tree work of v2.1
  and v2.2 measured the same under Chromium 152 as under 126.
- **The packaged app** builds with the existing electron-builder and boots on a scratch
  profile.
- **The bench, same tree, two runtimes (round 14).** Eighteen tasks, both arms 18/18 valid on
  the first pass, judged blind by critics briefed from the task set. **0 won, 0 lost, 18
  ties** on the task column after one verdict was overruled by experiment; both cross-cutting
  columns 18 ties, contested on 4 and 3 tasks — a same-code pair puts almost nothing in play,
  which is what a runtime round should look like. The overruled verdict is the paragraph
  below. Record: `docs/head-to-head/verdicts/round-14.json`.
- **The render bench, same tree, two runtimes.** `bench:render` gained a `BENCH_ELECTRON`
  override so one checked-out tree can be measured under two Electron binaries — the
  comparison an upgrade actually needs, since the report rightly voids a pair of labels that
  rendered different trees' text. Three runs each, one 24.9K-character streamed reply into a
  chat holding twelve:

  | runtime | CPU | JS | layout | input p95 | input max | render lag |
  | --- | --- | --- | --- | --- | --- | --- |
  | Electron 31 (Chromium 126) | 39.4s (38.6–40.4) | 8.8s | 10.4s | 10ms | 202ms | 363ms (288–417) |
  | Electron 44 (Chromium 152) | **30.6s** (30.2–30.9) | **6.8s** | **6.9s** | **7ms** | 286ms | 395ms (389–400) |

  Main-thread cost down 22%, layout down a third, on the same code. Input-max and render-lag
  are within each other's spread. The ~390ms render lag itself is a property of this tree
  under *both* runtimes — the v2.1.0-rc row in the same table reads −5ms — which is a finding
  about v2.2, recorded here and not chased in a release that changes only the runtime.

### The one app change, found by the gate

VC3's dark-theme capture on Electron 44 showed three tool-call headers, the selected
conversation title and the Rollback and Export actions drawn in the **light** theme's ink —
1.05:1, dark on dark — 700ms after the switch, and the critic scored it against the new
runtime at low confidence. Two more captures per arm found nothing (1 of 3 on 44, 0 of 3 on
31), and a direct probe that flips the theme exactly as the app does froze the same thing on
**both** runtimes: every element carrying Tailwind's `transition-colors` held the old ink for
over three seconds while plain text switched within 100ms. A theme change starts a 150ms
colour transition on each such element, a transition only advances when the compositor ticks,
and a covered window gets none — so which arm was caught was a fact about the desktop, not the
runtime. The weakness is the app's, and it has been there since the first `transition-colors`
went on a button: switch theme while the window is throttled and the text stays unreadable for
as long as it stays throttled.

Fixed here, as the one change besides the runtime: the theme flips with transitions suspended
for the two frames the switch takes (`App.tsx`, `index.css`), and a new style check measures a
`transition-colors` element across a guarded switch in a real window — the new ink lands in
the same frame — and reports what an unguarded switch reads at the switch (the previous ink,
a transition in flight). Verdict overruled to a tie and recorded as overruled.

### Recorded, not hidden

- **The first run after the upgrade failed one check.** The page-extraction check's single
  loopback load came back `ERR_FAILED` with the network service logging a crash and
  "Unable to map Index file". Every check process shared the default Electron profile under
  `~/Library/Application Support/Electron`, whose disk cache Electron 31 had written; opening
  it under Chromium 152 is what crashed. The check passed 5/5 in isolation on both the
  re-signed and the pristine binary, and every full run since. Each check now runs on a
  throwaway `--user-data-dir`, so the machine's history is no longer a precondition.
- **macOS folder privacy treats the re-signed binary as a new app.** Several runs had an
  Electron process refused permission (`EPERM`) to rename, unlink or open a file inside the
  repository — vite emptying `out/`, the bench appending its results, and finally the app
  itself renaming its settings file into place on the bench profile — while plain Node did
  the same operations without complaint. Pinned by a probe: Electron proper renaming a file
  it had just created was refused 3/3 under `~/Documents/OpenMind` and succeeded 1/1 under
  `/tmp`. The repository lives in Documents, which macOS gates per app; the local dev binary
  is ad-hoc re-signed on every install (`scripts/sign-dev-electron.sh`, for a Gatekeeper
  reason recorded in `RELEASING.md`), so every re-sign is a new identity with no grant. The
  bench now keeps its profile under `$TMPDIR` and does its own file writes on plain Node, so
  it no longer depends on a permission only a person can grant; the check suite's throwaway
  profiles were already outside Documents. The head-to-head capture kept each run's
  throwaway profile inside the run directory, which is inside the repository; it now keeps
  it under the OS temp dir and records where, and the driver probes for the WebSocket flag
  Node 22+ rejects rather than assuming Node 20.

## Platform floor

Electron 44 requires **macOS 13** (Monterey left with Chromium). The build stamps that into
the app, and the release workflow now also writes it into the update manifest as
`minimumSystemVersion` — in Darwin numbering (`22.0.0`), which is what the updater compares
against — so a Mac on 12 is told there is no update instead of being handed an app that
cannot launch. Windows 32-bit and Linux ARM 32-bit lost prebuilt binaries upstream; neither
was ever a target here. The Homebrew cask's `depends_on macos:` is hand-maintained in the tap
and needs its own bump to `:ventura`; `RELEASING.md` says so now.

## Also

- Node 24 in the main process brings `zlib` zstd, which the ZIM-pack work in
  `STRATEGY-capability-multipliers.md` was waiting on.
- `@types/node` follows the bundled Node major.
- Two instrument findings from the round, both recorded in `rounds.json`: with the launcher
  shim as the entry the sidebar's version badge fell back to Electron's own version, so every
  screenshot footer named its runtime (the capture now writes the arm's package.json beside
  the shim); and the critic-prompt generator committed in round 9 had been dropped by the
  round-13 merge, so rounds 10–13 were judged from briefings not in the repository. Restored,
  with the counts block folded in, plus a transcriber that reads the task column through the
  withheld key instead of by hand.

## Upgrade notes

Auto-update from v2.2.0 on macOS 13+, Windows and Linux. No new settings, no migrations, no
change to any tool, check, record or privacy behaviour. One visible change beyond the runtime:
a theme switch no longer cross-fades button and row colours over 150ms — it lands at once.
Macs on macOS 12 stay on v2.2.0.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v2.2.0...v2.3.0
