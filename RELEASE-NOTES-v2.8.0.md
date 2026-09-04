# Sigma Oasis v2.8.0 — the later row

The roadmap's "later" row, taken in order. This release is the first item: the reference
library reads Kiwix ZIM files, which is offline Wikipedia and WikiMed at the user's choice.
As before, the privacy core is unchanged — a ZIM is a file on your disk, read where it is.

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

*(further sections — pending)*

## Measured

*(pending)*

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
  documents. Older builds ignore it as an unreadable pack.
