import type { ModelConfig, ToolSchema } from '../types'

/**
 * Per-role tool allowlists (strategy Layer 1a).
 *
 * Small models degrade sharply as the tool list grows, and a role that never
 * touches the terminal should never hold it. `ModelConfig.tools` is the
 * allowlist; this is the one place its semantics live:
 *
 * - absent / not an array → all globally-enabled tools (legacy behavior, so
 *   existing settings migrate untouched)
 * - an explicit array — even empty → only the named tools that are *also*
 *   globally enabled (a global toggle-off always wins)
 *
 * Unknown names in the allowlist are ignored rather than erroring: the
 * toolbox changes across versions and a stale name must not break a slot.
 */
export function toolsForSlot(
  slot: Pick<ModelConfig, 'tools'>,
  available: ToolSchema[]
): ToolSchema[] {
  if (!Array.isArray(slot.tools)) return available
  const allowed = new Set(slot.tools)
  return available.filter((t) => allowed.has(t.function.name))
}

/**
 * Always-on tools (strategy Layer 1b): cheap, zero-argument, and useful on
 * almost any turn, so they ride every turn regardless of embedding rank.
 */
export const ALWAYS_ON_TOOLS: readonly string[] = [
  'get_current_datetime',
  'memory_save',
  'memory_search',
  'memory_forget'
]

/** Total tools sent per turn after subsetting — always-on plus top matches. */
export const TURN_TOOL_CAP = 6

/**
 * Per-turn subsetting: always-on tools plus the top-scoring matches by
 * embedding cosine, capped at TURN_TOOL_CAP, in the original wire order.
 *
 * `scores === null` means "no ranking available" (no embedding model, an
 * endpoint error) and returns the full list — subsetting is an optimization,
 * never a gate. Tools missing a score rank as zero.
 */
export function selectTurnTools(
  available: ToolSchema[],
  scores: Record<string, number> | null,
  cap: number = TURN_TOOL_CAP
): ToolSchema[] {
  if (scores === null || available.length <= cap) return available

  const alwaysOn = new Set(ALWAYS_ON_TOOLS)
  const chosen = new Set<string>()
  for (const t of available) {
    if (alwaysOn.has(t.function.name)) chosen.add(t.function.name)
  }
  const ranked = available
    .filter((t) => !chosen.has(t.function.name))
    .map((t) => ({ name: t.function.name, score: scores[t.function.name] ?? 0 }))
    .sort((a, b) => b.score - a.score)
  for (const r of ranked) {
    if (chosen.size >= cap) break
    chosen.add(r.name)
  }

  return available.filter((t) => chosen.has(t.function.name))
}

/**
 * v1.5: hold the subset steady across turns of the same conversation.
 *
 * Per-turn ranking is good for accuracy and bad for latency, because chat
 * templates render the tool list inside the system block — so a subset that
 * reshuffles every turn moves the prompt's first bytes every turn, and the
 * server re-processes the whole conversation instead of reusing its KV cache.
 * That undoes the v1.5 work on the system prompt itself (lib/grounding.ts) for
 * anyone running the default toolbox, which is well over the cap.
 *
 * The rule keeps both properties: when this turn's ranking is already covered
 * by what the last turn carried, the last turn's list is reused verbatim and
 * the prefix survives. When the ranking reaches for something the previous
 * subset does not hold — a genuine change of subject — the new selection wins
 * and the prefix is spent on a turn that needed it.
 *
 * `previousNames` is rebuilt against `available` rather than trusted as-is, so
 * a tool disabled since the last turn cannot be reintroduced by the cache.
 */
export function stabilizeTurnTools(
  available: ToolSchema[],
  selected: ToolSchema[],
  previousNames: readonly string[] | undefined
): ToolSchema[] {
  if (!previousNames || previousNames.length === 0) return selected
  const held = new Set(previousNames)
  const previous = available.filter((t) => held.has(t.function.name))
  if (previous.length === 0) return selected
  const covered = selected.every((t) => held.has(t.function.name))
  return covered ? previous : selected
}
