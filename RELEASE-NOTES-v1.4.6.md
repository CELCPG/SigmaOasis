# Sigma Oasis v1.4.6

Up to now the app got steadily better at *noticing* when an answer contained something invented, and no better at producing an answer that didn't. This release changes that: a flagged answer is sent back to be fixed, and two whole classes of question the toolbox simply could not answer — dates and distances — now have tools that answer them exactly. Pinned by 1,083 checks, 51 of them new.

## An answer that fails the check gets corrected, not just labelled

- **The findings go back to the model.** When the grounding check finds an address that appears in no search result, a price nothing supports, or a phone number assembled from a brand name, those specific items are handed back for one revision — with the tools still available, so the first option is to *verify* a flagged detail rather than delete it.
- **A revision is kept only if it actually helps.** This is the part that makes the pass safe. Asked to fix an itinerary with two invented addresses, the model returned the same table with two *different* invented addresses and a line claiming the rest had been "verified against search results" when nothing had run. The instruction forbade exactly that. So a revision is now adopted only when a re-check finds strictly fewer faults than before; otherwise the original stands, flagged. **The answer you read is never worse than the one the model first produced.**
- **The revision is disclosed.** The reply is marked as revised, with a count of what was sent back. An answer the app quietly edited would be the same failure every other check here exists to prevent.
- Settings → Second opinion → "Correct unsupported specifics", on by default. It costs one extra round, and only on answers already known to contain unsupported specifics.

## Dates are computed, not guessed

- **A new date calculator** answers day-of-the-week, relative phrases like "next Saturday" or "in three weeks", and the span between two dates. Exact, local, no network.
- **Why it exists:** four sessions failed on dates, and in none of them did the model call the existing clock tool, which was on the turn every time. "What day is October 1st 2026" became a six-step plan that ran for twenty minutes and searched the web twice for a day of the week. "Next sat and sunday", asked on a Friday, produced a Monday in one step and that same Friday in the answer.
- **"Next Saturday" is genuinely ambiguous in English**, so the tool gives the common reading and states the other one rather than choosing silently — the difference between booking the right weekend and the wrong one.
- It takes the always-on tool slot the old clock tool held, because a tool that can answer the question is only useful if it is present when the question is asked. The clock tool remains available.

## Places and distances

- **A new location tool** finds where a place is, measures between two, and puts a list of stops in a sensible order, using OpenStreetMap.
- **Why it exists:** "the highest rated restaurants within a 10 minute walk of Penn Station" was answered with a list and no distance behind any of it; "the closest Michelin restaurants" produced a table of invented ride times beside invented addresses. Checked against live map data, the tool returns Carbone at 181 Thompson Street where the answer had said 70 Central Park South.
- **Distances are straight-line and say so.** Walking estimates apply a stated detour factor and are labelled approximate. **Driving and ride-hail times are refused outright** — traffic decides them, and a number invented by a formula is no better than one invented by a model. Stop ordering is nearest-neighbour and labelled as such, not as optimal.
- **A place lookup says where you are going**, which is at least as revealing as a search query. It gets its own network purpose with a single named host — never a wildcard — appears in the activity log, follows your proxy, and respects the map service's rate limit. Lookups are cached for the session.

## The source check was flagging the wrong half of the web

- **Publications are no longer marked as content farms.** A session searching for restaurants marked Time Out and Eater as search-bait in three consecutive result sets, while the menu-price aggregators alongside them went unmarked. The listicle heuristic is a good signal on an unknown domain and a bad one on a magazine, because that is simply how service journalism is titled. Real publications are now recognised and left unmarked — a narrower claim than "trustworthy", and deliberately so.
- **Aggregator domains named after the query they rank for are caught.**
- **A rating body is now primary for its own ratings.** Five searches in that session failed to establish Michelin stars while the official guide sat unmarked in every result set.

## Smaller fixes with real consequences

- **A blocked page now explains itself.** Two supermarket store-locator pages returned a bare `HTTP 403`; the model read that as "unreachable" and wrote the addresses from memory. The 403 was correct and the app caused it — web traffic was going through a proxy that those hosts refuse. Refusals now name the proxy as the likely cause and say not to fill the gap from memory. There is deliberately no retry without the proxy: quietly stepping around a privacy setting is how it becomes worthless.
- **A plan can use tools at its final step.** The synthesis ran with no tools at all, so when the steps came back thin the model emitted a fake `google_search(...)` call in a code fence as though that were a tool. That was the entire visible answer to one request.
- **A plan no longer talks about itself.** Answers opened with "Step 1 returned no results and Step 3 lists Spring Lake" — a reference to a document you never saw.
- **A truncated reply says it was truncated.** Nothing read `finish_reason`, so a reply cut off at the token cap looked exactly like a finished one.
- **Reply length is now a choice** — Brief, Standard, Long, Unlimited — beside the raw token field. One measured reply ran for seven and a half minutes with nothing bounding it.
- **Route and store questions can earn a source.** A turn naming five retail chains read as non-factual, so nothing searched and the reply could never be flagged; it opened by asserting a chain had closed permanently, with no tool call, and substituted a company that went bankrupt in 2020.

## Upgrade notes

- **macOS:** signed and notarized — no Gatekeeper dialog. Both Apple Silicon and Intel DMGs are attached. Also available via Homebrew: `brew tap CELCPG/tap && brew install --cask sigma-oasis`.
- **Windows:** the installer is unsigned, so SmartScreen will warn. Expected; proceed with "More info → Run anyway".
- **Auto-update:** if you're running v1.4.5, this release appears as an update automatically.
- **Two new tools ship enabled** (Settings → Tools). The date calculator is entirely local and contacts nothing. The location tool contacts OpenStreetMap and only OpenStreetMap, and every lookup is in the activity log.
- **No settings migration needed.** The new correction pass defaults on and can be turned off; everything you have configured is untouched.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.4.5...v1.4.6
