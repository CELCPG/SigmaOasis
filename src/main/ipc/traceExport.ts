import { createHash } from 'crypto'

/**
 * Layer 4 — trace export (4a), outcome labeling (4b), schema versioning (4c).
 *
 * Turns the session audit log into OpenAI-format conversational JSONL suitable
 * for out-of-band fine-tuning (MLX-LM, Unsloth, llama.cpp LoRA — never inside
 * the app). This module is pure: no Electron, no fs, no network. The IPC
 * handler (main/ipc/traces.ts) and the CLI shell (scripts/export-traces.ts)
 * supply I/O; the node:test suite reaches everything here directly.
 *
 * The audit log deliberately records no system prompts, no recalled memory, no
 * routing notes — so exported traces contain only what the user said, the tool
 * calls the model made, the tool outputs, and the final reply. That is exactly
 * the sequence SFT wants, and nothing it should not see.
 *
 * Non-negotiable constraints (strategy doc, Layer 4):
 *
 * - **Opt-in per export.** Nothing here runs on its own; both shells require an
 *   explicit user action (a save dialog in-app, a CLI invocation).
 * - **Ephemeral-blind by construction.** Ephemeral conversations never reach
 *   the audit log, so they can never reach a trace.
 * - **Redaction before bytes leave the app.** Every string written to a trace
 *   passes through redactText(): URLs, absolute paths, emails, phone numbers,
 *   IPs/localhost, and key-shaped tokens are replaced with placeholders; a
 *   call's arguments are redacted value by value, and what a document says is
 *   withheld (v4.1).
 * - **Labels come from outcomes, not vibes (4b).** A trace is `positive` only
 *   when the turn *mechanically* ended well: no errored tool calls, a final
 *   assistant answer exists, and the reply was either never flagged unverified
 *   or every checked claim came back confirmed. Turns that errored, looped to
 *   the iteration cap, or ended contradicted export to a separate rejected
 *   file — the rejected half of preference pairs, not garbage. Anything the
 *   mechanics cannot settle (no outcome data, claims left unverifiable) is
 *   unlabeled and excluded from both files.
 * - **Schema-exact, versioned (4c).** Traces alone are dangerous: a fine-tune
 *   trained against yesterday's argument names is a syntax-drift generator.
 *   Every export is stamped with a content hash of the tool schemas that
 *   produced it, and the schemas themselves export alongside the traces.
 */

import type { AuditPlanFields } from '../../shared/audit'

// ---- Input shapes -------------------------------------------------------------

/**
 * One line of a decrypted export, as read from a file this build did not
 * necessarily write.
 *
 * `kind` is deliberately `string` and not `AuditEntryKind`: the CLI shell reads
 * whatever JSONL it is pointed at, and a log from a newer build carrying a kind
 * this one has never heard of must be read, not rejected. Everything else is
 * `shared/audit.ts`'s, so the plan fields are not written out a fourth time.
 */
export interface AuditEntryLike extends AuditPlanFields {
  at: string
  kind: string
  conversationId: string
  roleName?: string
  modelId?: string
  toolName?: string
  ok?: boolean
  text: string
}

export interface TraceToolCall {
  name: string
  /** Parsed arguments; the raw argument text when it was not valid JSON. */
  args: unknown
  ok: boolean
  /** Tool output, or the error message when ok is false (no "Error: " prefix). */
  output: string
}

export interface TraceTurn {
  conversationId: string
  /** 0-based index of this turn among the conversation's user inputs. */
  turnIndex: number
  user: string
  toolCalls: TraceToolCall[]
  /** v2.7: messages typed while the turn ran, each with the round it was handed to the model before. */
  steers?: { text: string; beforeRound: number }[]
  /** Final reply. Absent when the turn stopped before one — iteration cap or abort. */
  assistant?: string
  roleName?: string
  modelId?: string
}

/** What the verification stack concluded about a turn's final reply. */
export interface TurnOutcome {
  unverified?: boolean
  /** v1.2 claim-check verdicts: 'confirmed' | 'contradicted' | 'unverifiable'. */
  claimVerdicts?: string[]
}

export type TraceLabel = 'positive' | 'rejected' | 'unlabeled'

export interface LabeledTurn {
  turn: TraceTurn
  label: TraceLabel
  reasons: string[]
}

// ---- Turn reconstruction ------------------------------------------------------

