# Sigma Oasis v1.0.0

The first stable release: a redesigned interface, and a full layer of verification and privacy controls on top of the local-first chat you know. Everything still runs on your machine through LM Studio — no cloud, no telemetry.

## A new look

- **Light theme, rebuilt dark theme.** Light is now the default canvas; both themes are driven by one set of design variables, with contrast tuned to stay legible (AA) in each. Switch under **Settings → Appearance**.
- **Starter cards.** A new conversation opens with four one-click prompts that show off what a local model can do privately — work through your finances, read a document off your disk, research a question with sources.
- **"This chat" section in the sidebar.** Everything scoped to the open conversation — strategy (Independent / Pipeline / Orchestrated), role picker, orchestrator, memory scope, rollback, export — sits next to the conversation list instead of a bar above the chat. The message list runs full height.
- **Context meter in the composer.** See how full the model's window is as you type (`~12.4K / 32K`, amber near the limit), with an honest tooltip: counts are estimated from text length, not tokenized.

## Verify what the model tells you (new in 0.9, first public release)

- **🔍 Second opinion.** A *different* role reviews any reply and names the specific claims it could not verify, plus the one check that would settle each. No confidence scores — a model grading itself says "yes" nearly always.
- **📋 Plan mode.** Turn a task into a step-by-step plan you approve before it runs, with live per-step progress and failures disclosed, never silently retried.
- **📚 Memory you can see and scope.** Every reply that used long-term memory shows which chunks it drew on, expandable to the exact text. Scope any conversation to specific memory sources — one chat knows only the handbook, another only personal notes.

## Privacy controls (new in 0.9, first public release)

- **◌ Ephemeral chats.** RAM-only conversations: nothing is written to disk, ever, and closing one asks first. No-trace means no-trace — ephemeral chats are excluded from the audit log too.
- **⏪ Context rollback.** Forget what the model remembers that you can't see — the compaction summary and fetched pages held in RAM — after a confirmation that names exactly what's dropped.
- **Session audit log (opt-in, off by default).** An append-only transcript of what was actually said and which tools ran, encrypted with your OS keychain and hash-chained so tampering is detectable.

## Upgrade notes

- **macOS:** signed and notarized — no Gatekeeper dialog. Both Apple Silicon and Intel DMGs are attached.
- **Windows:** the installer is unsigned for now, so SmartScreen will warn. Expected; proceed with "More info → Run anyway".
- **Auto-update:** if you're running v0.8.4, this release appears as an update automatically. (v0.9.0 shipped these features but was never published, so this is the first update since 0.8.4.)

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v0.8.4...v1.0.0
