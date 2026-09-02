import type { ToolCallRecord } from '../types'

/**
 * Pure logic behind the Oasis Ripple thinking indicator (OasisRipple.tsx).
 *
 * Kept free of React and the DOM so the thinking-state decisions can be
 * stress-tested in plain Node (test/oasisRipple.test.ts): rapid tool
 * sequences, unknown tool names, ripple capping, reduced motion.
 */

// ---- Tool → visual identity ---------------------------------------------------

export type OasisToolKind = 'search' | 'code' | 'memory' | 'file' | 'write' | 'consult' | 'mcp' | 'generic'

export interface ToolVisual {
  kind: OasisToolKind
  /** Emitting accent color for ripples, labels, and icon glow. */
  color: string
  /** Uppercase status label shown while the tool runs. */
  label: string
  icon: string
}

const TOOL_VISUALS: Record<OasisToolKind, ToolVisual> = {
  search: { kind: 'search', color: '#4fffd1', label: 'SEARCHING', icon: '🔍' },
  code: { kind: 'code', color: '#ffd166', label: 'EXECUTING', icon: '⚡' },
  memory: { kind: 'memory', color: '#a78bfa', label: 'RECALLING', icon: '💾' },
  file: { kind: 'file', color: '#ff6b6b', label: 'READING', icon: '📄' },
  write: { kind: 'write', color: '#ff9d5c', label: 'WRITING', icon: '✍️' },
  consult: { kind: 'consult', color: '#c084fc', label: 'CONSULTING', icon: '🤝' },
  mcp: { kind: 'mcp', color: '#60a5fa', label: 'CALLING A SERVER', icon: '🔌' },
  generic: { kind: 'generic', color: '#00d4aa', label: 'WORKING', icon: '⚙️' }
}

/** Ordered prefixes — first match wins, so more specific names come first.
 *  memory precedes search because 'memory_search' contains 'search'. */
const TOOL_RULES: { match: (name: string) => boolean; kind: OasisToolKind }[] = [
  { match: (n) => n === 'consult_model', kind: 'consult' },
  // v2.5: a tool from an MCP server, whatever its name says it does — the
  // indicator names the kind of thing running (another program), not a guess
  // at what that program does with the network.
  { match: (n) => n.startsWith('mcp__'), kind: 'mcp' },
  { match: (n) => n.includes('memory') || n.includes('note'), kind: 'memory' },
  // shop_compare searches and fetches; shop_requirements and price_watch stay
  // generic on purpose — they send nothing, and a search indicator over local
  // work would misreport what left the machine.
  { match: (n) => n === 'deep_research' || n === 'shop_compare' || n === 'market_data' || n.includes('search') || n.includes('fetch') || n.includes('web'), kind: 'search' },
  { match: (n) => n.includes('terminal') || n.includes('command') || n.includes('exec') || n.includes('code') || n.includes('python') || n.includes('analyze'), kind: 'code' },
  { match: (n) => n.includes('write'), kind: 'write' },
  { match: (n) => n.includes('read') || n.includes('list') || n.includes('file') || n.includes('directory'), kind: 'file' }
]

/**
 * Map any tool name to its ripple visual. Unknown / malformed names degrade
 * to the generic teal "WORKING" state — the indicator must never break just
 * because a model invented a tool name.
 */
export function toolVisualForName(name: string): ToolVisual {
  const normalized = (name ?? '').toLowerCase().trim()
  for (const rule of TOOL_RULES) {
    if (normalized && rule.match(normalized)) return TOOL_VISUALS[rule.kind]
  }
  return TOOL_VISUALS.generic
}

// ---- Thinking state machine -----------------------------------------------------

export type OasisMode = 'hidden' | 'ambient' | 'tool'

export interface OasisState {
  mode: OasisMode
  /** Present in 'tool' mode: the visual for the currently running tool. */
  tool: ToolVisual | null
  /** How many tool calls are still running (a model can batch several). */
  runningCount: number
  /** Stable id of the running tool call — the component keys droplets off it. */
  activeToolId: string | null
  /** Name of that tool, so a wait can say what it is waiting on. */
  activeToolName: string | null
}

export const THINKING_VISUAL: ToolVisual = {
  kind: 'generic',
  color: '#00d4aa',
  label: 'THINKING',
  icon: ''
}

