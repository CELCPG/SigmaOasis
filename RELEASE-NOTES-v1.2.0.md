# Sigma Oasis v1.2.0

This release is about competence, measured: a local model that picks the right tool with the right arguments, hands work to the right slot, repairs its own malformed calls — and a shopping research layer where the only party who knows what you're looking at is you. Every claim below is pinned by the test suite (731 checks) or scored on the live eval harness.

## Tool calling that works on laptop-class models

- **The tool loop is now a real state machine.** Tool calling moved out of the chat hook into a tested loop with three new guards: malformed arguments get a named repair round instead of executing as `{}`; the same call with identical arguments reuses its result instead of re-running; and per-tool turn budgets stop runaway search loops — each refusal tells the model to answer from what it has.
- **Pre-flight routing in code.** Turns are classified before they run — image, code, finance, factual — and sent to the right model slot, with the reason shown on the reply ("routed to Coder — fenced code detected"). A routing choice you can't see is one you can't correct, so every one is visible.
- **A measured eval harness, in-app and CLI.** Settings → Models → **Run eval** scores any loaded model on tool choice against 19 fixtures (correct-tool, spurious-call, arg-validity, loop rates), and scores fold into the model picker. The CLI runs the identical runner.
- **Fine-tune call formats parsed.** Some agentic fine-tunes emit calls as `<call>name{json}</call>` markup or as bare JSON blobs in the reply text instead of structured tool calls. All three formats now parse into real executions — malformed drops, and a bare argument object is never guessed into a call. On the Gemma 4 4B agentic fine-tune this lifted measured correct-tool rate from **56% to 75%**; the 12B QAT scores 100%.
- **Weak endings earn an escalation offer.** When a turn ends unverified, contradicted, or capped out of tool rounds, the reply offers a one-click re-run on a bigger slot — an offer, never a silent model swap.

## Private shopping research

- **Compare sellers without being watched.** `shop_compare` extracts the product from a URL, searches across sellers, and prices them side by side — through the proxy when you require it, with tier-X (worst-privacy) sellers excludable by default.
- **A price watchlist that tells nobody.** `price_watch` keeps your watched items in a local file on this machine. No account, no tracker, no list held by anyone else.
- **Structured requirements first.** `shop_requirements` turns "I need a quiet air purifier for a 40 m² bedroom under $300" into a checklist the comparison is scored against, so the answer addresses your constraints instead of a generic ranking.

## Fine-tuning traces, labeled from outcomes

- **Export your own SFT data.** Settings → Privacy → **Export traces (SFT)** turns the encrypted audit log into OpenAI-format JSONL: user request, tool calls with arguments, tool outputs, final grounded reply. Redaction (URLs, paths, emails, IPs, key-shaped tokens) runs on every field before anything is written; ephemeral chats never reach the log, so they can never reach a trace.
- **Labels come from outcomes, not vibes.** A trace exports as positive only when the turn mechanically ended well — no tool errors, a final answer, and every checked claim confirmed. Errored, capped, or contradicted turns export to a separate rejected file (the rejected half of preference pairs); anything unsettled is excluded. Each export is stamped with a content hash of the tool schemas so stale traces are detectable. Training recipe in `docs/trace-export.md`; train out of band, then score the result with the eval harness.

## Claim check (the v1.2 roadmap item, shipped)

- **The critic's list gets settled, not just named.** Unverified answers now trigger a mechanical per-claim pass: the critic extracts bare factual claims, the app runs one search plus at most one fetch per claim, and a judge settles each against the retrieved passage — **confirmed / contradicted / unverifiable**, with the source shown. No source within budget means "unverifiable," never a verdict from model intuition.
- **Temperature presets.** Sampling presets in Settings → Models; built-in roles default to 0.3. Existing installs keep their saved temperatures.

## Upgrade notes

- **macOS:** signed and notarized — no Gatekeeper dialog. Both Apple Silicon and Intel DMGs are attached. Also available via Homebrew: `brew tap CELCPG/tap && brew install --cask sigma-oasis`.
- **Windows:** the installer is unsigned, so SmartScreen will warn. Expected; proceed with "More info → Run anyway".
- **Auto-update:** if you're running v1.1.0, this release appears as an update automatically.
- **No settings migration needed** — model slots, temperatures, and tool toggles are untouched; new settings (claim check, shopping privacy defaults) arrive with sensible defaults.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.1.0...v1.2.0
