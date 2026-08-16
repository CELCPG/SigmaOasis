# Sigma Oasis v1.5.1

Two ways a small model gets more from itself, both disclosed under the reply, plus a relevance floor the Almanac turned out to need. Pinned by 1,216 checks (20 new); think-harder verified in the built app with a 9B model.

## 🧠 Think harder — draft, review, revise, once

- **What it does.** Toggle 🧠 in the composer for the next message, or press *🧠 Think harder* under any reply. The reply becomes a draft; a **different role** reads it as a strict reviewer and lists concrete problems — arithmetic errors with the correct value, missing or misordered steps, unsupported claims, contradictions; the answerer revises once with that list. The revision replaces the draft; the bubble says what happened (**🧠 Deliberated — reviewed by Reviewer, revised. Figures changed: 381 → 391.**) and shows the review and the original draft on demand. No confidence scores, ever.
- **With one role enabled**, the same model reviews its own draft — weaker, always labelled *reviewed its own draft*, and switchable off (Settings → Models). It is still worth having: the structure of "read it as a list of problems" catches what a single pass misses. **Measured in the built app** with a 9B model on an arithmetic question: the draft went wrong (it answered about the reference library instead of the sum); the self-review said *no working shown, no final answer*; the revision gave the working and the right change ($6.40). That is the feature paying for its two extra calls.
- **Bounded.** One review, one revision, both length-capped; a review that finds nothing keeps the draft and says so; an empty revision keeps the draft; Stop stops it. It runs only on a finished reply, never inside a tool loop.

## Model profiles — what the app knows, said plainly

- Under each model in Settings → Models: **Profile: Qwen3 · 9B · reasoning · tools: reliable (prior)** — family, size parsed from the id, whether it thinks out loud and how the app handles that, whether a published sampling recipe applies, and how well it calls tools. Tool calling is **measured** when you have run the tool-choice eval, otherwise a stated **prior** from family and size — and the line says which. Details on hover. The four places the app already carried this knowledge (reasoning splitter, closed-think prefill, sampling recipes, eval harness) now feed one description.

## The Almanac learned to say "nothing relevant"

- Retrieval scores are normalized within a result set, so a lone weak match read as 1.00 — and in testing a first-aid passage was handed to the model for a shopping-arithmetic question that happened to mention tax. A **relevance floor** now requires a passage to share strong query terms (or clear a semantic threshold) before it counts; otherwise the lookup says *no passage matched closely enough* and nothing is injected.

## Upgrade notes

- **New setting, on by default:** *Think harder may use self-review* (Settings → Models). Nothing else to configure.
- **Auto-update** from v1.5.0. **macOS** signed and notarized; **Windows** unsigned (SmartScreen will warn).

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.5.0...v1.5.1
