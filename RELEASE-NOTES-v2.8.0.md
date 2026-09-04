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

*(further sections — pending)*

## Measured

*(pending)*

## Not in this release

*(pending)*

## Upgrade notes

- The pack format gains a kind, `zim`, whose manifest is a pointer (`zimPath`) with no
  documents. Older builds ignore it as an unreadable pack.
