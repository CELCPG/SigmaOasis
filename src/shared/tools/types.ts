/**
 * The single-declaration tool vocabulary (STRATEGY-harness-adoptions, Tier 1).
 *
 * One ToolMeta per tool carries everything the old name-keyed tables stated
 * separately: the wire schema the model sees, the Settings label, the toggle
 * default, the per-turn budget, and always-on / source-tool membership. Every
 * table the app uses — TOOL_SCHEMAS, ToolToggles, DEFAULT_TOOL_TOGGLES,
 * TOOL_TURN_BUDGETS, ALWAYS_ON_TOOLS, SOURCE_TOOLS, TOOL_LABELS — is derived
 * in index.ts, so a tool exists exactly once and cannot drift.
 *
 * This module is pure data. It must stay importable without Electron and
 * without `node:` builtins: the tool-choice eval harness and the node:test
 * suite both read it outside the app, and the renderer imports it directly.
 */

export interface ToolMeta {
  readonly name: string
  /** Settings → Tools checkbox label. */
  readonly label: string
  /**
   * The decision-rule description the model sees (strategy Layer 1c): when to
   * reach for the tool, when *not* to — naming the correct alternative — and
   * one canonical argument example.
   */
  readonly description: string
  /** JSON-schema `parameters` object, exactly as sent on the wire. */
  readonly parameters: Record<string, unknown>
  /** Global toggle default for Settings → Tools. */
  readonly toggleDefault: boolean
  /**
   * Per-turn budget (Layer 3c), checked before the call and disclosed in the
   * tool description via withBudgetNotes(). Absent = covered by the iteration
   * cap and repeat detection alone.
   */
  readonly turnBudget?: number
  /**
   * Rides every turn regardless of embedding rank (Layer 1b): cheap,
   * zero-argument, useful on almost any turn.
   */
  readonly alwaysOn?: boolean
  /**
   * A successful call counts as consulting a source for the unverified badge:
   * text or figures the model can quote instead of recall — and only when it
   * came back with something. See `emptyResultLead`.
   */
  readonly isSource?: boolean
  /**
   * The opening words this tool's own handler prints when the call succeeded
   * and found nothing — no hits, no passages. The handler builds that output
   * from this string and the source check reads it back off the record, so
   * "the call worked" and "it supplied something" cannot drift apart.
   */
  readonly emptyResultLead?: string
}

export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}