/**
 * Reduce (streaming, content, toolCalls) to the ripple's display state.
 *
 * Rules:
 * - Nothing streams → hidden.
 * - Streaming with no visible text yet and no tool activity → ambient pool.
 * - A running tool with no visible text yet → tool mode (droplet + label),
 *   regardless of the hideToolCalls setting — the ripple *is* the disclosure.
 * - Once text starts flowing the ripple yields to the message; tool progress
 *   is then carried by ToolCallBlock (or nothing, when hidden by settings).
 *
 * When several tools run at once the most recently started one wins — it is
 * what the model is doing *right now*.
 */
export function describeOasisState(
  isStreaming: boolean,
  content: string,
  toolCalls: ToolCallRecord[]
): OasisState {
  if (!isStreaming) {
    return { mode: 'hidden', tool: null, runningCount: 0, activeToolId: null, activeToolName: null }
  }
  if (content !== '') {
    return { mode: 'hidden', tool: null, runningCount: 0, activeToolId: null, activeToolName: null }
  }
  const running = toolCalls.filter((t) => t.status === 'running')
  const active = running[running.length - 1]
  if (active) {
    return {
      mode: 'tool',
      tool: toolVisualForName(active.name),
      runningCount: running.length,
      activeToolId: active.id,
      activeToolName: active.name || null
    }
  }
  return { mode: 'ambient', tool: null, runningCount: 0, activeToolId: null, activeToolName: null }
}

// ---- The silent wait ------------------------------------------------------------

/**
 * A stream can go quiet for a long time and stay perfectly healthy — prompt
 * processing on a 30k-token conversation is most of a minute of nothing. What
 * cannot stand is that the indicator looks *identical* at five seconds and at
 * ninety: measured, a 90.8 s turn showed the same animated disc the whole way,
 * and the reader only learned anything because they pressed Stop. These two
 * thresholds are where the disc starts saying something instead.
 */

/** Past this, the wait has left the ordinary range and gets a counter. */
export const WAIT_COUNT_MS = 10_000
/** Past this, the counter is joined by what is being waited on, and the deadline. */
export const WAIT_ESCALATE_MS = 30_000
/**
 * Past this, the line stops being a fact and says what the fact could mean.
 *
 * v1.17.4. The number is `STREAM_STALL_MS`, deliberately and not by
 * coincidence: it is already the app's answer to "how long may a socket that
 * was working go quiet before the app stops believing in it", and inventing a
 * second number for the same judgement is how two spellings of one rule drift
 * apart. A stream that has produced nothing at all is held to five minutes
 * rather than one — prompt processing is legitimately silent — but the minute
 * is still where the app's own patience for silence runs out, and so it is
 * where the reader is owed more than a clock.
 *
 * Below it the line reports only what the transport witnessed. At and above it
 * the line adds the two readings that fact still allows, and refuses to pick
 * one: the app cannot tell a long prompt from a dead stream, and a reader
 * deciding whether to keep waiting is better served by that than by a guess.
 */
export const WAIT_STALLED_MS = 60_000
/** Counter resolution. */
export const WAIT_TICK_MS = 1_000

export interface WaitNotice {
  /** 'quiet' renders nothing; the rest are text the reader gets. */
  level: 'quiet' | 'counting' | 'escalated' | 'stalled'
  /** Elapsed silence, formatted. Null while quiet. */
  elapsed: string | null
  /** What the wait is on. Null until it escalates. */
  detail: string | null
  /** When the transport gives up on its own. Null until it escalates. */
  deadline: string | null
  /**
   * What the silence could still innocently be, and what it could not. Null
   * except at 'stalled', and null even there when the app has no transport
   * record to reason from — a second sentence with nothing behind it is the
   * guess this whole module exists to refuse.
   */
  note: string | null
}

/** Seconds under a minute, m:ss over it. Truncated, never rounded up. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * What the transport has seen of the request the reader is waiting on.
 *
 * Structurally a `StreamWitness['round']`, spelled out here so this module
 * stays free of the transport (and of the store the transport publishes
 * through). Null means the app has no record of this particular wait — see
 * `waitedOn` for what it is allowed to say then.
 */