/**
 * Rebuild conversation turns from the audit stream. Entries are processed in
 * log order; each `user_input` opens a turn, `tool_call`s accrue onto it, and
 * the first `assistant_output` closes it. A turn that never sees an
 * `assistant_output` stopped before a final answer — the iteration-cap path
 * audits no `assistant_output`, so a missing final answer *is* the cap/abort
 * signature, not a guess.
 *
 * Entries that cannot belong to a turn (tool calls or replies outside any open
 * turn — e.g. the log began mid-turn, or a second slot's reply in a
 * multi-target turn) are counted as skipped rather than guessed into place.
 *
 * v2.5: the log also carries a plan's step boundaries and results. They are
 * passed over here, deliberately and in as many words rather than by falling
 * off the end of the branches. A trace is a request the model answered, and a
 * plan step's request is the constructed sub-turn prompt — which the audit has
 * never held and should not, since it splices in prior step results and the
 * conversation context. There is nothing to train on, so there is nothing to
 * skip either: these are not candidates that failed to be placed, and counting
 * them in `skipped` would make a plan turn look like a lossy export.
 */
export function buildTurns(entries: AuditEntryLike[]): { turns: TraceTurn[]; skipped: number } {
  const turns: TraceTurn[] = []
  const open = new Map<string, TraceTurn>()
  const counts = new Map<string, number>()
  let skipped = 0

  const close = (conversationId: string): void => {
    const t = open.get(conversationId)
    if (t) {
      turns.push(t)
      open.delete(conversationId)
    }
  }

  for (const e of entries) {
    if (e.kind === 'session_start' || !e.conversationId) continue
    if (e.kind.startsWith('plan_')) continue
    if (e.kind === 'user_input') {
      close(e.conversationId)
      const turnIndex = counts.get(e.conversationId) ?? 0
      counts.set(e.conversationId, turnIndex + 1)
      open.set(e.conversationId, {
        conversationId: e.conversationId,
        turnIndex,
        user: e.text,
        toolCalls: []
      })
    } else if (e.kind === 'user_steer') {
      // Recorded where it landed: after the tool calls of the round it
      // followed, with the round number the audit text carries.
      const t = open.get(e.conversationId)
      if (t) {
        const m = /^\[before round (\d+)\]\s*/.exec(e.text)
        ;(t.steers ??= []).push({ text: m ? e.text.slice(m[0].length) : e.text, beforeRound: m ? Number(m[1]) : 0 })
      }
    } else if (e.kind === 'tool_call') {
      const t = open.get(e.conversationId)
      if (!t) {
        skipped += 1
        continue
      }
      t.toolCalls.push(parseToolCallEntry(e))
    } else if (e.kind === 'assistant_output') {
      const t = open.get(e.conversationId)
      if (!t) {
        skipped += 1
        continue
      }
      t.assistant = e.text
      if (e.roleName) t.roleName = e.roleName
      if (e.modelId) t.modelId = e.modelId
      close(e.conversationId)
    }
  }
  for (const id of [...open.keys()]) close(id)
  return { turns, skipped }
}

/**
 * The audit records a tool call as `name(argsJson)\n→ output` (or
 * `\n→ Error: message` on failure). JSON.stringify keeps the arguments on one
 * line, so line 1 holds name + args and everything after `\n→ ` is the result.
 */
export function parseToolCallEntry(entry: AuditEntryLike): TraceToolCall {
  const text = entry.text ?? ''
  const arrow = text.indexOf('\n→ ')
  const head = arrow === -1 ? text : text.slice(0, arrow)
  let output = arrow === -1 ? '' : text.slice(arrow + 3)
  const ok = entry.ok !== false
  if (!ok && output.startsWith('Error: ')) output = output.slice('Error: '.length)

  let name = entry.toolName ?? ''
  let args: unknown = {}
  const openParen = head.indexOf('(')
  if (openParen !== -1) {
    if (!name) name = head.slice(0, openParen).trim()
    const closeParen = head.lastIndexOf(')')
    const rawArgs = closeParen > openParen ? head.slice(openParen + 1, closeParen) : ''
    try {
      args = JSON.parse(rawArgs)
    } catch {
      args = rawArgs // keep the raw argument text; the export stringifies it as-is
    }
  }
  return { name, args, ok, output }
}

// ---- Outcome labeling (4b) ----------------------------------------------------

/**
 * Label a turn from mechanical evidence alone. Rejected beats positive beats
 * unlabeled: any hard failure sends the trace to the rejected file; positive
 * requires affirmative evidence of a good ending; everything else is excluded
 * rather than guessed.
 */
