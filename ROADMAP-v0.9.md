# Sigma Oasis v0.9 — Roadmap & Feature Spec

Status: **implemented** (all six features shipped, 440/440 tests green) · Target: v0.9.0 · Author: Colin Long

This roadmap came out of a review of a proposed feature list ("Advanced AI Power /
Deep Privacy Layers / Advanced Search & Research") against what v0.8.4 actually
ships. Roughly a third of that list is already built (long-term memory RAG,
cited deep-research briefs, multi-step orchestration), so this document specs
only the genuine gaps — plus the upgrades that make the existing pieces visible
to the user.

Two design principles from the existing codebase constrain everything below:

1. **No self-graded confidence.** The deep-research pipeline checks coverage
   *mechanically* because "asking a model to grade its own work would return
   'yes' nearly always." Any v0.9 verification feature must use a different
   model or a mechanical check — never the answering model rating itself.
2. **Privacy is structural, not policy.** Egress is enforced by an allowlist,
   fetched pages live only in RAM, secrets go through `safeStorage`. New
   features enforce their promises in code, and say so when they degrade.

---

## Scope summary

| # | Feature | Origin item | Effort | Risk |
| --- | --- | --- | --- | --- |
| 1 | Second Opinion (critic pass) | Self-Correction Loop | M | Low |
| 2 | Session Audit Log | Input/Output Auditing | M | Low |
| 3 | Ephemeral Chat Mode | Zero-Retention Default (reframed) | M | Med |
| 4 | Memory Citations + Per-Chat Scoping | Domain Specialization / Citations (upgrades) | S–M | Low |
| 5 | Context Rollback | Ephemeral Context Rollback | S–M | Low |
| 6 | Plan Mode (stretch) | Agentic Planning | L | Med |

Deferred: Comparative Analysis Mode → v0.10. Rejected as stated: numeric
confidence scores, zero-retention as the *default*, fine-tuning (LM Studio's
job). Rationale in §7.

---

## 1. Second Opinion — a critic pass by a different role

**What the user gets.** A "🔍 Second opinion" action under any assistant reply.
A *different* enabled role reviews the answer and posts a short, collapsible
block: which specific claims it could not verify from the conversation, and the
one check that would settle each ("verify the version number against the
release page"). No percentage scores — a number the model invents about itself
is exactly the self-grading this project rejects.

**Why a different role, not a re-prompt of the same one.** The answerer's own
context anchors it to its answer. A separate slot with its own persona and no
stake in the first answer is the cheapest available approximation of an
independent reviewer, and the orchestrated mode already built the machinery.

**Implementation.**

- `useLMStudio.ts`: add `runSecondOpinion(convoId, messageId)`. Reuse the
  specialist-consultation path (~lines 393–500, the plumbing behind
  `consult_model`): build a capped message list (user question + the answer
  under review), call the critic slot's model with its own system prompt plus
  a fixed critic instruction suffix, stream the result back. The critic gets
  **no tools** in v0.9 — it names the check; it does not run it.
- Critic selection: `settings.secondOpinion.criticSlotId`, default `null` =
  first enabled slot that is not the answerer. If no second slot is enabled,
  the action is disabled with an explanation ("load a second role to get a
  second opinion") — honest degradation, same pattern as keyword-only
  retrieval.
- `types.ts`: `ChatMessage.secondOpinion?: { roleName: string; modelId: string; text: string; createdAt: number }`.
  Persisted with the conversation; **excluded from wire history** like
  `reasoning`, so it is never replayed to a model as if it were part of the
  conversation.
- UI: new `SecondOpinionBlock.tsx` (collapsible, styled with
  `ReasoningBlock`/`ToolCallBlock` conventions). Trigger button in
  `MessageBubble.tsx` next to the read-aloud 🔊. The critic's suggested check
  renders as a one-click "Ask this" chip that prefills the composer — the
  verification becomes a normal follow-up turn with full tools.
- `store.ts`: `settings.secondOpinion: { enabled: boolean; criticSlotId: string | null }`,
  default disabled. Settings → Models section.

**Caveats to state in the UI.** The critic is another local model with the same
blind spots; a clean second opinion is not verification, it is a second guess
from a different angle. The block says so in one line.

**Tests.** Critic-slot selection (no second slot → null; answerer excluded);
wire-history exclusion of `secondOpinion`; critic prompt assembly.

---

## 2. Session Audit Log — the verifiable transcript

**What the user gets.** An opt-in, append-only log recording, per chat session:
what you typed, what the model answered, and which tools ran (name + arguments
+ ok/error). Nothing else — no system prompts, no recalled memory, no
compaction notes. It exists so you can verify *what was actually said*, the
same way the network activity log exists to verify *where data actually went*.

**Implementation.**

- New main-process module `src/main/ipc/audit.ts`.
  - Storage: `userData/audit/<sessionId>.jsonl`, one JSON object per line,
    appended with a serialized write queue (the `memoryQueue` pattern from
    `memory.ts` — read-modify-write races are already solved there).
  - **Tamper evidence:** each entry carries `prevHash` = SHA-256 of the
    previous line (Node `crypto`, no new dependencies). A gap or edit breaks
    the chain detectably.
  - **Encryption at rest:** each line encrypted via `safeStorage` (base64),
    the same mechanism that already protects the Brave API key
    (`store.ts:522`). Documented caveat, same as secrets today: the key is
    machine-bound, so the log is not portable across OS reinstalls. If
    `safeStorage.isEncryptionAvailable()` is false, the feature refuses to
    enable rather than logging plaintext silently.
  - Entry kinds: `user_input`, `assistant_output`, `tool_call`, `session_start`.
    All timestamps local ISO.
- IPC: `audit:record` (renderer → main, fire-and-forget), `audit:list`,
  `audit:export` (decrypts to a plaintext file the user places via save dialog,
  with a confirmation that states the export is unencrypted), `audit:purge`.
- Hook points in `useLMStudio.ts`: on send (user input), on stream completion
  (final `content`, post reasoning-split), and in the tool loop where
  `ToolCallRecord`s are already created. The trust note: content arrives from
  the renderer, which is fine — this log is for the user's own verification,
  not adversarial forensics. State that in Settings.
- Settings → Privacy: toggle (default **off** — a privacy app does not log by
  default), entry count, Export, Purge, and an auto-purge-on-quit option.
- **Interaction with ephemeral chats (§3): none.** Ephemeral conversations are
  never written to the audit log. No-trace means no-trace; the audit log is
  for sessions you wanted kept. This precedence is documented in both places.

**Tests.** Hash-chain continuity and break detection; queue serialization;
encryption-available gating; ephemeral conversations produce zero entries.

---

## 3. Ephemeral Chat Mode — the honest zero-retention

**Reframing.** The original proposal ("default is process-only, purge RAM on
close") contradicts the product: saved conversations in the sidebar *are* the
app. The intent — "leave no trace unless I choose to" — is delivered as an
explicit ephemeral conversation type, the same pattern already used for
fetched web pages (RAM-only index, discarded on quit).

**What the user gets.** "New ephemeral chat" (split button on New Chat in the
sidebar). The conversation lives only in RAM, shows a `◌ ephemeral` badge and
a one-line banner ("Nothing from this chat is written to disk. It disappears
when you close it or quit."), and closing it asks for confirmation.

**Implementation.**

- `types.ts` / `store.ts`: `Conversation.ephemeral?: boolean`.
- **Structural enforcement, not policy:** the main-process
  `conversations:save` handler (`store.ts:632`) refuses any conversation with
  `ephemeral: true`. The renderer also never calls save for one
  (`useConversations.ts:74`), but the main process is the boundary that must
  hold even if the renderer regresses.
- The stale-conversation prune path (`useConversations.ts:27–33`) is unaffected:
  ephemeral conversations never reach disk, so there is nothing to prune.
- What still works: memory auto-recall (read-only), all tools, compaction (the
  summary lives on the in-RAM `Conversation` object). Explicit saves stay
  explicit — if the user (or a model with permission) calls `create_note` or
  `memory_save`, that content lands on disk *because they asked for it*. The
  banner says this in its second sentence.
- On quit: nothing to purge, because nothing was written. That is the whole
  design; the README should say it in those words.
- Audit log: excluded, per §2.

**Tests.** Main-process save refusal for `ephemeral: true`; renderer save path
skips ephemeral; banner/close-confirmation flow (manual check list).

---

## 4. Memory Citations + Per-Chat Knowledge-Base Scoping

Two halves of the same upgrade: memory RAG already exists and auto-recalls
(`useLMStudio.ts:556–576`), but recall is invisible and unscoped.

### 4a. Visible recall — "what it remembered"

- When chunks are injected into the system prompt, record them on the resulting
  assistant message:
  `ChatMessage.memoryContext?: { source: string; score: number; text: string }[]`.
  Excluded from wire history, same as `reasoning` and `secondOpinion`.
- UI: a quiet line under the reply — `📚 From memory: company-handbook.pdf (0.81), q3-notes (0.77)` —
  expandable to read the exact chunks. The display is **mechanical**: the app
  shows what was actually injected, rather than asking the model to footnote
  itself (same reasoning as mechanical coverage checks in deep research).
- One-line change with outsized trust value: today a user cannot tell a
  memory-informed answer from a hallucinated one.

### 4b. Per-conversation scoping — "this chat only knows these docs"

- `Conversation.memorySources?: string[] | null` — `null` = all sources
  (current behavior, unchanged default).
- `memory.ts`: `searchMemory(query, topK, minScore, sources?)` — filter chunks
  by `source` before scoring; `memory:search` IPC gains the optional array.
  Sources not in the list simply don't exist for that conversation.
- UI: a memory-source picker in the chat header (checkbox list fed by
  `memory:stats`). Global add/remove/re-index stays under Settings → Memory.
- This is what turns the generalist into "a specialist on *their* stuff":
  one conversation scoped to the company handbook, another to personal notes,
  neither bleeding into the other.

**Tests.** Source filtering before scoring; `null` vs `[]` semantics (`null` =
all, `[]` = none); score floor still applied; wire-history exclusion of
`memoryContext`.

---

## 5. Context Rollback — forget what the user can't see

**What the user gets.** A "Rollback context" button in the chat header. The
confirmation dialog lists exactly what will be dropped — transparency is the
point:

- the rolling compaction summary (`Conversation.summary`) — the model's only
  memory of scrolled-off history;
- the ephemeral research index (fetched pages held in RAM) via the existing
  `clearResearchIndex()` (`researchIndex.ts:413`);
- nothing else. Visible messages stay; `memory.json` and notes are untouched
  (they are long-term, user-explicit saves).

After rollback, an in-chat marker (never sent to a model): *"Context rolled
back — the model no longer sees the earlier summary or any fetched pages."*
Same signaling convention as the `· compacted` marker.

**Implementation.** Small: clear `summary` on the conversation, call the
existing research-index clear IPC, insert the marker message. The next turn's
context budget rebuilds from visible messages only — `contextBudget.ts` needs
no changes because the summary is already an optional input.

**Slash commands are deliberately not part of this.** `InputBar.tsx` has no
command infrastructure; inventing a parser for one command is scope creep. If
a second command ever appears, build the infra then. Button first.

**Tests.** Summary cleared and next-turn wire history contains no "Earlier in
this conversation…" block; marker message excluded from wire history; notes and
`memory.json` untouched.

---

## 6. Plan Mode (stretch) — generalized multi-step tasks

Only starts if §1–§5 land early. `deep_research` already proves the pattern
(plan → execute → reflect → synthesize, budgeted, approval-gated); this
generalizes it from research to arbitrary tasks.

- Planner model (main process, `llm.ts` with its tolerant JSON parsing —
  already used by the deep-research planner) decomposes the request into a
  bounded plan: `{ steps: [{ title, detail }] }`, step count capped by a
  budget preset mirroring `ResearchSettings.depth`.
- The plan renders as a `PlanBlock` checklist in chat and — like
  `research.confirmPlan` — **executes only after user approval**.
- Executor runs steps sequentially; each step is a bounded sub-turn with the
  normal tool list and the normal `MAX_TOOL_ITERATIONS` cap. Step results post
  as progress lines on the checklist (pending → running → done/failed), so the
  user watches "Found 3 flights; average $890" happen per stage.
- Final synthesis turn answers with all step outputs as context.
- Hard rules, mirroring existing guardrails: budgets checked before each step,
  not reported after; any limit that stopped the run is disclosed; a failed
  step marks failed and the plan continues or halts per the plan's own note —
  never silently retried forever.

**Why stretch.** Largest surface area in the roadmap: new orchestration loop in
the renderer, a new block component, a new settings section, and real prompt
engineering to keep plans boring and short. Better shipped solid in v0.10 than
rushed into v0.9.

---

## 7. Considered and rejected (as proposed)

| Proposal | Verdict | Why |
| --- | --- | --- |
| Numeric confidence score ("below 80%…") | **Rejected** | Self-grading returns "yes" nearly always — the project's own deep-research rationale. Replaced by §1's different-model critic. |
| Zero-retention as the *default* | **Rejected** | Breaks the saved-conversation UX that defines the app. Intent delivered by §3's ephemeral mode instead. |
| Fine-tuning per knowledge base | **Out of scope** | That is LM Studio's layer. Sigma Oasis specializes via memory RAG + scoping (§4). |
| Comparative Analysis Mode (A/B doc diff) | **Deferred to v0.10** | Feasible today (attachments + `fetch_webpage` supply both documents) but the cost is a new side-by-side diff view in the renderer. Not core to the privacy story; queue behind §6. |
| `/rollback_context` slash command | **Deferred** | No command infrastructure exists; §5 ships the button. Build the parser when a second command exists. |

---

## Cross-cutting checklist (applies to every feature above)

- **Settings migrations:** all new settings get defaults in `store.ts` and merge
  via the existing `{ ...defaults, ...current }` pattern (`store.ts:451`).
- **Egress:** nothing in this roadmap adds an outbound path. Critic passes,
  planning, and audit are loopback or local disk. The network activity log
  should show zero new origins; that is a release checklist item, not an
  assumption.
- **Wire-history hygiene:** every new message adornment (`secondOpinion`,
  `memoryContext`, rollback markers) must be excluded from what is replayed to
  models — one shared serializer for "what the model sees" is preferable to
  three ad-hoc filters, and is worth the refactor while touching these paths.
- **Tests:** new logic lands in main-process modules where the `node:test`
  suite (electron/net/store seams stubbed) can reach it, per the existing
  suite's conventions. Renderer-only logic stays thin.
- **README:** each feature gets a section in the same voice — what it does,
  what it costs, what it deliberately does not do, and its caveats stated
  plainly.
