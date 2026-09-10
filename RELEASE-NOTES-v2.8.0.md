# Sigma Oasis v2.8.0 — the later row

The roadmap's "later" row, taken in order and closed: the reference library reads Kiwix ZIM
files, which is offline Wikipedia and WikiMed at the user's choice; a model can propose a
change to a file and the reader sees the diff before a byte lands; and the in-app LoRA loop
is closed as designed rather than built. As before, every item was measured where a model
is involved, and the privacy core is unchanged — a ZIM is a file on your disk, read where it
is, and a patch is a proposal until you say otherwise.

## What ships

**ZIM files as packs.** *Add ZIM file…* under Settings → Library registers a Kiwix ZIM — offline
Wikipedia, WikiMed, and the rest of the Kiwix catalogue — as a pack, where it is: nothing is
copied and nothing is embedded. A lookup binary-searches the file's own title index for the
words of the question, opens only the articles it finds, strips and chunks them by section,
ranks them by a BM25 built over just those chunks and, when the rest of the library has
vectors, embeds the opened sections so they join the semantic leg — semantic only over what a
lookup opens, never over the file. The passages ride the turn as any pack's do, cited as
`<file>.zim#<article>`. Removing the pack removes the pointer; the file stays.

The reader (`src/main/ipc/zim.ts`) is the app's own: the header, the MIME list, the URL and
title pointer lists, directory entries with redirects, clusters of blobs. zstd-compressed
clusters, which every Kiwix file built since 2020 uses, are read with Node's own zlib; an
xz-compressed ZIM is refused with a sentence saying so. The strategy allowed a vendored xz
decoder; the tree does not carry one until a file that needs it appears.

**Diff-reviewed writes.** A new tool, `propose_patch`: the model proposes exact
search-and-replace edits, or the whole new file, and the app computes the unified diff against
the file as it is and shows it in the chat with *Apply* and *Discard*. Nothing is written until
Apply — working directory or not, and there is no standing grant for it; the review is the
point. The diff stays on the record, so what was proposed and what happened to it read the same
after a reload. The Coder slot's `write_file` is unchanged and still off by default; this is the
tool to reach for when a change should be seen before it lands.

## Measured

**A ZIM beside the library.** The library suite with a fixture ZIM registered — three first-aid
articles, built by the eval — against a same-day control without it, qwen3.8-9b:

| run | retrieved | answered | cited | unsupported figure | from the ZIM |
| --- | --- | --- | --- | --- | --- |
| with the fixture ZIM | 28/28 | 27/28 | 24/28 | 4/28 | 2/28 |
| control, no ZIM | 28/28 | 28/28 | 23/28 | 3/28 | — |

One case each way on answered, cited and unsupported, inside the suite's measured noise and in
opposite directions: no loss. The two cases that drew on the file answered and cited; no case
that missed retrieved a ZIM passage. `docs/evals.md` has the account. The gate the strategy named, a WikiMed file, needs a
WikiMed file on the machine; the reader and the path are proven on the fixture.

**Diff-reviewed writes.** No model in the loop to grade, so the gate is the node suite: six
cases pin the arithmetic — an edit that matches once is applied and an empty search appends,
a missing or ambiguous search is refused with the reason, one change is one hunk with context
and the counts say so, distant changes are two hunks and adjacent ones merge, a new file is all
additions and an unchanged file no hunks, and the diff applied to the old text yields the new
— and five pin the handler through a test seam that answers the review: Apply writes the file
and the result carries the diff and counts; Discard writes nothing and says so, diff attached;
a new file is written only on Apply; a bad edit is refused before any review and no change
means no review; the working-directory boundary still applies. A model-graded gate would need
a corpus of edit requests with known-good patches, which the tree does not have yet; it is owed
with the first one.

## Not in this release

- **An in-app LoRA loop.** The last item of the roadmap's later row, closed as designed rather
  than built. The loop exists and is out of band on purpose: the app exports outcome-labelled,
  redacted traces with a schema stamp, any OpenAI-format trainer trains them, and the
  tool-choice harness judges the result against the base model (`docs/trace-export.md`).
  Moving the training in-app would add a training runtime the app has no other use for, on
  one chip family, to save one shell command — and would make the app the thing that trains,
  which it has always said it never is.
- **An xz decoder for pre-2020 ZIMs**, until a file that needs one appears.

## Upgrade notes

- The pack format gains a kind, `zim`, whose manifest is a pointer (`zimPath`) with no
  documents. Older builds ignore it as an unreadable pack. *Add ZIM file…* refuses a file
  whose clusters are xz-compressed with a sentence saying so; a zstd or uncompressed ZIM,
  which is every Kiwix file built since 2020, reads as is.
- The tool table gains `propose_patch`. It is on under Settings → Tools like the other file
  tools, with a budget of three proposals a turn, and a slot's allowlist applies to it as to
  any tool. It asks every time — no approval mode skips the review, no standing grant covers it — and a review left unanswered
  for ten minutes is a discard, which the model is told. `write_file` is unchanged and still
  off by default.
- The tool table's pinned schema hash moves, as it does whenever a tool joins; the check
  suite carries the new value.
