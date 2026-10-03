import type { ApiMessage } from '../../renderer/src/lib/agentLoop'

/**
 * Keeping a long agent task inside the loaded context window (v3.0).
 *
 * A chat turn is one question; an agent task is forty rounds of reading files
 * and running tests, and the history grows with every one. The chat's answer
 * — summarize what no longer fits — costs a model call and loses exactly the
 * detail an agent needs (the lines it is about to edit). The agent's answer is
 * the one agentic CLIs converged on: tool *output* is the bulk of the history
 * and the most replaceable part of it, because it can be fetched again. So:
 *
 * 1. The oldest tool results are replaced, one at a time, by a note naming the
 *    tool and saying how to get the output back, until the history fits. The
 *    most recent few are never touched — they are what the model is reasoning
 *    about right now.
 * 2. Only if that is not enough are whole early rounds dropped — an assistant
 *    message together with its tool results, never one without the other,
 *    because a tool result with no call before it is a malformed history that
 *    servers reject. The system prompt and the task itself always stay.
 *
 * Token counts are an estimate from characters (the chat's own estimator is
 * the same shape); the budget leaves room for the reply and for the error.
 */

export const CHARS_PER_TOKEN = 3.5
/** Tool results from the end that are never elided. */
export const KEEP_RECENT_RESULTS = 4
/** Assumed when the host does not know the loaded window. */
export const DEFAULT_CONTEXT_TOKENS = 32_768
/**
 * v3.1 (M2): once over budget, elide down to this share of it, not just under
 * it. A local server reuses its prompt cache only up to the first token that
 * changed, and each elision rewrites a message near the history's start — so
 * trimming to just under the line meant the next round's output crossed it
 * again, the next-oldest result went, and every round from then on re-read
 * nearly the whole history. Trimming to 70% changes the start once every
 * several rounds. Rounds are still dropped only to get under the budget
 * itself: they are what cannot be fetched again.
 */
export const LOW_WATER = 0.7

export const ELIDED_PREFIX = '[Earlier output of '

function contentChars(content: ApiMessage['content']): number {
  if (content === null || content === undefined) return 0
  if (typeof content === 'string') return content.length
  return content.reduce((n, part) => n + (part.type === 'text' ? part.text.length : 1_000), 0)
}

export function messageChars(m: ApiMessage): number {
  const calls = (m.tool_calls ?? []).reduce((n, c) => n + c.function.name.length + c.function.arguments.length + 20, 0)
  return contentChars(m.content) + calls + 12
}

export function estimateTokens(messages: ApiMessage[], extraChars = 0): number {
  return Math.ceil((messages.reduce((n, m) => n + messageChars(m), 0) + extraChars) / CHARS_PER_TOKEN)
}

/** The history's budget: most of the window, less room for the reply. */
export function historyBudget(contextTokens: number | undefined): number {
  const window = contextTokens && contextTokens > 0 ? contextTokens : DEFAULT_CONTEXT_TOKENS
  const replyRoom = Math.min(8_192, Math.floor(window * 0.25))
  return Math.floor((window - replyRoom) * 0.9)
}

export interface FitResult {
  /** Tool results replaced by a note this call. */
  elided: number
  /** Characters those results held. */
  chars: number
  /** Whole rounds dropped this call. */
  droppedRounds: number
  /** v4.1 (A3): recent results cut harder by the caller's `shrink`, their middles spilled. */
  shrunk: number
  /** Still over budget after everything — the next request may be refused. */
  stillOver: boolean
}

/**
 * Fit `messages` (mutated in place) under `budgetTokens`, given `fixedChars`
 * of tool schemas that ride every request.
 *
 * v4.1 (A3): with `shrink`, two more measures, so that "still over" is no
 * longer sent as it stands (4.0 reported it and the engine sent the request
 * anyway, for the server to refuse or cut from the front on its own terms).
 * Before any round is dropped, the recent results — the four elision never
 * touches — are cut harder, oldest first: a cut middle is spilled and can be
 * read back (./spill.ts), where a dropped round is gone. And if dropping
 * rounds is still not enough, every result but the last is set aside. What
 * is over after that is the system prompt, the task and the calls themselves.
 */
