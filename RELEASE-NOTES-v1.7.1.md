# Sigma Oasis v1.7.1 — the Almanac, included

v1.5 built an offline reference library and v1.7 made it personal — but the curated packs
themselves only existed for people who cloned the repository. An installed app had an empty
Almanac. This release closes that gap and rounds out the document story: the packs ship inside
the app, Word documents work everywhere a document can enter, a measured small-model failure mode
is mechanically recovered, and the eval harness learned to measure its own noise. Pinned by 1,320
node checks (17 new) and verified live in the built app against a 9B.

## The curated packs, one click away

- **Bundled with the app.** The seven curated packs — first aid, health, emergency preparedness,
  food safety, personal finance & tax, home safety, US civic basics; 105 public-domain documents,
  ~700 KB of text — now ship inside the installer, next to the Python runtime.
- **Settings → Library → "Curated packs".** Each pack shows its contents and license with an
  **Install** button: a disk-to-disk copy that uses no network, embeds itself automatically, and
  becomes "✓ installed". When a future build ships a newer pack version, the button reads
  "Update to vX" instead.
- **`packs.zip` on every release** — the same content as a standalone download, for anything else
  that can read the documented pack format.

## Word documents, everywhere a document can enter

- **`.docx` works in personal packs and chat attachments.** A docx is a zip of XML, and the app
  already has a place where zips of XML are read safely: the sandboxed Workbench (XLSX profiling
  has always worked this way). Extraction is a standard-library Python script running inside
  WebAssembly with no filesystem and no network — a malformed file blows up in the sandbox, not
  in the app, and the app gains **zero new dependencies**.
- **Word headings become real sections.** Heading 1–6 and Title styles come back as Markdown
  headings, so a Word document gets the same section-aware chunking and *pack › document ›
  section* citations as everything else. Measured live: an inventory docx produced per-section
  passages, and a warranty question came back citing its section with the original `.docx` path
  as provenance.
- Without the Workbench runtime the file is refused up front with the fix named, instead of
  paying a sandbox cold start to fail.

## A measured failure mode, recovered

In the v1.7 eval, a 9B model answered a first-aid question with — in its entirety —
`web_search("hypothermia what to do while waiting for help nhs")`: a tool call written as prose,
with perfect retrieval already in hand. The turn scored zero. The app now recognizes exactly this
shape and executes it through the normal tool loop — same budgets, same visible record, same
follow-up round for the actual answer. The recognition is deliberately narrow, because prose and
code are full of `f("x")`: it fires only when the **entire reply** is one such call, the name is a
tool actually offered that turn, and the tool's schema has a single unambiguous string parameter.
At most once per turn. A reply that merely *mentions* a call, or a call that would require
guessing between parameters, stays prose.

## The eval measures its own noise now

Re-measuring v1.7's retrieval change surfaced something uncomfortable: three full runs at
temperature 0 produced mostly-disjoint failure sets — cases flipped with identical retrieval. So
`EVAL_PASSES=N` now repeats a suite and classifies every case **stable-pass, stable-fail, or
flaky**, with the flaky ones named and a median over passes. The rule, recorded in
`docs/evals.md`: judge a change by the stable set; the flaky list is the suite's measured noise
floor. No more single-run victory laps — including ours.

## Upgrade notes

- Auto-update from v1.7.0, v1.6.1 or v1.4.7. Installed size grows by under a megabyte (the packs).
- Already-installed packs are untouched; the curated section simply offers what this build
  bundles. Everything in the
  [v1.7.0 notes](https://github.com/CELCPG/SigmaOasis/blob/v1.7.1/RELEASE-NOTES-v1.7.0.md)
  (tracked personal packs, section-aware retrieval, the energy layer) applies unchanged.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.7.0...v1.7.1
