/**
 * The single tool table and everything derived from it.
 *
 * TOOL_DEFS order is the wire order — the exact sequence LM Studio sees in
 * TOOL_SCHEMAS. It is KV-cache- and eval-relevant: the tool-choice eval and
 * the trace schema hash both fingerprint this list, so reordering or rewording
 * a definition is a measured change, not a cosmetic one. Domain grouping
 * mirrors src/main/ipc/toolHandlers/*.
 *
 * Descriptions are decision rules, not nameplates (strategy Layer 1c): each
 * says when to reach for the tool, when *not* to — naming the correct
 * alternative — and gives one canonical argument example. Small models degrade
 * sharply on undifferentiated tool lists; the confusion pairs these
 * descriptions attack explicitly are web_search vs deep_research (one lookup
 * vs a cited campaign), fetch_webpage vs web_search (URL in hand vs not),
 * memory_search vs read_note (recall vs retrieval), and list_directory vs
 * run_terminal_command (never shell out for something a typed tool does).
 */

import type { ToolSchema } from './types'
import { fileToolDefs } from './defs/files'
import { webToolDefs } from './defs/web'
import { researchToolDefs } from './defs/research'
import { calculatorToolDefs } from './defs/calculators'
import { noteToolDefs } from './defs/notes'
import { memoryToolDefs } from './defs/memory'
import { libraryToolDefs } from './defs/library'
import { workbenchToolDefs } from './defs/workbench'
import { shoppingToolDefs } from './defs/shopping'
import { marketToolDefs } from './defs/market'

export type { ToolMeta, ToolSchema } from './types'
export { DEFAULT_PASSAGES, MAX_PASSAGES } from './defs/web'

export const TOOL_DEFS = [
  ...fileToolDefs,
  ...webToolDefs,
  ...researchToolDefs,
  ...calculatorToolDefs,
  ...noteToolDefs,
  ...memoryToolDefs,
  ...libraryToolDefs,
  ...workbenchToolDefs,
  ...shoppingToolDefs,
  ...marketToolDefs
] as const

/** The exact tool-name union. Every Record keyed by it is compile-time exhaustive. */
export type ToolName = (typeof TOOL_DEFS)[number]['name']

/** Settings → Tools toggle map. The one declaration; main and renderer re-export it. */
export type ToolToggles = Record<ToolName, boolean>

/** What LM Studio sees. The tool-choice eval scores models against exactly this list. */
export const TOOL_SCHEMAS: ToolSchema[] = TOOL_DEFS.map((d) => ({
  type: 'function',
  function: { name: d.name, description: d.description, parameters: d.parameters }
}))

export const DEFAULT_TOOL_TOGGLES: ToolToggles = Object.fromEntries(
  TOOL_DEFS.map((d) => [d.name, d.toggleDefault])
) as ToolToggles

/**
 * Per-tool per-turn budgets (Layer 3c), checked *before* the call and stated
 * when hit — budgets before work, disclosed on the stop. Only egress and
 * expensive tools carry a budget; cheap local tools are covered by the
 * iteration cap and repeat detection.
 */
export const TOOL_TURN_BUDGETS: Record<string, number> = Object.fromEntries(
  TOOL_DEFS.filter((d) => 'turnBudget' in d && d.turnBudget !== undefined).map((d) => [
    d.name,
    d.turnBudget as number
  ])
)

/**
 * Always-on tools (strategy Layer 1b): cheap, zero-argument, and useful on
 * almost any turn, so they ride every turn regardless of embedding rank.
 */
export const ALWAYS_ON_TOOLS: readonly string[] = TOOL_DEFS.filter(
  (d) => 'alwaysOn' in d && d.alwaysOn === true
).map((d) => d.name)

/**
 * Tools whose successful use counts as consulting a source — text or figures
 * the model can quote instead of recall. The unverified-badge decision is
 * mechanical over this set.
 */
export const SOURCE_TOOLS: ReadonlySet<string> = new Set(
  TOOL_DEFS.filter((d) => 'isSource' in d && d.isSource === true).map((d) => d.name)
)

/** Settings → Tools checkbox labels, in TOOL_DEFS (wire) order. */
export const TOOL_LABELS: Record<ToolName, string> = Object.fromEntries(
  TOOL_DEFS.map((d) => [d.name, d.label])
) as Record<ToolName, string>
