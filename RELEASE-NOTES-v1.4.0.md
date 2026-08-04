# Sigma Oasis v1.4.0

Four features that mostly buy back time: repeated questions answer instantly, the keyboard reaches everything, a reply you want to redo no longer costs you the conversation, and a conversation whose middle used to disappear now keeps a record of what left. Pinned by 887 checks, 27 of them new.

## Asking the same thing twice stops costing the same time

- **A repeated question comes back from cache.** Same conversation, same model, same wording — within five minutes the answer replays immediately instead of being regenerated. On laptop-class hardware that is the difference between a several-second wait and none.
- **It never caches anything that was retrieved.** A turn that called a tool is never cached, in either direction. Search results, prices and the clock are time-varying by definition, so replaying one could restate last week's figure as today's — the exact failure mode v1.3 was mostly about. Text answers only.
- **Regenerate always regenerates.** Pressing ↻ replays a byte-identical conversation, so a naive cache would hand back the very answer you just rejected and look broken. Regenerate and escalation both bypass the cache outright — asking again is the one case where you have explicitly said you want something different.
- **The verification passes stay live.** The second opinion, the claim check, specialist consultation and plan steps all run through the same streaming path as an ordinary answer. None of them cache. A cached verdict would re-verify nothing while still reporting that the check ran, which is worse than not checking at all.
- **Cache hits report no token counts.** A replayed answer generated nothing, so it records no tokens and no time-to-first-token rather than repeating the original measurements. An invented figure in a trace export is indistinguishable from a measured one, which makes it worse than a blank.
- **RAM only.** Nothing is written to disk, so a cached reply cannot outlive the session or reappear in `conversations/`. Ephemeral chats stay ephemeral.

## A conversation that outgrows its window keeps a record of what left

- **A failed summarizer no longer costs you the middle of the conversation.** When a chat exceeds the model's context window, older messages are folded into a rolling summary. That fold is itself a model call — and when it failed, timed out, or landed mid-model-swap, the app kept the *previous* summary and dropped the newly compacted messages with no record that anything had gone. The conversation lost its middle silently.
- **There is now a local fallback.** If the summarizer is unavailable, a mechanical digest records what was dropped: the questions actually asked, the topics covered, how many code blocks appeared, and which tools ran. No model call and no network, so it cannot fail in turn. It is plainly worse writing than the model's summary and is labelled as such in the summary chain — the point is that a failure degrades to a thin account instead of to nothing.
- **A digest of nothing records nothing.** If there was no usable text in the dropped span, the app keeps the old summary and leaves its position untouched, rather than marking those messages as covered by an empty note. The next compaction can still reach them.
- **The model-written summary is still preferred, always.** This changes nothing on the path where summarization works.

## The keyboard reaches everything

- **⌘K opens a command palette** — new chat, new ephemeral chat, settings, the setup checklist, export the current chat as Markdown, and a jump list of your ten most recent conversations. Type to filter, arrows to move, Enter to run, Escape to close.

## Explore a different answer without losing the one you have

- **Branch from any reply.** The 🌿 button on an assistant message copies the conversation up to that point into a new one, and the next turn diverges from there. The original is untouched, and the parent keeps a link back to every branch taken from it.
- **A branch of an ephemeral chat stays ephemeral.** Copying its messages into a persisted conversation would have written them to disk by the back door. It does not.

## Upgrade notes

- **macOS:** signed and notarized — no Gatekeeper dialog. Both Apple Silicon and Intel DMGs are attached. Also available via Homebrew: `brew tap CELCPG/tap && brew install --cask sigma-oasis`.
- **Windows:** the installer is unsigned, so SmartScreen will warn. Expected; proceed with "More info → Run anyway".
- **Auto-update:** if you're running v1.3.0, this release appears as an update automatically.
- **No settings migration needed.** The cache and the local digest are always on and have no configuration — both are bounded, in-memory, and off the disk entirely. Model slots, temperatures and privacy settings are untouched.
- **Nothing new leaves your machine.** No feature in this release contacts anything the previous one didn't. The cache removes network calls; the digest replaces one.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.3.0...v1.4.0
