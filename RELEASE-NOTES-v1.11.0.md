# Sigma Oasis v1.11.0 — two chats, side by side

A focused release: **split view**. Put two conversations next to each other with **⌘\\** — two
branches of the same question compared line by line, or a reference chat kept open while you work
in another. Pinned by 1,444 node checks.

## The pane you are typing into is never in doubt

Only the **focused** pane carries the composer. The other is a reader, one click from becoming the
writer. That is not a limitation dressed up as a feature — it is the reason the rest of the app
needed no changes at all: `activeConversationId` still means exactly what it meant, "the focused
chat", and it is still the only thing the composer, the chat panel and every turn entry point read.
The panes are a view; the machinery that runs a turn never learned they exist.

Focus moves by swapping the two conversation ids and flipping which side the unfocused pane sits on,
so **the chat you were reading stays where it was on screen** while the id that names the focused
pane changes underneath it. The chat panel (⌘J) follows the focus, so strategy, memory scope and
details always describe the chat you are about to type into.

Open a split with ⌘\\, with ⊞ on any conversation in the rail, or from the command palette. The rail
dash-outlines whichever chat is in the other pane. ✕ on a pane header closes it and keeps the other.
Selecting a chat that is already in the other pane focuses that pane instead of showing it twice —
no chat is ever in both — and deleting a chat a pane is showing promotes the survivor rather than
leaving an empty pane beside a live one.

**One turn at a time, unchanged and deliberate.** There is one abort handle, one streaming flag, and
one local model server that pins the answering slot's model for the duration of a turn. Two
generations at once would fight over that pin and trade eject/reload cycles, so a split gives you two
views, not two engines.

## What a second pane exposed

Three of these were latent the whole time and only a second mounted chat could show them; the fourth
turned up driving the real app rather than reading the code.

- **The stream-scroll subscription was never scoped to its own conversation.** With one chat on
  screen that is invisible. With two, the pane you were *reading* scrolled itself to the bottom on
  every token the other pane emitted.
- **The composer does not fit at half width.** Five fixed-size buttons plus Send left the input a
  sliver and rendered its placeholder as a single clipped letter. In split view the input takes its
  own full-width row and the controls wrap beneath it — every control still reachable, none hidden
  at narrow widths.
- **Message action rows** ran off the edge of a half-width bubble. They wrap.
- **Closing a pane ran one event behind.** A click focuses whichever pane it landed in, in the
  capture phase, so that a message's own buttons act on the right chat. The ✕ handler was reading
  the focus as it had been *before* that, so closing the pane you meant to dismiss kept it and threw
  away the one you were reading. Closing is unconditional now — focus the other, then close — which
  is correct from either pane.

## Also

- CI and the release pipeline now run their actions on **Node 24 for real**: checkout v7,
  setup-node v7, upload-artifact v7, download-artifact v8. A flat bump to v5 is the obvious-looking
  fix and is not enough — upload-artifact v5 and download-artifact v5/v6 shipped "preliminary Node 24
  support" while still defaulting their own runtime to Node 20, so the deprecation warning survives
  it. The build toolchain stays on Node 20; that is a separate thing from the runtime the actions
  themselves use.
- download-artifact v8 defaults to failing on a digest mismatch, so a corrupted transfer now stops
  the release instead of attaching a bad installer to it.

## Upgrade notes

Auto-update from v1.10.x. Nothing changes until you press ⌘\\ — with no split open the middle of the
window renders exactly what v1.10 did. No settings were added and none changed meaning; the split is
per-session and not persisted across restarts.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.10.0...v1.11.0
