# Sigma Oasis v1.4.7

Every release so far made the answers more honest. This one makes the app faster, and it is the first whose changes are measured in milliseconds rather than in claims checked. A long reply used to get slower the longer it ran: each arriving token re-rendered every message on screen and re-parsed the entire answer written so far. It no longer does. Along the way, a Stop button that could not stop three of its own buttons' turns, and five crashes nobody had hit yet. Pinned by 1,096 checks, 8 of them new.

## A streaming reply no longer slows down as it grows

- **A token updates one message, not the whole window.** Every arriving token used to be written into the conversation, which rebuilt the conversation list, which re-rendered the sidebar, the composer, the context meter and *every message bubble on screen* — for every token, for the length of the reply. Streamed text now lands in its own small piece of state that only the reply being written subscribes to. Finished messages no longer re-render at all while a new one streams.
- **The answer so far is no longer re-parsed on every token.** Markdown parsing, syntax highlighting and HTML sanitizing ran over the whole accumulated reply each time a token arrived — work that grows with the square of the answer's length, on the same thread that draws the window, and worst on exactly the long code-heavy answers where it is most visible. The finished part of a reply is now parsed once per completed block and the growing part alone is re-parsed. The split never lands inside an open code fence, because half a fence renders code as prose.
- **Why it exists:** nothing in the app had ever been profiled. The cost was invisible on a short answer and compounding on a long one, which is the shape of problem reported as "it feels sluggish sometimes" and never as a bug.
- **What was measured.** A 516-line, 25 KB code-heavy reply, into a conversation already twelve exchanges long, streamed from a stand-in server so both versions render byte-identical text on an identical token cadence — a real model answers differently every time, which would have made the comparison meaningless. The figure is main-thread processor time in the window, averaged over two runs each:

| | v1.4.6 | v1.4.7 |
| --- | --- | --- |
| At 60 tokens/sec — processor time over a 105 s reply | 55.1 s | **26.3 s** |
| …of which running JavaScript | 32.1 s | **6.8 s** |
| At 150 tokens/sec — processor time over a 42 s reply | 35.1 s | **10.0 s** |
| …of which running JavaScript | 21.1 s | **2.8 s** |
| At 150 tokens/sec — input delay, 95th percentile | 82 ms | **4 ms** |

- **The faster your model, the more this mattered.** At 60 tokens/sec both versions keep up, which is exactly why this was never filed as a bug — the old code had just enough slack between tokens to hide in. At 150 tokens/sec, a rate a small model on Apple Silicon reaches easily, v1.4.6 spent 83% of a processor core on rendering and the delay before the window could answer a keystroke rose to 82 ms on average and 157 ms at worst. v1.4.7 holds around 24% at both rates: the cost is now roughly flat in how fast the model is, where before it climbed.
- **The honest cost of the change:** because updates are now paced rather than drawn per token, the last few characters of a reply land up to about a tenth of a second after the model finished, against near-instantly before. That is the trade — a bounded, imperceptible tail at the end, for a window that stays responsive throughout.
- **A timer would have been the wrong clock.** The first version of this paced its updates on a timer, and a reply streaming behind another window collapsed into one visible jump a minute: Chromium throttles timers in a window it believes you cannot see, while network callbacks keep arriving. Updates are paced by token arrival instead, which is not throttled. Found by measuring, not by reading — the code looked correct.
## The app stopped reading the same files from disk over and over

- **Settings were read from disk on every single access.** The settings store re-read and re-parsed `config.json` on every property read, and 35 places in the app read settings — including once per outbound network request, once per model call, once per audit entry, and inside the deep-research loop. They are now read once and kept, re-read on every write. The kept copy is frozen, so a future accidental write throws instead of quietly diverging from the file.
- **Every memory search re-read the entire memory store.** Long-term memory keeps its vectors as JSON numbers, roughly 12–15 KB of text per chunk, and the whole file was parsed on every recall — around 25 MB of parsing per search once a personal knowledge base reaches a couple of thousand chunks. The store is now held in memory and checked against the file's timestamp, so an edit behind the app's back is still noticed. Scoring also stopped recomputing both vectors' lengths for every comparison, using the normalized form the research index has used all along.
- **The proxy was re-applied to the connection before every request** — an unnecessary round-trip each time, done so a settings change would apply without a restart. It still applies without a restart; the configuration is still derived fresh every time, so there is no second copy to go stale. Only the redundant call is skipped.
- **Voice input re-ran its whole setup detection before every clip** — a series of file probes plus spawning `which` — every time you pressed to talk. A successful detection is now remembered. Only success is cached: while voice input is *not* set up, it re-checks every time, because that is precisely when you are mid-install and should not have to restart. A cached tool that later disappears drops the cache on the failed transcription and re-detects.

## Stop now stops everything it started

- **Stop could not stop a turn started from a message.** The composer's Stop button and the ↻ Regenerate, 🔍 2nd opinion and ↗ escalate buttons each held *their own* handle on the running turn, so Stop aborted a handle that was always empty — a regenerating reply ran to completion with the button showing Stop the entire time. All of them now share the one turn's handle.
- **A stopped reply keeps the text it had already written**, rather than discarding it.

## Five crashes that had not been hit yet

- **A confirmation dialog whose window had closed took the request down with it.** Eleven places asked for a dialog's parent window and assumed one was there. Close the window while a confirmation is pending — reachable during a long research run or a terminal-command confirm — and the whole request threw. No window now means the confirmation *declines*, the file picker cancels, the notice is skipped. Deliberately never a parentless dialog: an approval prompt belonging to no window is how a background process teaches people to click OK.
- **A background update finishing with no windows open** did the same thing, on macOS, inside an event handler. The install was already handled on quit; only the dialog is skipped now.
- **A message bubble read three settings after an early return**, so the number of hooks differed between a user message and a reply — legal today only because a message never changes its role, and a crash the moment one did.
- **The update checker's timer was never cleared** and could fire into an app already shutting down.
- **The startup effect captured stale functions** and re-ran on font-size changes, re-probing the server and reloading conversations for a setting that has nothing to do with either.

## Upgrade notes

- **Nothing to configure.** No new settings, no migration, no change to any behaviour you have set up. Everything here is either faster or a bug that is now absent.
- **macOS:** signed and notarized — no Gatekeeper dialog. Both Apple Silicon and Intel DMGs are attached. Also available via Homebrew: `brew tap CELCPG/tap && brew install --cask sigma-oasis`.
- **Windows:** the installer is unsigned, so SmartScreen will warn. Expected; proceed with "More info → Run anyway".
- **Auto-update:** if you're running v1.4.6, this release appears as an update automatically.
- **Editing `config.json` while the app is running** no longer takes effect, since settings are now read once and kept. That was never supported, but it did happen to work.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.4.6...v1.4.7
