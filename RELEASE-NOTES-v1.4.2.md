# Sigma Oasis v1.4.2

A one-line fix for a bug that made v1.4.1 slower than v1.4.0 on some machines. If your model was being ejected and reloaded in LM Studio on every single reply, this is that. Pinned by 938 checks, 2 of them new.

## The model stops reloading on every reply

- **What you saw.** LM Studio unloading and reloading your chat model between every message — several seconds of dead time per turn, a fresh model process each time, and none of the speed v1.4.1 was supposed to deliver.
- **What it was.** Sigma Oasis asks LM Studio to load the chat model explicitly, because a model loaded that way is exempt from auto-evict, while a just-in-time load is not. Some LM Studio builds answer a route they do not have with **HTTP 200 and an error in the body** rather than a 404 — the server's own log reads "Unexpected endpoint or method. Returning 200 anyway". The app read the status, concluded the model was pinned, and never tried the older load endpoint that would have worked. The model stayed just-in-time loaded, so the next embedding call — long-term memory recall, or per-turn tool ranking — evicted it, and the next message loaded it again.
- **The check for this existed and could never run.** It had been in the code since v1.3, sitting three lines below the status check that returned first. The test harness only ever simulated the 404 spelling of a missing route, so nothing caught it. It simulates both now.
- **Why it hit v1.4.1 hardest.** LM Studio's prompt cache is scoped to the model load — reloading the model discards it. v1.4.1's main change was making the prompt prefix stable so that cache could be reused across turns, so on an affected machine the release threw away the exact thing it had just built, on every turn. Time-to-first-token got worse, not better.
- **Nothing else changed.** No new behavior, no settings, no prompt changes. If v1.4.1 has been running well for you, this release changes nothing you will notice.

## If it still happens

The pin deliberately leaves an already-loaded model alone: LM Studio has no way to promote a just-in-time load into a manual one, and asking it to load a model twice starts a second copy. So a model that something else loaded first can still be evicted. Two reliable setups:

- Load the model yourself in LM Studio before using the app — a manual load is exempt from auto-evict.
- Or turn off auto-evict in LM Studio's settings, which exempts everything.

## Upgrade notes

- **macOS:** signed and notarized — no Gatekeeper dialog. Both Apple Silicon and Intel DMGs are attached. Also available via Homebrew: `brew tap CELCPG/tap && brew install --cask sigma-oasis`.
- **Windows:** the installer is unsigned, so SmartScreen will warn. Expected; proceed with "More info → Run anyway".
- **Auto-update:** if you're running v1.4.1, this release appears as an update automatically. Recommended for anyone on v1.4.1.
- **No settings migration needed.** Nothing in this release touches your configuration.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.4.1...v1.4.2
