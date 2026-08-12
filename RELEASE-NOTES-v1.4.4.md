# Sigma Oasis v1.4.4

Deep research works on reasoning models. v1.4.1 claimed to fix this and did not — the switch it used turns out to do nothing at all, which only became visible once somebody measured it. Pinned by 956 checks, 2 of them new.

## Deep research actually produces a brief now

- **What was still broken.** On a reasoning model, planning and synthesis were spending their entire token budget on chain-of-thought and returning nothing. v1.4.1 was supposed to fix that by asking the server to turn thinking off. It asked; nothing listened.
- **Measured, not assumed.** Against qwen3.5-9b-mlx in LM Studio, eight different ways of asking — `chat_template_kwargs`, `reasoning_effort`, `template_kwargs`, a top-level `enable_thinking`, `/no_think`, `/nothink` — all produced byte-identical output to sending nothing: the whole budget spent deliberating, zero answer.
- **What works instead.** The assistant's turn is prefilled with a thinking block that is already closed, so the model resumes after it rather than opening one. The research planner went from an empty reply to a valid plan, and the synthesis brief from empty-after-36-seconds to a cited brief in 6.4 seconds.
- **Why a bigger budget was not the answer.** At 1,200 tokens this model produced 4,751 characters of deliberation and still no answer; it only got there at 2,000, after 69 seconds. Thinking length does not converge, so there is no budget both large enough to always contain it and small enough to be worth waiting for.
- **Scoped to the models it fits.** Only families whose thinking is delimited by `<think>` tags. Gemma 4 is deliberately excluded — it marks thinking with its own control tokens, and handing it another family's tags would put literal markup in your answer rather than suppress anything.
- **This affects planning, query reformulation, brief synthesis, conversation summarization and plan generation** — the calls whose output is parsed or filed rather than read as it arrives. Your chat replies are untouched: when you talk to a reasoning model, it still thinks, and you still see it.

## Measured, for the record

The prompt-prefix work in v1.4.1 was also never verified. It is now, across two runs with the condition order reversed to rule out warmup effects — same conversation, same token counts, only the placement of the app's per-turn additions differing:

| turn | prompt tokens | v1.4.0 placement | v1.4.1 placement |
| --- | --- | --- | --- |
| 1 | ~1,200 | 4,398ms | 4,738ms |
| 4 | ~2,600 | 9,997ms | 9,092ms |
| 6 | ~3,550 | 14,658ms | 5,535ms |
| 8 | ~4,490 | 15,452ms | 8,528ms |
| 10 | ~5,460 | 18,315ms | 5,149ms |

**Time-to-first-token on turns 4–10 is 44–50% lower.** Two things are worth being straight about: the gain is invisible for the first two or three turns, where the old placement is marginally faster and the difference is noise; and the improved figures vary turn to turn, so cache reuse is partial rather than guaranteed.

## Upgrade notes

- **macOS:** signed and notarized — no Gatekeeper dialog. Both Apple Silicon and Intel DMGs are attached. Also available via Homebrew: `brew tap CELCPG/tap && brew install --cask sigma-oasis`.
- **Windows:** the installer is unsigned, so SmartScreen will warn. Expected; proceed with "More info → Run anyway".
- **Auto-update:** if you're running v1.4.3, this release appears as an update automatically. Recommended for anyone using deep research with a reasoning model.
- **No settings migration needed, and no new configuration.**
- **Nothing new leaves your machine.** This changes the shape of requests already being sent to your own server.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.4.3...v1.4.4
