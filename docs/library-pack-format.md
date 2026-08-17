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
| `sourceFolder` | v1.7, written by the app on `user` packs: the folder "Add folder…" read, which "Update" re-reads and the staleness check walks. Pack authors never set it. |
| `docs[]` | 1–600 entries. |
| `docs[].id` | `[a-z0-9][a-z0-9-]{0,79}`, unique within the pack. Part of every citation. |
| `docs[].title` | What the model cites. |
| `docs[].source`, `license`, `date` | Optional provenance, carried into every passage the model sees. Give them. |
| `docs[].file` | A bare file name under `docs/` ending `.md`, `.markdown` or `.txt`. No subdirectories. |
| `docs[].chars` | Filled in at install; ignored on input. |
| `docs[].sourceMtime`, `sourceSize` | v1.7, written by the app on `user` packs: stat of the original file at build/update, compared by the staleness check so it never reads contents. |

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
(recursively, up to 600 files) and embeds it immediately when an embedding model is loaded.
It is a snapshot: files are extracted and copied at that moment — but the folder is
remembered (`sourceFolder`), so the pack is a *tracked* snapshot rather than a dead one:

- Opening Settings → Library stat-walks each tracked folder and shows when it has drifted
  ("Source folder has changed: 2 edited, 1 new …"). No file contents are read for this.
- "Update" rebuilds the pack from the folder as it is now. Documents whose extracted text is
  unchanged keep their embedding vectors — matching is by content hash, so a renamed or moved
  file keeps its vectors too — and only new or edited documents are re-embedded. Updating a
  500-document pack after editing three files costs three files.
- Removing or editing the original files never changes an installed pack until "Update" is
  pressed; lookups keep working from the copy.

## The curated tranche (v1.5)

`packs/sources/*.json` are the build specs; `bash scripts/build-packs.sh [id …]` rebuilds
`packs/<id>/` from them (Electron proper: each page is converted from a real DOM so headings
survive; sequential with a courtesy pause, because the federal sites throttle bursts). Every
document carries its URL, its license, and the page's own "last reviewed" date where the page
states one, plus the retrieval date. `test/packs.test.ts` fails the suite if a built pack does
not validate, has an error page captured as a document, or lacks provenance.

| Pack | Source | License |
| --- | --- | --- |
| `first-aid` | NHS (nhs.uk/conditions) | Open Government Licence v3.0 — attribution carried per document |
| `health` | MedlinePlus health-topic summaries (NLM) | Public domain (US federal) |
| `preparedness` | Ready.gov (FEMA) | Public domain |
| `food-safety` | FoodSafety.gov, USDA FSIS, FDA, CDC | Public domain |
| `finance` | CFPB, Investor.gov (SEC), IRS | Public domain |
| `home-safety` | US Fire Administration, EPA | Public domain |
| `civic` | USA.gov | Public domain |

Install any of them from Settings → Library → *Install pack…* by choosing the `packs/<id>` folder
(or a downloaded copy of it). Not included on purpose: MedlinePlus encyclopedia and drug pages
(A.D.A.M./ASHP copyright), Red Cross, wikiHow.