export function labelTurn(turn: TraceTurn, outcome?: TurnOutcome): LabeledTurn {
  const rejected: string[] = []
  const errored = turn.toolCalls.filter((c) => !c.ok)
  if (errored.length > 0) {
    rejected.push(`tool error(s): ${[...new Set(errored.map((c) => c.name))].join(', ')}`)
  }
  if (turn.assistant === undefined) {
    rejected.push('no final answer — the turn stopped at the iteration cap or was aborted')
  }
  const verdicts = outcome?.claimVerdicts ?? []
  const contradicted = verdicts.filter((v) => v === 'contradicted').length
  if (contradicted > 0) rejected.push(`${contradicted} claim(s) contradicted by sources`)
  if (rejected.length > 0) return { turn, label: 'rejected', reasons: rejected }

  if (!outcome) {
    return {
      turn,
      label: 'unlabeled',
      reasons: ['no outcome data — cannot establish the reply ended verified']
    }
  }
  if (outcome.unverified) {
    if (verdicts.length === 0) {
      return {
        turn,
        label: 'unlabeled',
        reasons: ['flagged unverified and no claim check ran — outcome unknown']
      }
    }
    if (verdicts.every((v) => v === 'confirmed')) {
      return {
        turn,
        label: 'positive',
        reasons: [`flagged unverified, then all ${verdicts.length} claim(s) confirmed`]
      }
    }
    return {
      turn,
      label: 'unlabeled',
      reasons: ['claim check left claim(s) unverifiable — neither endorsed nor rejected']
    }
  }
  return { turn, label: 'positive', reasons: ['completed without tool errors, not flagged unverified'] }
}

/**
 * Derive per-turn outcomes from a stored conversation: the nth non-marker user
 * message pairs with the next non-marker assistant reply, whose `unverified`
 * flag and claim-check record are the verification stack's verdict on it.
 * Structural input (no types.ts import) so the module stays self-contained.
 */
export function outcomesFromConversation(convo: {
  messages: {
    role: string
    marker?: string
    unverified?: boolean
    claimCheck?: { claims: { verdict: string }[] }
  }[]
}): Map<number, TurnOutcome> {
  const map = new Map<number, TurnOutcome>()
  const msgs = convo.messages.filter((m) => !m.marker)
  let turnIndex = -1
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== 'user') continue
    turnIndex += 1
    const reply = msgs.slice(i + 1).find((m) => m.role === 'assistant')
    if (!reply) continue
    map.set(turnIndex, {
      unverified: reply.unverified === true,
      claimVerdicts: reply.claimCheck?.claims.map((c) => c.verdict)
    })
  }
  return map
}

/** Outcome lookup key shared by both shells. */
export function outcomeKey(conversationId: string, turnIndex: number): string {
  return `${conversationId}:${turnIndex}`
}

// ---- Redaction (4a constraint) --------------------------------------------------

