# Sigma Oasis v1.1.0

This release takes direct aim at the failure mode local models are worst at: confidently inventing plausible-sounding facts. Small models rarely volunteer a web search — they answer from genre tropes instead — so v1.1 removes the option to confabulate rather than just discouraging it. Plus a rebuilt chat scroll that keeps generation stable and above the composer.

## The grounding layer: anti-hallucination, built in

- **Automatic verification on factual questions.** When your message looks like a factual lookup — albums, companies, dates, prices, people — the app runs a `web_search` itself before the model answers and injects the results as labeled, untrusted reference context. It appears as an ordinary tool call, respects your **Confirm before search** setting, and never blocks the reply if search fails.
- **⚠️ Unverified badge.** A factual-looking answer that consulted *no* web source — search declined, failed, or disabled — is exactly the confabulation signature. Those replies carry an amber warning: "Answered from model memory — no sources consulted. Treat names, dates, and numbers as unverified."
- **Automatic second opinions.** Flagged answers also trigger the Second Opinion critic on their own (when second opinions are enabled and a second role exists): a *different* role names the specific claims it couldn't verify and the one check that would settle each. Auto-reviews are marked with an "auto — unverified answer" chip so you can tell them from ones you requested.
- **Grounding rules on every turn.** Each system prompt now carries today's date plus short, explicit rules: verify or say you don't know, never invent a plausible title or date, and flag a question's false premise instead of playing along. Applies to chat turns, specialist consultations, and plan mode.
- **Calmer defaults for factual roles.** New Assistant and Researcher slots default to temperature 0.3 instead of 0.7 — pure recall at high temperature measurably increases confabulation on small models. **Existing installs keep their saved temperatures**; lower yours under **Settings → Models** to get the same effect.

## Cleaner scroll and generation

- **Stable streaming.** The message list now scrolls instantly as tokens arrive instead of restarting a smooth-scroll animation on every chunk — the old behavior never caught up and read as text sliding away under the input box.
- **Pin-to-bottom, yours to override.** Auto-scroll follows only while you're near the bottom. Scroll up to read and the stream leaves you alone; scroll back down or send a message to re-pin. A floating **↓ New messages** pill jumps you back to the live edge.
- **Breathing room.** The newest line now comes to rest visibly above the composer instead of flush against it.

## Upgrade notes

- **macOS:** signed and notarized — no Gatekeeper dialog. Both Apple Silicon and Intel DMGs are attached.
- **Windows:** the installer is unsigned, so SmartScreen will warn. Expected; proceed with "More info → Run anyway".
- **Auto-update:** if you're running v1.0.1, this release appears as an update automatically.
- **No settings migration needed** — saved model slots, temperatures, and tool toggles are untouched.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.0.1...v1.1.0
