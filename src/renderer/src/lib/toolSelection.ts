import type { ModelConfig, ToolSchema, ToolToggles } from '../types'
import { TOOL_SCHEMAS } from '../../../shared/tools'
import { BRIDGE_EXCLUDED } from '../../../shared/codeSdk'

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
  slot: Pick<ModelConfig, 'tools' | 'codeMode'>,
  available: ToolSchema[]
): ToolSchema[] {
  const listed = !Array.isArray(slot.tools) ? available : available.filter((t) => new Set(slot.tools).has(t.function.name))
  // v2.7 Code Mode: native slots never see run_code; a code slot sees only
  // run_code (its program reaches the rest through the bridge, which checks
  // this same list at call time); both is both.
  const mode = slot.codeMode ?? 'native'
  if (mode === 'native') {
    // The same array back when nothing was stripped: callers compare by identity.
    const stripped = listed.filter((t) => t.function.name !== 'run_code')
    return stripped.length === listed.length ? listed : stripped
  }
  if (mode === 'code') return listed.filter((t) => t.function.name === 'run_code')
  return listed
}

/** What a program may call through the bridge: the slot's list, minus the sandbox's own tools. */
export function bridgeToolsForSlot(slot: Pick<ModelConfig, 'tools' | 'codeMode'>, available: ToolSchema[]): ToolSchema[] {
  const listed = !Array.isArray(slot.tools) ? available : available.filter((t) => new Set(slot.tools).has(t.function.name))
  return listed.filter((t) => !BRIDGE_EXCLUDED.has(t.function.name))
}

/**
 * The schemas a slot may put on the wire, computed in the renderer.
 *
 * The same two filters main/ipc/tools.ts applies to `tools:list` — the global
 * Settings → Tools toggles, then the slot's own allowlist — but synchronous,
 * because the composer's context meter re-reads it on every keystroke and an
 * IPC round trip per keystroke is not a meter. The wire list is still whatever
 * `tools:list` returns; this is a prediction of it, and the only thing it is
 * used for is counting tokens.
 */
export function schemasAvailableTo(
  slot: Pick<ModelConfig, 'tools'> | undefined,
  toggles: ToolToggles | undefined
): ToolSchema[] {
  if (!slot || !toggles) return []
  const enabled = TOOL_SCHEMAS.filter((t) => toggles[t.function.name as keyof ToolToggles])
  return toolsForSlot(slot, enabled)
}

/**
 * Tell the model, in the tool description, how many times it may call the tool
 * this turn.
 *
 * v1.4.5. The per-turn budgets are enforced but were never disclosed, so the
 * model could only discover them by being refused. Measured on a route-planning
 * turn: five `web_search` calls issued at once against a budget of three, then
 * three `fetch_webpage` against a budget of two, then two more searches — seven
 * of twelve calls rejected across three wasted rounds and about two minutes,
 * and the answer that followed filled the resulting gaps from memory.
 *
 * Budgets before work, disclosed before the stop rather than only at it — the
 * same principle the refusal message already follows, moved earlier.
 */
export function withBudgetNotes(
  tools: ToolSchema[],
  budgets: Record<string, number>
): ToolSchema[] {
  return tools.map((t) => {
    const budget = budgets[t.function.name]
    if (!budget) return t
    return {
      ...t,
      function: {
        ...t.function,
        description:
          `${t.function.description}\n` +
          `Budget: at most ${budget} call${budget === 1 ? '' : 's'} per turn. Plan for that — ` +
          `calls beyond it are refused, and the refusal is not a source.`
      }
    }
  })
}

/**
 * Always-on tools (strategy Layer 1b): cheap, zero-argument, and useful on
 * almost any turn, so they ride every turn regardless of embedding rank.
 * Derived from the tool table (each tool's `alwaysOn`, with its rationale —
 * see date_calculator's v1.4.6 note); re-exported here so callers keep one
 * import site.
 */
import { ALWAYS_ON_TOOLS } from '../../../shared/tools'
export { ALWAYS_ON_TOOLS } from '../../../shared/tools'

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
 * Below this spread across the top candidates, the ranking is noise.
 *
 * Measured against nomic-embed-text-v1.5 on 2026-08-12, cosine similarity
 * between real user turns and the tool descriptions:
 *
 *   "1"                          spread 0.014   top pick: web_search
 *   "lets flush out next steps"  spread 0.025   top pick: finance_calculator
 *   "yes"                        spread 0.056   top pick: memory_search
 *   sales-presentation request   spread 0.088   top pick: finance_calculator
 *   "what is the weather..."     spread 0.091   top pick: get_current_datetime
 *   "email campaign copy"        spread 0.184   top pick: deep_research
 *   "read the file at ~/notes"   spread 0.191   top pick: read_file
 *
 * The bottom three are indistinguishable from a coin flip — the winners are
 * separated by less than a rounding error, and a different one wins each turn.
 * That was visible in a measured session as `list_notes`, then `list_directory`,
 * then `create_note` riding three consecutive turns of a conversation about a
 * sales deck: tools nothing in the conversation called for, and a tool list
 * that moved every turn. Chat templates render tools into the leading block, so
 * each reshuffle also discarded the prompt cache for the whole conversation.
 */
const MIN_RANK_SPREAD = 0.07

/**
 * Did the ranking actually discriminate? Compares the best score against the
 * one at the cut line, which is the comparison that decides whether the subset
 * changes at all.
 */
export function rankingIsDecisive(
  scores: Record<string, number> | null,
  cap: number = TURN_TOOL_CAP
): boolean {
  if (scores === null) return false
  const ranked = Object.values(scores).sort((a, b) => b - a)
  if (ranked.length <= cap) return true
  return ranked[0] - ranked[cap - 1] >= MIN_RANK_SPREAD
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

/**
 * v1.6: guarantee named tools are in the turn's set. When the app has just
 * profiled a data file and told the model "compute with run_python", the tool
 * must be on the wire — measured: the embedding rank dropped run_python for
 * "which region had the highest revenue" and a 9B model spent five minutes
 * reasoning that it had no way to compute. Forced tools take the place of the
 * lowest-ranked non-always-on picks so the cap still holds; wire order is kept.
 */
export function withForcedTools(
  available: ToolSchema[],
  selected: ToolSchema[],
  forced: readonly string[],
  cap: number = TURN_TOOL_CAP
): ToolSchema[] {
  const want = forced.filter((n) => available.some((t) => t.function.name === n))
  if (want.length === 0) return selected
  const names = new Set(selected.map((t) => t.function.name))
  const alwaysOn = new Set(ALWAYS_ON_TOOLS)
  for (const n of want) names.add(n)
  // Over the cap: drop optional picks (not always-on, not forced) from the
  // end of the wire order until it fits.
  const optional = selected.map((t) => t.function.name).filter((n) => !alwaysOn.has(n) && !want.includes(n))
  while (names.size > cap && optional.length > 0) names.delete(optional.pop()!)
  return available.filter((t) => names.has(t.function.name))
}