export function fitContext(messages: ApiMessage[], budgetTokens: number, fixedChars = 0, lowWaterShare = LOW_WATER, shrink?: (text: string) => string): FitResult {
  const result: FitResult = { elided: 0, chars: 0, droppedRounds: 0, shrunk: 0, stillOver: false }
  const over = (limit = budgetTokens): boolean => estimateTokens(messages, fixedChars) > limit
  if (!over()) return result
  // v4.0: the low-water mark is the A1 experiment; the engine passes 1 (elide to just under the budget, as 3.0 did) while it is off.
  const lowWater = Math.floor(budgetTokens * lowWaterShare)

  // The tool name for each call id, so an elision note can say what it was.
  const nameOf = new Map<string, string>()
  for (const m of messages) for (const c of m.tool_calls ?? []) nameOf.set(c.id, c.function.name)

  const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0)
  const elidable = toolIdx.slice(0, Math.max(0, toolIdx.length - KEEP_RECENT_RESULTS))
  for (const i of elidable) {
    if (!over(lowWater)) return result
    const m = messages[i]!
    if (typeof m.content !== 'string' || m.content.startsWith(ELIDED_PREFIX) || m.content.length < 400) continue
    const name = nameOf.get(m.tool_call_id ?? '') ?? 'a tool'
    result.chars += m.content.length
    result.elided++
    m.content = `${ELIDED_PREFIX}${name} removed to fit the context window (${m.content.length.toLocaleString('en-US')} characters). Call it again if you still need it.]`
  }

  if (shrink) {
    for (const i of toolIdx) {
      if (!over()) break
      const m = messages[i]!
      if (typeof m.content !== 'string' || m.content.startsWith(ELIDED_PREFIX)) continue
      const cut = shrink(m.content)
      if (cut.length >= m.content.length) continue
      result.chars += m.content.length - cut.length
      result.shrunk++
      m.content = cut
    }
  }

  // Last resort: drop whole early rounds after the task statement.
  const firstUser = messages.findIndex((m) => m.role === 'user')
  while (over()) {
    const start = firstUser + 1
    // A round is an assistant message and the tool results that answer it.
    if (start >= messages.length - 2 || messages[start]?.role !== 'assistant') break
    let end = start + 1
    while (end < messages.length && messages[end]!.role === 'tool') end++
    // Never drop the round the model is in the middle of.
    if (end >= messages.length - 1) break
    messages.splice(start, end - start)
    result.droppedRounds++
  }
  if (result.droppedRounds > 0) {
    // Said once, on the task message itself rather than as a message of its
    // own: two user messages in a row is a history some chat templates
    // (Gemma's) refuse outright, since they require the roles to alternate.
    const task = messages[firstUser]!
    if (typeof task.content === 'string' && !task.content.includes(DROPPED_NOTE)) task.content += `\n\n${DROPPED_NOTE}`
    else if (Array.isArray(task.content) && !task.content.some((p) => p.type === 'text' && p.text.includes(DROPPED_NOTE))) {
      task.content = [...task.content, { type: 'text', text: DROPPED_NOTE }]
    }
  }
  if (shrink && over()) {
    const live = messages.filter((m) => m.role === 'tool' && typeof m.content === 'string' && !m.content.startsWith(ELIDED_PREFIX))
    for (const m of live.slice(0, -1)) {
      if (!over()) break
      const text = m.content as string
      if (text.length < 400) continue
      result.chars += text.length
      result.elided++
      m.content = `${ELIDED_PREFIX}${nameOf.get(m.tool_call_id ?? '') ?? 'a tool'} removed to fit the context window (${text.length.toLocaleString('en-US')} characters). Call it again if you still need it.]`
    }
  }
  result.stillOver = over()
  return result
}

export const DROPPED_NOTE =
  '[Earlier rounds of this task were removed to fit the context window. Your checklist and the files on disk are the record of what was done; re-read anything you need.]'

/**
 * v4.0 (A4): replace every sizeable tool result before `index` with the
 * elision note, whether or not the budget demands it — a finished step's
 * output, set aside so the next step starts clean. Returns how many.
 */
export function setAsideBefore(messages: ApiMessage[], index: number): number {
  const nameOf = new Map<string, string>()
  for (const m of messages) for (const c of m.tool_calls ?? []) nameOf.set(c.id, c.function.name)
  let count = 0
  for (let i = 0; i < Math.min(index, messages.length); i++) {
    const m = messages[i]!
    if (m.role !== 'tool' || typeof m.content !== 'string' || m.content.startsWith(ELIDED_PREFIX) || m.content.length < 400) continue
    const name = nameOf.get(m.tool_call_id ?? '') ?? 'a tool'
    m.content = `${ELIDED_PREFIX}${name} set aside: that step is done (${m.content.length.toLocaleString('en-US')} characters). Call it again if you still need it.]`
    count++
  }
  return count
}
