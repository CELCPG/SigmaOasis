# Reference library packs — format v1

A *pack* is a folder of plain-text or Markdown documents plus a `manifest.json` that says
what each document is and where it came from. Sigma Oasis installs a pack by **copying** it
into `userData/library/<id>/` and, from then on, retrieves passages from it by relevance
before the model answers (the `reference_lookup` tool, and app-initiated lookups on health /
finance / legal / preparedness questions or when offline). Nothing about a pack touches the
network. Reader: `src/main/ipc/library.ts`.

```
my-pack/
  manifest.json
  docs/
    first-aid-fm-4-25-11.md
    are-you-ready.md
```

## manifest.json

```json
{
  "formatVersion": 1,
  "id": "first-aid",
  "name": "First aid & emergencies",
  "description": "US Army FM 4-25.11 First Aid and FEMA guidance, public domain.",
  "version": "2026.08",
  "license": "Public domain (US federal works)",
  "kind": "curated",
  "sourceNote": "Retrieved 2026-08 from the publishing agencies; see each document.",
  "docs": [
    {
      "id": "fm-4-25-11",
      "title": "FM 4-25.11 First Aid",
      "source": "https://armypubs.army.mil/...",
      "license": "Public domain (US Army)",
      "date": "2002-12-23",
      "file": "first-aid-fm-4-25-11.md"
    }
  ]
}
```

| Field | Rules |
| --- | --- |
| `formatVersion` | Must be `1`. |
| `id` | `[a-z0-9][a-z0-9-]{1,63}`; becomes the directory name. Two packs cannot share an id. |
| `name`, `description`, `version`, `license` | Free text; `name` required. `license` is the pack as a whole. |
| `kind` | `curated` (downloaded/bundled) or `user` (built from the user's folder). Anything else reads as `curated`. |
| `sourceNote` | Optional free text on sources, freshness, scope. Shown in Settings → Library. |
| `docs[]` | 1–600 entries. |
| `docs[].id` | `[a-z0-9][a-z0-9-]{0,79}`, unique within the pack. Part of every citation. |
| `docs[].title` | What the model cites. |
| `docs[].source`, `license`, `date` | Optional provenance, carried into every passage the model sees. Give them. |
| `docs[].file` | A bare file name under `docs/` ending `.md`, `.markdown` or `.txt`. No subdirectories. |
| `docs[].chars` | Filled in at install; ignored on input. |

## Documents

- UTF-8 text or Markdown. Markdown headings (`#`…`######`) become the *section* in citations
  ("pack › document › section · 42% in"), so keep the source's heading structure — it is what
  makes a citation checkable.
- One document ≤ 2,000,000 characters; one pack ≤ 8,000,000 characters. Split a very long
  manual by chapter rather than truncating it.
- Text is normalized (line endings, trim) at install and chunked at ~1,000 characters on
  paragraph/sentence boundaries with 150 overlap — the same chunker as memory and fetched pages.
- Prefer sources whose license permits redistribution and say which: the first curated tranche
  is US federal works (public domain). wikiHow (CC-BY-NC-SA) and Red Cross material are not
  redistributable inside an MIT-licensed app and are deliberately excluded.

## index.json (written by the app, not by pack authors)

Per-document embedding vectors for one named embedding model, base64 Float32. Optional and
rebuildable: a pack without it (or embedded with a different model than the one now loaded)
is retrieved keyword-only until "Embed" is run in Settings → Library. Do not ship it in a pack —
it is specific to the user's embedding model.

## Making a pack from a folder

Settings → Library → "Add folder…" builds a `user` pack from `.md`, `.txt` and `.pdf` files
(recursively, up to 600 files). It is a snapshot: files are extracted and copied at that
moment. Each document's `source` is its original path.
