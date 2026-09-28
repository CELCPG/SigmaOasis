import type { ChatMessage } from '../types'
import { emptyReplyFailure } from './replyRecovery'

/**
 * VIBE (v3.0): the pure half of the calm view — what it shows, what it asks
 * the model for, and when its light breathes. No React and no DOM, so the
 * node:test suite reaches it (test/vibe.test.ts).
 *
 * The rule the whole mode follows: **the engine does not change, only what is
 * drawn does.** Tools, memory recall, the library, the fact ledger and every
 * post-answer check still run exactly as in the full view — the reader asked
 * for the power without the noise, not for a smaller model. Two things differ
 * and both are here: the model is asked to be brief, and the reader sees the
 * words of the conversation and nothing else.
 */

/**
 * The one line VIBE adds to a turn, and where it goes.
 *
 * **In the system prompt, not the turn's notes — measured.** Every other
 * per-turn addition rides the turn's own user message (lib/grounding.ts
 * `buildTurnContext`) so the cached prefix never moves. VIBE's line started
 * there too, and it cost the mode its tools: asked "What time is it right
 * now?", the turn called get_current_datetime 1 time in 13 across four
 * wordings on qwen3.8-9b and its distill, against 7 in 7 with VIBE off — one
 * turn's reasoning even said "I need to use get_current_datetime", and then it
 * answered with an invented time. Rewording barely moved it: it is the notes
 * block on the user's message, not what the note says. In the system prompt,
 * beside the persona and the standing rules, the same kind of line kept the
 * call, 7 in 8 (docs/evals.md, "VIBE: where the brevity line goes").
 *
 * What that costs is the cached prefix once per toggle: switching VIBE on or
 * off mid-conversation re-reads that conversation's history on the next turn.
 * Within the mode, the prompt is as stable as before.
 *
 * **v3.1 (M3): the line scopes itself to the final reply — measured.** The
 * 3.0 line ("the user sees nothing but the conversation. Once you have what you
 * need, answer in a few calm sentences…") held the time question, but the
 * whole tool-choice suite found what it cost: on qwen3.8-9b-distill, "remember
 * that my favorite band is Phish" called memory_save 0 times in 3 with VIBE on
 * and 3 in 3 without, every other fixture unchanged. The model's reasoning said
 * "I should use memory_save"; its reply said "I've saved that" with nothing
 * saved. Across four wordings of a "remember" request plus the time question,
 * the 3.0 line kept 3 calls in 5 and claimed a save on both misses; a line that
 * says it changes only how the final reply reads, and that tools work as they
 * always do, kept 5 in 5 — and on the full suite matched the arm without VIBE
 * fixture for fixture (docs/evals.md, "VIBE's tool-choice arm").
 *
 * The exception is written in rather than left to the model: a reader who asks
 * for a long piece in VIBE still gets it. Brevity is the mode's default, not a
 * cap — and measured, still a real one: open questions came back in 191–241
 * words of prose with no headings or lists, against 275–355 words with 19–25
 * such lines without VIBE.
 */
export const VIBE_SYSTEM_LINE =
  'VIBE mode is on. It changes only how your final reply reads: a few calm sentences of plain ' +
  'prose — no headings, tables or long lists, and no talk of tools or sources unless asked. ' +
  'If the user asks for something long or detailed, give it in full. Everything else, calling ' +
  'tools included, works as it always does.'

/** VIBE's addition to the system prompt: the line when the mode is on, nothing otherwise. */
export function vibeSystemBlock(vibeMode: boolean | undefined): string {
  return vibeMode ? `\n\n${VIBE_SYSTEM_LINE}` : ''
}

/**
 * Outline-then-fill (v2.6) writes a document section by section, which is the
 * opposite of what VIBE asks for; a document-shaped ask in VIBE is answered by
 * the ordinary turn, which honours the note above and its exception.
 */
export function outlineAllowed(vibeMode: boolean | undefined): boolean {
  return !vibeMode
}

/** One line of the conversation as VIBE draws it. */
export interface VibeLine {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** A steer typed mid-turn that has not reached the model yet — drawn faint. */
  queued?: boolean
  /**
   * The reply ended with nothing to show. The line then carries the app's own
   * one-sentence reading of why (shared/failure.ts), because an empty space in
   * a calm view is a worse kind of noise than a sentence.
   */
  quiet?: boolean
}

/**
 * The conversation as VIBE shows it: what was said, by whom, in order.
 *
 * Dividers (rollback, notices) are the full view's bookkeeping and are left
 * out. A job digest is a reply the reader asked for, so it stays. The message
 * being written is included even while it is still empty — the view draws its
 * breathing light in that line's place — but a finished empty reply becomes
 * its failure sentence rather than a blank.
 */
export function vibeLines(messages: ChatMessage[], streamingId: string | null): VibeLine[] {
  const lines: VibeLine[] = []
  for (const m of messages) {
    if (m.marker && m.marker !== 'digest') continue
    if (m.role === 'user') {
      const text = m.content.trim() || (m.attachments ?? []).map((a) => `📎 ${a.name}`).join('  ')
      if (!text) continue
      lines.push({ id: m.id, role: 'user', text, ...(m.delivery?.state === 'queued' ? { queued: true } : {}) })
      continue
    }
    // v3.0: an agent turn still working is in progress too — its words arrive
    // when the task ends — not a reply that ended with nothing.
    if (m.content.trim() || m.id === streamingId || m.agent?.status === 'running') {
      lines.push({ id: m.id, role: 'assistant', text: m.content })
      continue
    }
    lines.push({ id: m.id, role: 'assistant', text: emptyReplyFailure(m).sentence, quiet: true })
  }
  return lines
}

/**
 * A reply's `[1]` markers, removed for display in prose and left alone in
 * code.
 *
 * The full view binds each marker to the passage it names; VIBE draws no
 * passages, so a marker there is a number pointing at nothing — exactly the
 * noise the mode exists to take away. The message itself is untouched: leave
 * VIBE and every marker is back beside its source. Code is skipped span by
 * span, because `x = [1]` in a fence is a list, not a footnote.
 */
export function stripCitationMarkers(markdown: string): string {
  // Fenced blocks and inline code spans are captured and kept; only the text
  // between them is rewritten. A fence still open at the end (a reply still
  // streaming) runs to the end of the text, which keeps it whole.
  return markdown
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/[ \t]?(?<![\w\])])\[\d{1,3}\](?:\[\d{1,3}\])*(?!\()/g, '')))
    .join('')
}

/**
 * The light's three states:
 * - `still` — nothing is running; the lagoon drifts on its own.
 * - `breathing` — a turn is running and nothing has surfaced yet: the model is
 *   thinking, or a tool is working. Deliberately one state: VIBE does not name
 *   which tool is running, because naming it is exactly the noise it removes.
 * - `surfacing` — words are arriving.
 */
export type VibePhase = 'still' | 'breathing' | 'surfacing'

export function vibePhase(streaming: boolean, surfaced: boolean): VibePhase {
  if (!streaming) return 'still'
  return surfaced ? 'surfacing' : 'breathing'
}

/**
 * ⌘⇧L (Ctrl+Shift+L elsewhere) — L for lagoon. Not V: Ctrl+Shift+V is
 * "paste as plain text" in every Chromium text field, and the composer is
 * exactly where that shortcut is used.
 */
export function isVibeToggle(e: {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}): boolean {
  return (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l'
}
