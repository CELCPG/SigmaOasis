# Sigma Oasis v1.7.0 — your documents, alive

v1.5 gave a small model something to read; v1.6 gave it something to compute with. This release
makes the reading *personal and current*: a folder of your own documents becomes a tracked
reference library that notices when the folder changes and updates in place without re-paying for
what didn't change — and retrieval got sharper about *sections*, which the eval suite then
re-measured honestly. Plus a visual pass: light in motion wherever the app is actually working.
Pinned by 1,303 node checks (35 new since v1.6.1) and verified live in the built app against a 9B.

## Personal packs: tracked, not snapshotted

- **The folder is remembered.** "Add folder…" (Settings → Library) has built a pack from your
  `.md`/`.txt`/`.pdf` files since v1.5 — but as a dead snapshot. Now the pack tracks its source
  folder: opening the Library tab stat-walks it (no file contents read) and says plainly when it
  has drifted — *"Source folder has changed: 1 edited, 1 new (warranty.txt, lease.txt)."*
- **Update in place; unchanged documents keep their embeddings.** "Update" rebuilds the pack from
  the folder as it is now. Vector carry-over is by **content hash**, not filename — a renamed or
  moved file keeps its embeddings — so updating a 500-document pack after editing three files
  re-embeds three files. Sound because chunking is deterministic: identical text, identical chunks.
- **Embedding is automatic.** After an add or an update, embedding starts on its own (progress bar
  and Cancel as before). No embedding model loaded? A calm note — keyword search already works.
- **"My lease" now consults the library.** The trigger vocabulary grew to what personal documents
  actually are: *my lease*, *the warranty*, *my insurance policy*, *according to the spec*. Each
  noun stays anchored to a possessive or "the" — "foreign policy" does not fire. Measured live:
  "does my lease allow subletting the second bedroom?" pulled the user's own lease, and the reply
  quoted the current version's term with the citation *Home papers › lease*.

## Retrieval: sections, not blends

- **Section-aware chunking.** No chunk ever spans a Markdown heading boundary, so a short section
  ("### Boiling") is its own crisp passage that starts with its own heading, instead of blending
  into its neighbor and matching nothing well.
- **One passage per (document, section).** The first change alone let a strong section place two
  near-twin chunks in the top five and crowd out another section — the inverse disease — so
  lookups now spend their passages on distinct sections, backfilled from the next-best sections.
- **Re-measured, reported honestly** ([`docs/evals.md`](docs/evals.md)): both recorded
  wrong-section failures are fixed and **unsupported measurements went 1/28 → 0/28** — the class
  where an invented "30 minutes" on a boil-water question is worse than no answer. The aggregate
  answered-rate did not move outside run-to-run noise, and the doc says so with three runs of
  evidence rather than picking the flattering one.
- The re-measurement also caught two defects that were never retrieval, both fixed: the pack
  builder was splitting styled first letters (*"F ace drooping"* in the stroke FAST mnemonic — the
  model failed the eval by quoting its reference *faithfully*), and a reply that opened by echoing
  the app's internal turn-notes scaffold now has that echo stripped and disclosed (🧾), by a guard
  that shares its marker string with the prompt so the two cannot drift.

## The energy layer

Motion now means exactly one thing: **computation in flight**. Nothing animates at rest.

- **The thinking core** gained a thin HUD scan arc sweeping its rim and two sparks orbiting at
  different periods, colored by the running tool; light sweeps through the THINKING label.
- **The streaming reply** carries a live wire — a teal-into-lavender light running its border —
  and the answering model's avatar breathes in rhythm. Both stop dead when the reply completes.
- **A running tool block** shows a light traveling its base in that tool's color; the **composer**
  breathes while a reply is generating; the ambient orbs drift on a 48/62-second cycle.
- All of it is compositor-friendly (transform/opacity only), and `prefers-reduced-motion` stills
  every animation while keeping its meaning.

## Upgrade notes

- **Re-embed once.** The new section-aware chunk geometry orphans vectors embedded before v1.7:
  packs show "Embed" again in Settings → Library and stay keyword-ranked until re-embedded (user
  packs re-embed themselves the first time you press Update). This is the same graceful path that
  already existed for switching embedding models.
- **Pre-v1.7 user packs** predate folder tracking: remove and re-add the folder once; updates work
  from then on. New fields in the pack format are additive; format version stays 1
  ([`docs/library-pack-format.md`](docs/library-pack-format.md)).
- **Auto-update:** from v1.6.1 (or v1.4.7) this appears as an update automatically.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.6.1...v1.7.0
