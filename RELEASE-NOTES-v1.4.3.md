# Sigma Oasis v1.4.3

Search results now say what kind of source they came from. The narrow goal: an answer should never rest on five SEO pages that agree with each other, without anyone noticing that is what happened. Pinned by 954 checks, 16 of them new.

## Search results carry their provenance

- **Two ends get marked, and only two.** A result is labelled **primary** when it is the record itself — a `.gov`, `.edu` or `.int` domain, a regulator or filing, a standards body, a scholarly publisher — or **search-bait** when the URL is a known content farm, a listicle, or one of the shapes built to capture a query rather than answer it (`/how-to-buy-…`, `/price-prediction/`, `/complete-guide`). Encyclopedias are marked **reference**, described as a summary of sources rather than a source.
- **Everything else is marked nothing at all.** The ordinary web is unremarkable by URL, and most of it is useful. An unmarked result carries no demerit and no endorsement.
- **This is deliberately not a credibility ranking.** Deciding which news outlets to believe is not something this app has any basis for, or any way to maintain honestly. It marks what can be argued from a URL and stays silent about the rest — the same reasoning as the product tiers, which state what a source is authoritative *for* rather than whether it is trustworthy.
- **One line when it matters.** If any result is search-bait, the tool output says how many, whether a primary source appeared at all, and that repetition across SEO pages is not corroboration. If nothing is bait, nothing is said — a note on every search is a note that gets skipped.

## Deep research reads the bait last

- **Search-bait is demoted, not dropped.** A page built to rank for the query rather than answer it is the worst possible use of a fetch budget. It now sorts behind every other candidate — but is still read when nothing else is on offer, because on a thin topic an unread page is worth less than a labelled one. Relevance ordering holds within each group.
- **The source list and the run notes carry the same marks**, so the disclosure the model sees is the disclosure you see.

## What this does not fix

Measured against the eight sources from the session that prompted this — a research run about a stock where every corroborating page was an SEO domain — five of the eight are now marked as search-bait. The other three have no tell in the URL, and catching them would need either content analysis or a hand-maintained domain list. The part that holds regardless is the second sentence of the note: no regulator, no filing and no exchange listing appeared in eight results about a public company, and that is computable without judging anyone.

## Upgrade notes

- **macOS:** signed and notarized — no Gatekeeper dialog. Both Apple Silicon and Intel DMGs are attached. Also available via Homebrew: `brew tap CELCPG/tap && brew install --cask sigma-oasis`.
- **Windows:** the installer is unsigned, so SmartScreen will warn. Expected; proceed with "More info → Run anyway".
- **Auto-update:** if you're running v1.4.2, this release appears as an update automatically.
- **No settings migration needed, and no new configuration.** Marking is always on and costs nothing — it is computed from URLs the app already has, with no extra request to anyone.
- **Nothing new leaves your machine.** No feature in this release contacts anything the previous one didn't; deep research contacts strictly fewer low-quality hosts than before.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.4.2...v1.4.3
