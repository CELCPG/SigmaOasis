# Sigma Oasis v1.4.5

The model stops reloading between prompts, and the checks that catch invented facts now cover the kind of work people actually bring to this app: prices, addresses, phone numbers, and where a company is from. Everything here came from reading real server logs and real transcripts, not from imagining what might go wrong. Pinned by 1,007 checks, 45 of them new.

## Your model stays loaded

- **The fix v1.4.2 was supposed to be.** That release corrected what happens when the app pins your chat model in LM Studio. It turned out the pin was never firing at all: "already loaded, nothing to do" was remembered as though it were a real pin, so the app checked once at startup, found the model resident, and never looked again. A just-in-time loaded model is evicted the moment the embedding model loads — which happens on every turn that recalls memory or ranks tools — and nothing ever re-pinned it.
- **What that cost.** A full model reload per prompt: several seconds of dead time, and a discarded prompt cache each time, since the cache lives and dies with the model load. The v1.4.1 work on prompt reuse could not survive it.
- **Duplicate embedding calls are gone.** Every prompt was making two byte-identical embedding requests — memory recall and tool ranking asking for the same vector, made simultaneous by v1.4.1. Identical in-flight requests now share one call.

## A hung server no longer holds you for five minutes

- **Slow and dead looked the same.** One deadline governed the whole request, so it had to be generous enough for a slow model — and a server that died at second one was held for exactly as long. Streaming requests now watch for tokens arriving, and cut a connection that goes silent. The clock starts only after the first token, because the silence before it is the model reading your prompt and is legitimately long.
- **The estimates behind the deadline were recalibrated** against measurement rather than guesswork. The old generation figure was three to six times pessimistic, and the prompt allowance was a flat minute regardless of size — too generous for a one-line question, too short for a long conversation, and invisible because everything hit the ceiling anyway.

## Tools stop being chosen at random

- **A one-word turn cannot rank tools, and now doesn't try.** Measured: for a reply of "1", the top tool candidates are separated by 0.014 — a coin flip. Acting on it put three different irrelevant tools on three consecutive turns of one conversation, including a directory browser during a sales-deck discussion. Rankings now have to actually discriminate before the toolbox changes, which also stops the tool list churning and taking the prompt cache with it.
- **Tools say how often they can be called.** The per-turn budgets were enforced but never stated, so the only way to learn one was to be refused. In one measured turn, seven of twelve calls were rejected across three wasted rounds — and the answer that followed filled the resulting gaps from memory. Each tool now carries its budget in its own description.

## The checks cover business work now

- **Prices are checked whenever a reply states several**, not only when the app recognizes the turn as shopping. A member-facing email full of invented per-bottle prices previously went out unexamined because "email campaign copy" did not read as commerce.
- **Arithmetic on a known price counts as sourced.** Told a unit cost, a reply computing the case cost was being flagged as fabrication — the badge reporting its own correct work, which is exactly how a warning gets ignored on the turn it matters.
- **Contradicted geography is reported.** When the sources establish where something is from and the reply says somewhere else, you are told. Measured: ten search snippets saying "Spain" and a pitch deck describing "French spa water" with an outreach email promising "direct import from France".
- **Invented phone numbers and email addresses are reported.** From member-facing copy: "call Member Services at 1-800-SAM'S-CUB" — not the company's number, not a number at all, assembled from the shape of the brand name.
- **Invented street addresses are reported.** From a sales route: three of seven stop addresses appeared in none of the search results the same turn had collected, including one for a store whose every search had been refused. The addresses that were real had been quoted verbatim — the model could quote, and filled the gaps instead.

## Margin math the model should not do in its head

- **`channel_margin` joins the finance calculator.** Margin is taken on the selling price, markup on the cost, and a 20% margin is a 25% markup. Told "Costco works off a 15% GM", the model applied that percentage to a landed cost as though it were its own margin and printed the answer as the shelf price — a supplier quoting from that leaves the retailer nothing. The calculator now reports landed cost, wholesale, shelf price and what each party keeps, naming margin and markup separately at every step.

## Plans can see the conversation they came from

- **Planning received your message and nothing else** — no history for the planner, none for any step, none for the final synthesis. On a follow-up that is the entire task. Asked to "update to the proposed route 8 stops" one turn after proposing an 8-stop route, every step reported missing input data and the answer asked the user to supply the route the assistant had written a minute earlier. All three stages now receive the conversation.

## On how these were found

Four of the fixes in this release contain a second bug found only by replaying real transcripts and server logs through the finished code — a false positive that flagged a competitor's brand as a geography error, a derivation rule that certified invented prices as legitimate, a phone-number pattern that matched ordinary prose, and an address pattern that swallowed the line above it. In each case the tests written alongside the fix agreed with the bug. The tests that pin them now say so.

## Upgrade notes

- **macOS:** signed and notarized — no Gatekeeper dialog. Both Apple Silicon and Intel DMGs are attached. Also available via Homebrew: `brew tap CELCPG/tap && brew install --cask sigma-oasis`.
- **Windows:** the installer is unsigned, so SmartScreen will warn. Expected; proceed with "More info → Run anyway".
- **Auto-update:** if you're running v1.4.4, this release appears as an update automatically. Recommended for everyone — the reload fix affects every prompt.
- **No settings migration needed, and no new configuration.**
- **Nothing new leaves your machine.** The new checks read text the app already has; deep research contacts fewer hosts than before, not more.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.4.4...v1.4.5
