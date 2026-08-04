# Sigma Oasis v1.3.0

Models can now show you a picture, and the app is stricter than before about the two ways that could have gone wrong: pictures that arrive by handing your address to a dozen strangers, and words the model writes about things it never actually retrieved. Every claim below is pinned by the test suite (860 checks, 110 of them new).

## The model no longer gets the last word on numbers it didn't compute

Three real sessions were audited before this release. In one of them a user asked what a used Corolla would cost with $5,000 down. `finance_calculator` ran and returned **$396.02/month**. The reply told them **$293.50/month** — along with an interest total, a second payment figure, and a second interest total, none of which the calculator produced and none of which were correct. That is the failure this release is mostly about.

- **Figures a tool didn't return are flagged, mechanically.** After every turn the app compares the money figures in the reply against the output of the tools that actually ran, plus your own messages. Anything with no backing gets a warning under the answer naming the figures and what they were checked against. No model call, no network — it is string and number comparison, so it cannot be talked out of it.
- **Links a search didn't return are flagged the same way.** The audited sessions included a product page URL built by taking a real collection link and appending a plausible path. It resolved to nothing. A link that appears in no tool result now says so.
- **`finance_calculator` asks for the right number.** Its schema said `principal` was the "loan amount", which a model reasonably read as the sticker price. It now says: the amount actually borrowed, after any down payment or trade-in — and the tool's own output restates the loan amount and tells the model to report its figures verbatim rather than adjusting them.
- **Shopping turns are priced, not remembered.** `looksLikeShopping()` mirrors `looksFactual()`: on a purchase turn the app runs `shop_compare` itself before the model answers, so there are real extracted prices to write around. When the shopping tools are switched off (they ship that way — they contact commercial sites), the model is told plainly not to state prices it has no source for, and any price that appears anyway is flagged.

## Searches stop leaking the conversation around them

- **A query that is a paragraph about you is refused before it is sent.** One audited session put an entire message — business trip, destination, travel dates, what the user planned to buy — into a search query verbatim, under a schema that says to send terms only. Long, sentence-shaped, first-person queries are now rejected in code, with a message telling the model to send the subject instead. It calls again with real terms; nothing leaks in the meantime.
- **Ordinary framing is stripped rather than bounced.** "i'm looking for a thong made from organic cotton" searches for the thong. "best noise cancelling headphones for my flight to Lagos" searches for the headphones — the flight is not the search provider's business. Keyword queries pass through byte-for-byte, untouched.

## Long model calls stop throwing away finished work

- **Timeouts scale with what the model was asked to write.** A single 120-second limit governed every main-process call, from a 400-token query rewrite to a 1,400-token research brief. On laptop-class hardware the brief does not finish in that, so a research run that had already fetched and ranked eight pages across seven domains reported "Synthesis failed" and returned nothing — after three minutes of successful work. The allowance now derives from the requested token budget, with a floor and a ceiling.
- **Research reserves time to actually write the answer.** Retrieval used to spend the entire wall clock and leave synthesis none. Each depth preset now holds back a slice for the write-up, and gathering stops early on purpose: fewer sources, but an answer.
- **A failed write-up keeps the sources.** Synthesis streams, so a timeout returns the paragraphs already written rather than discarding them. If nothing survives, the run still returns its ranked, cited sources — labelled as retrieved-but-not-synthesized, with the model explicitly told not to summarize them from memory.

## Transcripts you can actually audit

- **Exported tool results are no longer cut at 200 characters.** That truncation removed the search results a reply was built on, which made an exported conversation useless for telling a grounded answer from an invented one — the exact check the export exists to support. Results are now fenced and complete (capped at 6,000 characters), with the tool's arguments recorded alongside, and the grounding and unverified warnings carried into the file.

## Image search, without handing out your address

- **`image_search` shows thumbnails in the chat**, each one clickable through to the page it came from. It uses the same provider you already chose for web search (SearXNG, Brave, or DuckDuckGo) and the same query sanitization — emails, tokens and paths are redacted before anything is sent.
- **The pictures are fetched by the app, not by the chat window.** The renderer's CSP allows `data:` images only, so a thumbnail is fetched in the main process, downscaled to 320px, and inlined. That puts every image request behind the SSRF guard, through your proxy if one is configured, and into the network activity log — carrying no cookies, no referrer and no browser fingerprint.
- **The confirmation dialog says what actually leaves.** With "confirm before searching" on, an image search gets its own prompt: it names the query *and* the thumbnail fetches that follow, and states plainly that those hosts see your IP address unless a proxy is on. A consent prompt that understates what comes after it is worse than no prompt.
- **Image-host contact is labeled `image` in the activity log**, distinct from `webpage`. "A CDN we contacted to draw a gallery" is a different disclosure from "a page you asked to read," and the log now tells you which.
- **Budgeted like every other egress tool** — two image searches per turn, six images per search, capped total gallery size. One call reaches more third parties than any other tool in the app, so it carries the tightest budget.

## Follow-ups search for what you were actually talking about

- **"lets go with the gold one" no longer searches for gold bullion.** A short follow-up that leans on the conversation — a continuer, an ordinal, "number 2" — now carries the previous message's subject into the query. A search provider has never seen your chat; a query built from the follow-up alone comes back about something else entirely.
- **Deliberately narrow.** Anchoring doubles what a query discloses, so it only fires on genuinely terse, genuinely back-referring messages. A question long enough to stand on its own is never anchored, however many pronouns it contains — "how tall is the Eiffel Tower and when was it built?" goes out exactly as written.

## Tools that fail say so

- **Every tool-failure path now names the gap.** A failed search, an empty result set, a budget stop, a research run that came back short — each tells the model to state plainly what it could not verify, and never to fill the hole with an invented product, brand, price or source. This is the v1.1 doctrine applied to the moment it matters most: the moment there is nothing to ground on. Where that wording proves insufficient — and on a 12B model it does — the mechanical checks above catch what gets through.
- **Image results the app could not display are marked as such**, and the model is told not to number or describe them. The numbering the model cites is now the numbering you see.

## Assistant defaults

- The default assistant prompt now leads with the answer, treats a short follow-up as part of the conversation rather than a new question, and does not assume your gender, age, body or life situation — it asks when that would change the recommendation.
- New starter prompts: basic first aid training, and home repair walkthroughs.

## Upgrade notes

- **macOS:** signed and notarized — no Gatekeeper dialog. Both Apple Silicon and Intel DMGs are attached. Also available via Homebrew: `brew tap CELCPG/tap && brew install --cask sigma-oasis`.
- **Windows:** the installer is unsigned, so SmartScreen will warn. Expected; proceed with "More info → Run anyway".
- **Auto-update:** if you're running v1.2.1, this release appears as an update automatically.
- **No settings migration needed.** `image_search` arrives enabled, alongside `web_search`; turn it off under Settings → Tools if you would rather the app never contact an image host. Everything else — model slots, temperatures, privacy settings — is untouched.
- **Worth knowing about image search:** which hosts serve the thumbnails depends on your search provider. On DuckDuckGo they come from Microsoft's Bing CDN (`tse*.mm.bing.net`) rather than the sites the images live on — one company sees the whole gallery. The network activity log lists every host, per search. Details in [SECURITY.md](SECURITY.md).

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.2.1...v1.3.0