export interface StreamPhase {
  /**
   * LM Studio answered: the transport's `fetch` returned a response.
   *
   * v1.17.5: this said "response headers arrived" and a sentence below was
   * built on those words. It is weaker than that — see StreamWitness in
   * hooks/chatTransport.ts for the measurement.
   */
  accepted: boolean
  /** At least one byte of the response body arrived. */
  streamed: boolean
}

/**
 * What the wait is on, said from evidence — v1.17.4.
 *
 * A blind critic, on ninety seconds of `still waiting on the model · 1:31 ·
 * gives up at 5:00`: *"The one thing it knows and never says during the wait is
 * that the server accepted the request and has sent zero bytes since — the
 * distinction between a slow model and a dead stream, which is exactly what
 * the reader needs at 60 seconds to decide whether to keep waiting."*
 *
 * Two things were wrong with that line, and they are the same thing. It never
 * said what the transport had witnessed; and "the model" was itself an
 * attribution the app had not established — before the response headers
 * arrive, what the app is waiting on is the *server*, and no model is known to
 * have been reached at all.
 *
 * So the subject is chosen from the record, in the order the facts arrive:
 *
 * | witnessed | what the reader is told |
 * | --- | --- |
 * | a tool is running | `still waiting on deep_research` — the wait is on the tool, and no witness applies to it |
 * | no record | `still waiting on the model` — a model call is in flight and nothing finer is known |
 * | no headers yet | `LM Studio has not answered the request yet` |
 * | headers, no body byte | `LM Studio took the request and has sent nothing back` |
 * | body bytes, then silence | `LM Studio started replying, then went quiet` |
 *
 * The no-record row is the honest minimum rather than a leftover: a plan
 * step's sub-turn, a consultation and the claim-check pass all call the
 * transport without a witness, and for those the app really does know only
 * that it asked a model something.
 */
function waitedOn(state: OasisState, seen: StreamPhase | null): string {
  if (state.activeToolName) return `still waiting on ${state.activeToolName}`
  if (!seen) return 'still waiting on the model'
  if (!seen.accepted) return 'LM Studio has not answered the request yet'
  if (!seen.streamed) return 'LM Studio took the request and has sent nothing back'
  return 'LM Studio started replying, then went quiet'
}

/**
 * The second line, past a minute: both readings the evidence still allows.
 *
 * The rule it obeys is the one the true negative demands. A model that is
 * genuinely just slow — a 30k-token prompt is most of a minute of legitimate
 * silence on a 9B, and far more than that on a CPU — is `accepted &&
 * !streamed` for the whole of it, byte for byte identical to a server that
 * has died. **The app cannot tell them apart, and so it must not claim to.**
 * What it can do is stop implying the innocent reading, name both, and leave
 * the decision with the reader, whose hardware and prompt it is.
 *
 * A running tool gets none of this: the witness describes a model request, and
 * a tool that has been working for a minute is not evidence about a socket.
 * Nor does a stream that has produced bytes and gone quiet — its ceiling is
 * the one-minute stall budget, so the transport ends that turn at precisely
 * the moment this note would appear, and a sentence the reader cannot finish
 * reading is worse than none.
 *
 * ## v1.17.5: the `!accepted` half said more than the witness knows
 *
 * It read *"Not even the reply headers have come back"*. A round-11 critic
 * tried to settle that against the fixture record and could not — the shim logs
 * `"status": 200` for the stalled request, which would put headers on the wire,
 * except that a status chosen by a handler that never writes a body is
 * routinely never flushed. Its verdict: *"run-2's most useful sentence is also
 * its least verifiable, and it is stated flatly."*
 *
 * Measured, three ways:
 *
 * - The fixture's `status: 200` is bookkeeping, not evidence: `h2h-fixtures.ts`
 *   assigns `entry.status = 200` before it calls `writeHead`, for every
 *   injected rule. And `writeHead` with no `write` puts **zero bytes** on the
 *   socket — Node holds the header block until the first body write.
 * - So on that fixture the sentence happened to be true. It is not true in
 *   general, because `accepted` was never the headers. It is set from the
 *   transport's `fetch` resolving.
 * - And `fetch` does not resolve on every header block: a `103 Early Hints`
 *   response and a `302` both put a complete reply header block on the wire and
 *   left `fetch` pending — a 1xx is not a response, and a redirect is followed
 *   internally. LM Studio behind any reverse proxy can produce either.
 *
 * The useful half — the difference between *be patient* and *this may never
 * come back* — was never the headers claim; it is the pair of readings the
 * evidence still allows, and that half is kept verbatim. What replaces the
 * first clause is what `!accepted` does establish, plus the one fact the
 * reader most needs and the app can prove: nothing was refused. A closed port
 * rejects `fetch`, and a rejection ends the turn — so while this line is on
 * screen, the address is not the thing to go and check.
 */
