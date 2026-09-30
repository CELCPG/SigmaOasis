# Web answers: the app's search, citations and the source check (v4.1)

What the app does with the web on a factual turn, beyond the model's own tool calls. Code:
`lib/appSearch.ts`, `lib/contextProviders/autoSearch.ts`, `lib/webSources.ts`,
`lib/sourceCheck.ts`, `main/ipc/search.ts`. Nothing here adds a host: every request goes through
the audited search and fetch paths and appears in Settings → Activity.

## The app's own search

- **The question, rewritten.** No model call: request framing ("can you check…") and the
  question mark are dropped, the words that name things kept, and the date named for a live
  question ("…today September 30 2026") or the year for a "this year" one. A message that asks
  several things becomes up to three queries; the app runs two (each spends one of the model's
  three searches).
- **The privacy trimmer keeps the subject.** A cut personal clause gives back its place, and for
  a live subject its day: "weather for my run in Richmond today" goes out as "…weather like in
  Richmond today". The run does not; nor does Lagos in "headphones for my flight to Lagos".
- **Recent results.** Today's markets, scores and news ask the provider for the past day; this
  week and latest news for the past week — SearXNG `time_range`, Brave `freshness`, DuckDuckGo
  `df`. Weather never (a forecast page has no date). A filter that empties the page is retried
  once without it.
- **Pages, not snippets, on a live question.** The top two readable result pages are read before
  the model is asked — 6 s for both, static fetch only, not charged to the model's fetch budget —
  and their passages handed over. When none can be read, the model is told it holds snippets:
  leads, not sources.

## Citations

A turn's web results and fetched pages are numbered on the same sequence as its library passages:
`[1]`–`[8]` for a search, the next numbers for a second one, and a page keeps the number its
result had. Each numbered output tells the model to put `[n]` after a sentence that uses it. In
the bubble a web marker opens its page; the grounding pass flags a marker that names nothing
retrieved, and a marker labelled with another source's title.

## The source check (Grounding & checks, off by default)

On a turn that consulted a source, the answering model re-reads up to six of the reply's
checkable sentences — a number, score, time, date or name — one at a time against the evidence
that bears on each, thinking closed, 60 tokens. A contradiction, or a sentence citing a source
that does not state it, goes back through the one revision. Cost: one short call per sentence,
about 1–2 s each on the 9B (estimated), capped at 20 s of the 60 s checking limit. Off until
measured.

## Year-tagged library documents

See `library-pack-format.md` (`docs[].appliesToYear`): a document older than this year, or a
question about the figures in force now, puts the web tools on the wire and names the year.
