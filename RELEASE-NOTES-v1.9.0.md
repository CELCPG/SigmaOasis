# Sigma Oasis v1.9.0 — every stated fact has a source

The app's promise is that a small model does not have to guess. Four kinds of fact reach a reply —
computed, retrieved from your offline library, remembered from earlier in the conversation, and
researched from the web — and until this release only the first two were checked against the
evidence they came from. v1.9 closes both gaps: the research brief is now verified against the
pages it was written from, and the conversation ledger records the *decisions* you made alongside
the facts. Pinned by 1,360 node checks, and every claim below carries a measurement — including
the ones that came out null.

## Deep research under the grounding ladder

- **The gap, stated plainly.** `deep_research` writes its brief with a model, from the passages it
  read. That brief then becomes *tool output* — and every downstream check trusts tool output as
  its corpus. So a figure the synthesizer invented passed tool grounding, passed the recompute
  check, passed the claim check, and reached you wearing a citation. The evidence to catch it was
  sitting in the tool's own memory. Nothing looked.
- **The check.** Mechanical, inside the tool, before the brief leaves it: every figure, every
  measurement (a dose, a duration, a temperature — the dangerous class) and every `[n]` citation
  in the brief must appear in a passage the run actually read. Roundings pass. A citation to a
  source the run never read is a **fabricated reference**, and is caught as one. Findings go back
  to the synthesizer for one revision, kept only if strictly better; what remains is disclosed
  first among the tool's notes, so an unsupported specific reaches you *flagged* rather than
  laundered into a finding.
- **A real bug it surfaced.** Instrumenting a research run phase by phase showed 50 of 112 seconds
  spent on two replan rounds that re-asked a sub-question the search provider had already answered
  "nothing" — each replan a full model call taken out of the time left to write the brief. A round
  that finds no new sources now ends the loop and writes from what it has. The same run afterwards:
  one round, six pages, 92 seconds.

## The ledger remembers decisions, not just facts

- **Decisions.** Alongside computed figures, files and your stated constraints, the ledger now
  records the choices you make — *"use the median rather than the mean"*, *"go with the West
  region"* — verbatim, in your own words. Later decisions supersede earlier ones on the same
  subject, because *"actually, use the mean"* is what you now want and a record that still says
  "median" is worse than none.
- **Measured where it matters.** A long-regime case states two decisions, buries them under six
  off-topic turns, and then — with the establishing turn compacted out of the model's context by
  the app's own history planner — asks for them back. Nothing is recomputable, so there is no
  fallback. Three passes: **ledger 3/3, bare 0/3.** With the ledger: *"You chose to use the median
  rather than the mean for every summary statistic, and you selected the West region as the
  focus."* Without it: *"Nothing yet — I haven't loaded any CSV or computed anything."*
- Python session state now reaches the model from the second turn, so a follow-up can build on the
  dataframe already loaded instead of re-deriving it.

## Two null results, reported as such

This project's rule is that a measurement decides, including when it disagrees with the feature.

- **The research check flagged nothing on a clean corpus.** Across 24 briefs the 9B synthesizer,
  told to cite only from numbered sources, invented nothing — so the rung had nothing to catch.
  Its value is in the regime the suite does not reach (thin or contradictory sources), where it is
  now *measurable*, and its unit tests pin what it catches.
- **Telling the model it already has the data does not stop it re-reading the file.** With the
  session variables named in front of it and an explicit instruction, a 9B still re-read on 73% of
  follow-ups (67% with prompting alone — no difference). Reading the code it ran explained why:
  pandas had cached the read, so the habit costs 22 milliseconds. Prompting and a mechanical nudge
  have both now been measured against it; neither moves it, and the notes say so instead of trying
  a third thing until one flatters.

Both are in [`docs/evals.md`](https://github.com/CELCPG/SigmaOasis/blob/v1.9.0/docs/evals.md),
along with the two bugs the research suite caught — one in the app, one in the eval's own scoring
(a decoy pattern that flagged a *correct* brief, the same class of error as v1.6's
"Never thaw on the counter").

## Upgrade notes

Auto-update from v1.8.x or earlier. No settings changed; the research check is part of
`deep_research` and the ledger's decisions are part of the ledger, both on by default with the
existing off switches (Settings → Models).

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.8.1...v1.9.0
