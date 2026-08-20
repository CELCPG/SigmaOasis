import type { ToolCallRecord } from '../types'

/**
 * Pure logic behind the Oasis Ripple thinking indicator (OasisRipple.tsx).
 *
 * Kept free of React and the DOM so the thinking-state decisions can be
 * stress-tested in plain Node (test/oasisRipple.test.ts): rapid tool
 * sequences, unknown tool names, ripple capping, reduced motion.
 */

// ---- Tool → visual identity ---------------------------------------------------

export type OasisToolKind = 'search' | 'code' | 'memory' | 'file' | 'write' | 'consult' | 'generic'

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
  generic: { kind: 'generic', color: '#00d4aa', label: 'WORKING', icon: '⚙️' }
}

/** Ordered prefixes — first match wins, so more specific names come first.
 *  memory precedes search because 'memory_search' contains 'search'. */
const TOOL_RULES: { match: (name: string) => boolean; kind: OasisToolKind }[] = [
  { match: (n) => n === 'consult_model', kind: 'consult' },
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
    return { mode: 'hidden', tool: null, runningCount: 0, activeToolId: null }
  }
  if (content !== '') {
    return { mode: 'hidden', tool: null, runningCount: 0, activeToolId: null }
  }
  const running = toolCalls.filter((t) => t.status === 'running')
  const active = running[running.length - 1]
  if (active) {
    return {
      mode: 'tool',
      tool: toolVisualForName(active.name),
      runningCount: running.length,
      activeToolId: active.id
    }
  }
  return { mode: 'ambient', tool: null, runningCount: 0, activeToolId: null }
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