function waitReading(state: OasisState, seen: StreamPhase | null): string | null {
  if (state.activeToolName || !seen || seen.streamed) return null
  return seen.accepted
    ? 'Nothing has been written back since — the app cannot tell a prompt still being processed from a dead stream.'
    : 'Nothing has come back, and nothing was refused — the app cannot tell a busy server from one that has stopped answering.'
}

/**
 * What the indicator adds once a stream has been silent too long. `deadlineMs`
 * is the transport's own give-up for this phase (FIRST_BYTE_TIMEOUT_MS before
 * anything has arrived, STREAM_STALL_MS between chunks) — naming it is what
 * turns "hung forever" into "recovers by itself at 5:00". `seen` is what the
 * transport has witnessed of that same request; it decides both the subject of
 * the line and, at the call site, which of the two deadlines is counting down.
 */
export function describeWait(
  silentMs: number,
  state: OasisState,
  deadlineMs: number,
  seen: StreamPhase | null = null
): WaitNotice {
  const quiet: WaitNotice = {
    level: 'quiet',
    elapsed: null,
    detail: null,
    deadline: null,
    note: null
  }
  if (state.mode === 'hidden' || silentMs < WAIT_COUNT_MS) return quiet
  const elapsed = formatElapsed(silentMs)
  if (silentMs < WAIT_ESCALATE_MS) {
    return { level: 'counting', elapsed, detail: null, deadline: null, note: null }
  }
  const note = silentMs >= WAIT_STALLED_MS ? waitReading(state, seen) : null
  return {
    // The level is raised only where the extra sentence is actually there to
    // read: a level that says "stalled" over a line that says no more than it
    // did a second ago is a colour change pretending to be information.
    level: note ? 'stalled' : 'escalated',
    elapsed,
    detail: waitedOn(state, seen),
    deadline: silentMs < deadlineMs ? `gives up at ${formatElapsed(deadlineMs)}` : null,
    note
  }
}

/**
 * The one thing that makes a silent stream visible without the user touching
 * anything: a clock. Elapsed is read off the wall clock rather than counted in
 * ticks, because Chromium throttles intervals in an occluded window — a
 * backgrounded window then updates the counter less often, never wrongly.
 *
 * Lives here, free of React, so a 60-second silence can be driven by mock
 * timers instead of waited out.
 */
export function startWaitClock(
  tick: (silentMs: number) => void,
  tickMs: number = WAIT_TICK_MS
): () => void {
  const startedAt = Date.now()
  const timer = setInterval(() => tick(Date.now() - startedAt), tickMs)
  return () => clearInterval(timer)
}

// ---- Ripple bookkeeping ---------------------------------------------------------

/** Hard cap on concurrently visible ripples, per the style guide. */
export const MAX_RIPPLES = 8

/**
 * Append a ripple id to the visible set, evicting the oldest beyond the cap.
 * Returns the same array reference when nothing changed (cheap re-renders).
 */
export function capRipples(active: string[], incoming: string, max: number = MAX_RIPPLES): string[] {
  if (active.includes(incoming)) return active
  const next = [...active, incoming]
  return next.length > max ? next.slice(next.length - max) : next
}

/** Remove a finished ripple; identity when absent. */
export function settleRipple(active: string[], finished: string): string[] {
  return active.includes(finished) ? active.filter((id) => id !== finished) : active
}

// ---- Motion ----------------------------------------------------------------------

/**
 * Reduced-motion policy: droplet falls and expanding ripples are replaced by
 * the static pulsing center orb. Status text still updates — information is
 * never withheld, only movement.
 */
export function resolveMotion(prefersReducedMotion: boolean): { animateDroplets: boolean; animateAmbient: boolean } {
  return { animateDroplets: !prefersReducedMotion, animateAmbient: !prefersReducedMotion }
}