const REDACTION_RULES: [RegExp, string][] = [
  // URLs first — they contain hostnames, paths, and sometimes keys.
  [/https?:\/\/[^\s)"'<>]+/g, '[url]'],
  // v4.1: what lands in a folder's .sigma/ from outside — a dropped file's
  // name (inbox), a deleted one's (trash), a worktree named from the task's
  // own words — is the user's, not the product's. The folder stays, so a
  // trace still reads as the agent working in .sigma/; notes.md, hooks.json
  // and commands/ are the product's vocabulary and are kept.
  [/(\.sigma[\\/]+(?:inbox|trash|worktrees)[\\/]+)[^\s"'`\\/]+/g, '$1[name]'],
  // v4.1: the branch a worktree task works on is `sigma/<the task's words>`.
  [/(?<![.\w])sigma\/[a-z0-9][\w.-]*/g, 'sigma/[branch]'],
  // Absolute filesystem paths: home and volume roots on macOS and Linux, and
  // (v4.1) any drive on Windows, either slash — through v4.0 only
  // C:\Users\… was caught, so D:\work\client\… and C:/Users/… went out whole.
  // The drive first, so the POSIX rule cannot take `/Users/…` out of `C:/Users/…`.
  [/\b[A-Za-z]:[\\/][^\s"'`<>|]*/g, '[path]'],
  [/\/(?:Users|home|root|Volumes|mnt|media|private|tmp|var\/folders)\/[^\s"'`]+/g, '[path]'],
  // v4.1: UNC shares, and paths written from home (~/, $HOME/, %USERPROFILE%\).
  [/\\\\[\w.$-]+\\[^\s"'`<>|]+/g, '[path]'],
  [/(?:~|\$HOME|%USERPROFILE%)[\\/][^\s"'`]*/g, '[path]'],
  // Email addresses.
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '[email]'],
  // Key-shaped tokens: prefixed secrets, long hex, long base64-ish runs.
  [/\b(?:sk|pk|api|key|token|Bearer)[-_ ][A-Za-z0-9_-]{16,}/g, '[token]'],
  [/\b[a-f0-9]{32,}\b/gi, '[token]'],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, '[token]'],
  // Loopback hosts and IPv4 addresses.
  [/\blocalhost\b/g, '[host]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]'],
  // v4.1: phone numbers — international with a leading +, and the North
  // American 3-3-4 shape with separators. After the IP rule, so an address is
  // an [ip]; a date (4-2-2) or a version (1.2.3) is neither shape.
  [/\+\d{1,3}(?:[\s.-]\d{2,4}){2,5}\b/g, '[phone]'],
  [/\+\d{8,15}\b/g, '[phone]'],
  [/(?:\(\d{3}\)\s?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g, '[phone]']
]

/**
 * Replace anything that could identify a person, a machine, or a credential
 * with a placeholder. Runs over every string that lands in a trace — user
 * text, tool arguments, tool outputs, and the final reply. Conservative by
 * design: an over-redacted trace trains slightly worse; an under-redacted one
 * leaks.
 */
export function redactText(text: string): string {
  let out = text
  for (const [re, placeholder] of REDACTION_RULES) out = out.replace(re, placeholder)
  return out
}

export type Redactor = (text: string) => string

/**
 * v4.1: redactText, after the paths this machine is known to have — the home
 * folder, the working directory — are replaced by exact match, in either
 * slash and any case, as web_search's sanitizer does — with the rest of the
 * path after them, to the next space. The patterns stop at a
 * space, so `C:\Users\Ada Lovelace\notes` would otherwise leave
 * `Lovelace\notes` behind; the literal does not. Built from escaped text, so
 * each is a plain string search.
 */
export function redactorFor(privatePaths: readonly string[] = []): Redactor {
  const literals = [...new Set(privatePaths.map((p) => p.trim().replace(/[\\/]+$/, '')).filter((p) => p.length >= 3))]
    .flatMap((p) => [p, p.replace(/\\/g, '/'), p.replace(/\//g, '\\')])
    .sort((a, b) => b.length - a.length)
    .map((p) => new RegExp(`${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[\\\\/][^\\s"'\`<>|]*)?`, 'gi'))
  if (literals.length === 0) return redactText
  return (text) => redactText(literals.reduce((out, re) => out.replace(re, '[path]'), text))
}

/**
 * v4.1: redact a parsed argument object value by value, then serialize.
 *
 * Through v4.0 a call's arguments, once parsed, were written with
 * JSON.stringify and never redacted — a `read_file` path, a `run_command`
 * line, an MCP tool's arguments went out whole. Redacting the serialized text
 * instead would be wrong twice: JSON doubles every backslash, so a Windows
 * path no longer looks like one, and a rule that stops before a quote can eat
 * the backslash escaping it and leave broken JSON. So every string is
 * redacted as itself, and the keys (the schema's names) are kept.
 */
export function redactArgs(value: unknown, redact: Redactor = redactText): unknown {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map((v) => redactArgs(v, redact))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactArgs(v, redact)]))
  }
  return value
}

/**
 * v4.1 (C1): what a document says stays out of a trace. A `.docx` or `.xlsx`
 * the agent read is the user's own text — names, figures, addresses — which
 * no pattern can find, so read_document's output is withheld whole (its size
 * kept, so the trace still shows a read that returned something), and
 * write_document keeps its path and its one-line result but not the text or
 * rows it wrote, nor the diff of what the document says.
 */
const DOCUMENT_WITHHELD = (chars: number): string => `[document text withheld from traces: ${chars} characters]`

function traceArgs(call: TraceToolCall, redact: Redactor): string {
  if (typeof call.args === 'string') return redact(call.args)
  if (call.name === 'write_document' && call.args && typeof call.args === 'object' && !Array.isArray(call.args)) {
    const a = { ...(call.args as Record<string, unknown>) }
    for (const k of ['content', 'sheets']) if (k in a) a[k] = DOCUMENT_WITHHELD(JSON.stringify(a[k] ?? '').length)
    return JSON.stringify(redactArgs(a, redact))
  }
  return JSON.stringify(redactArgs(call.args, redact))
}

function traceOutput(call: TraceToolCall, redact: Redactor): string {
  if (call.ok && call.name === 'read_document') return DOCUMENT_WITHHELD(call.output.length)
  if (call.ok && call.name === 'write_document') return redact(call.output.split('\n')[0] ?? '')
  return redact(call.ok ? call.output : `Error: ${call.output}`)
}

// ---- Schema version (4c) --------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

/**
 * A short content hash of the tool schemas a trace was produced against. A
 * fine-tune trained on traces whose stamp does not match the current schemas
 * is detectably stale instead of silently poisonous.
 */
export function schemaVersionFor(tools: unknown[]): string {
  return createHash('sha256').update(stableStringify(tools)).digest('hex').slice(0, 12)
}

// ---- OpenAI-format export --------------------------------------------------------

export interface OpenAIMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }[]
  tool_call_id?: string
}

/**
 * One turn as an OpenAI chat-conversation message list: user, then per call an
 * assistant message carrying `tool_calls` followed by the matching `tool`
 * result, then the final assistant answer. Redaction is applied here, at the
 * boundary, so no caller can forget it.
 */
export function toOpenAIMessages(turn: TraceTurn, redact: Redactor = redactText): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [{ role: 'user', content: redact(turn.user) }]
  turn.toolCalls.forEach((call, i) => {
    const id = `call_${i}`
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id,
          type: 'function',
          function: { name: call.name, arguments: traceArgs(call, redact) }
        }
      ]
    })
    messages.push({
      role: 'tool',
      tool_call_id: id,
      content: traceOutput(call, redact)
    })
  })
  if (turn.assistant !== undefined) {
    messages.push({ role: 'assistant', content: redact(turn.assistant) })
  }
  return messages
}

export interface TraceExportOptions {
  /** Outcomes from the verification stack, keyed by outcomeKey. */
  outcomes?: Map<string, TurnOutcome>
  /** The tool schemas these turns ran against, for the 4c version stamp. */
  tools?: unknown[]
  /** v4.1: this machine's own paths (home, working directory), redacted by exact match before the patterns. */
  privatePaths?: string[]
}

export interface TraceExportResult {
  /** Strict OpenAI fine-tuning lines: {"messages": [...]}. */
  positive: string[]
  rejected: string[]
  unlabeled: number
  manifest: {
    exportedAt: string
    schemaVersion: string | null
    counts: { turns: number; positive: number; rejected: number; unlabeled: number; skippedEntries: number }
    traces: {
      file: 'positive' | 'rejected'
      line: number
      conversationId: string
      turnIndex: number
      modelId?: string
      roleName?: string
      reasons: string[]
    }[]
  }
}

/**
 * The full pipeline: audit entries → turns → labeled, redacted OpenAI JSONL.
 * Trace lines stay strictly `{"messages": [...]}` so fine-tuning validators
 * accept them untouched; everything else (label, reasons, provenance, schema
 * stamp) lives in the manifest, indexed by file and line.
 */
export function exportTraces(entries: AuditEntryLike[], opts: TraceExportOptions = {}): TraceExportResult {
  const { turns, skipped } = buildTurns(entries)
  const redact = redactorFor(opts.privatePaths)
  const positive: string[] = []
  const rejected: string[] = []
  const manifestTraces: TraceExportResult['manifest']['traces'] = []
  let unlabeled = 0

  for (const turn of turns) {
    const { label, reasons } = labelTurn(turn, opts.outcomes?.get(outcomeKey(turn.conversationId, turn.turnIndex)))
    const line = JSON.stringify({ messages: toOpenAIMessages(turn, redact) })
    if (label === 'positive') {
      positive.push(line)
      manifestTraces.push({
        file: 'positive',
        line: positive.length,
        conversationId: turn.conversationId,
        turnIndex: turn.turnIndex,
        ...(turn.modelId ? { modelId: turn.modelId } : {}),
        ...(turn.roleName ? { roleName: turn.roleName } : {}),
        reasons
      })
    } else if (label === 'rejected') {
      rejected.push(line)
      manifestTraces.push({
        file: 'rejected',
        line: rejected.length,
        conversationId: turn.conversationId,
        turnIndex: turn.turnIndex,
        ...(turn.modelId ? { modelId: turn.modelId } : {}),
        ...(turn.roleName ? { roleName: turn.roleName } : {}),
        reasons
      })
    } else {
      unlabeled += 1
    }
  }

  return {
    positive,
    rejected,
    unlabeled,
    manifest: {
      exportedAt: new Date().toISOString(),
      schemaVersion: opts.tools ? schemaVersionFor(opts.tools) : null,
      counts: {
        turns: turns.length,
        positive: positive.length,
        rejected: rejected.length,
        unlabeled,
        skippedEntries: skipped
      },
      traces: manifestTraces
    }
  }
}
