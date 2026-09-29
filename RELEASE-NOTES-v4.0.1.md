# Sigma Oasis v4.0.1 — a live question reaches the web, and a table no longer holds the window

4.0.1 adds nothing. It fixes two bugs in the build 4.0.0 users run today, both found in one
session of 2026-09-29: asked for the weather, the S&P futures and the next Miami Heat game, the
app answered each with a list of websites and said the internet was not working; and a reply
that carried a table could hold the window at 100% CPU until it was killed. Pinned by 3,214 node
checks and every Electron check.

## The window froze on a reply with a table

After every turn that ran a tool, three checks read the reply for a heading such as *Tools used:*.
The pattern that finds it allowed markdown furniture before the words, written as a group of runs
inside a repeat — so a line made only of furniture could be split between the repeats in 2^n ways,
and every one was tried before the line was given up. A table's separator row,
`|------|------|------------|------|----------|`, is such a line. Measured: 2 s at 30 characters,
doubling per character. The reply had already streamed in full; the window then stopped
answering, and nothing was saved.

It is in 4.0.0. In the session that started this, one turn streamed for 4.8 s and took 23 s, under
a 28-character row. The first live reply with a weather table, a 50-character row, did not come
back at all.

The furniture is one character class now, which accepts the same strings and reads each line
once. Two tests hold it:

- `test/groundingDeadline.test.ts` runs the whole pass on that reply, and on six other lines of
  furniture, in a child process under a deadline — a pattern that backtracks cannot be interrupted
  from inside, so a test that calls it directly does not fail on a regression, it never finishes.
- `test/regexBacktracking.test.ts` is the class rather than the case. It reads every regex literal
  out of `src/` — 961 of them — and runs each against short runs of the characters it names, under
  a deadline. It first proves it finds the pattern 4.0.0 shipped. With the old pattern put back in
  the source, it fails and names the file and line.

## A live question did not reach the web

The search provider was fine. Four things were not.

- **The model was sent no web tool.** Each turn carries the always-on tools and the best-ranked
  of the rest, and with four always-on and a cap of six that is two places. "Today" ranked the
  date tools and `reference_lookup` above `web_search`, so the model held nothing that could
  reach the web; its reasoning says "I need to use web_search" five times, and it called
  `reference_lookup` five times. Now a turn about the live world, or one that asks for the web by
  name ("look it up", "try DuckDuckGo", a URL), carries `web_search` and `fetch_webpage` whatever
  the ranking says. Any other factual turn carries them unless the reference library covers its
  domain. Offline forces nothing.
- **The app's own search did not run either.** The test for a factual question knew albums and
  tickers, and its proper-noun rule needs a capital letter nobody types in a chat box. It now
  knows weather, market futures, games and scores, each anchored to a subject: "futures" alone is
  also a Rust type, and "my next game" is someone's side project.
- **The fact ledger filed the clock.** Today's date was captured as a verified claim, then read
  back through `reference_lookup` as a source and filed again. The date a reply was written on is
  refused at the capture and at the writer; a span the question itself stated is not a claim; a
  ledger entry is not a source; and the entries 4.0.0 wrote are removed at startup.
- **A copied link was flagged as invented.** The reply wrote `…/quote/ES=F/**`, closing a bold
  span, where the search had returned `…/quote/ES%3DF/`. Both spellings are normalized before the
  comparison; an invented path still fails.

## Measured

On Windows: `npm run typecheck` clean; the node suite 3,214 of 3,214; every Electron check —
render 25, style 74 and 123, tab traversal 43, modal focus 179, field contrast 22, settings kit
12, button names 20, plan accessibility 175, main bundle 20, markdown 62, MCP secrets 19,
transport 24.

Live, on the rebuilt app, with a 35B model on the CPU (neither GPU was used): the session's three
questions answered from pages the app fetched, in 149 s, 228 s and 556 s, with the web tools on
the wire in every request and the three clock entries pruned at startup.

The patterns, once, by hand, beyond what the new test repeats: every literal against runs of
20,000 characters, and 283 functions that read a reply, a question or a page against 1,157 inputs
of up to 40,000. Nothing else is exponential. Fifty-four patterns take between a quarter of a
second and 0.9 s on a 20,000-character run of one repeated character; two in the PDF reader take
longer and only ever read a 96-character window.

## Not in this release

- **The futures answer is weak.** The model asked for seven page reads against a limit of two and
  quoted a figure from a search snippet; the ledger then kept that figure, and "17 hours", as
  verified claims, because a snippet did state them. What a snippet is worth as a source is not
  decided here.
- **The 9B was not re-run live**, and `eval:tools` was not run: the bench machine's GPU link is
  logging corrected errors under load. The ranking in the completed live run used stand-in
  embeddings.
- **Slow is not fixed, only stuck.** Reading measurements is quadratic on an unbroken run of
  digits and commas (0.6 s at 16,000 characters), and rendering 20,000 nested quote marks did not
  return in 3 s. No reply is that shape, and a page that is would have to be one run with no space
  in it.
- A pattern assembled at run time has no literal for the new test to read. The ones the grounding
  pass builds are covered by the deadline test; the rest are not.

## Upgrade notes

- At startup the app removes fact-ledger entries that record only the day they were written. A
  ledger with nothing else in it is removed whole, and written again by the next verified claim.
- On a turn about the live world the web tools take two of the ranked places. With the default
  cap of six, such a turn carries the four always-on tools and the two web tools.
