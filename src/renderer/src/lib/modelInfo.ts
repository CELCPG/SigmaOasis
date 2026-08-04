import type { EvalScoreSummary, ModelInfo } from '../types'

/**
 * Presentation helpers for what LM Studio tells us about a model. Kept free of
 * React so the formatting — and, more importantly, the rules about what we do
 * and do not claim — can be tested directly.
 */

/** `32K`, `4.5K`, `900`. */
export function formatContextLength(tokens: number): string {
  if (tokens >= 1000) {
    const thousands = tokens / 1000
    return `${thousands >= 10 || Number.isInteger(thousands) ? Math.round(thousands) : thousands.toFixed(1)}K`
  }
  return String(tokens)
}

/**
 * The context window to budget against: what the model is actually loaded
 * with, falling back to what it supports. These differ often and by a lot —
 * a 128K model loaded at 4K will happily accept a request it then truncates,
 * so preferring the loaded value is the difference between a budget and a
 * guess. Undefined when the server did not report either.
 */
export function effectiveContextLength(model: ModelInfo | undefined): number | undefined {
  return model?.loadedContextLength ?? model?.maxContextLength
}

/**
 * The context window to actually budget against for a model slot: the user's
 * per-slot override when set, otherwise what the server reports. The override
 * exists for the two cases where the reported number is wrong — a server too
 * old to report at all, and a model loaded with a larger window than the
 * catalog advertises — and both make compaction fire at the wrong point.
 */
export function budgetContextLength(
  slot: { contextWindow: number | null } | undefined,
  catalogEntry: ModelInfo | undefined
): number | undefined {
  return slot?.contextWindow ?? effectiveContextLength(catalogEntry)
}

/**
 * Short capability suffix for a model row: quantization, context, loaded state.
 *
 * Deliberately silent about tool support. LM Studio reports no tool-use
 * capability field, and a badge claiming a model can call tools when it cannot
 * would send users to the wrong place when a model ignores every tool.
 */
export function describeModel(model: ModelInfo): string {
  const parts: string[] = []
  if (model.vision) parts.push('vision')
  if (model.quantization) parts.push(model.quantization)
  const context = effectiveContextLength(model)
  if (context) parts.push(`${formatContextLength(context)} ctx`)
  if (model.loaded) parts.push('loaded')
  return parts.join(' · ')
}

/** A model row as one line: `qwen3-8b — vision · Q4_K_M · 32K ctx · loaded`. */
export function modelLabel(model: ModelInfo): string {
  const detail = describeModel(model)
  return detail ? `${model.id} — ${detail}` : model.id
}

/**
 * Measured tool-choice scores as one line (Layer 0c):
 * `tool-choice 15/15 · args 100% · no spurious calls · no loops`.
 * Only the rates that say something are included; a rate with no fixtures
 * behind it (of: 0) is omitted rather than shown as a misleading 100%.
 */
export function describeEvalScore(score: EvalScoreSummary): string {
  const parts: string[] = []
  if (score.correctTool.of > 0) {
    parts.push(`tool-choice ${score.correctTool.hit}/${score.correctTool.of}`)
  }
  if (score.argValidity.of > 0) {
    parts.push(`args ${Math.round((score.argValidity.hit / score.argValidity.of) * 100)}%`)
  }
  if (score.spuriousCall.of > 0) {
    parts.push(
      score.spuriousCall.hit === 0
        ? 'no spurious calls'
        : `spurious calls ${score.spuriousCall.hit}/${score.spuriousCall.of}`
    )
  }
  if (score.loop.of > 0) {
    parts.push(score.loop.hit === 0 ? 'no loops' : `looped ${score.loop.hit}/${score.loop.of}`)
  }
  return parts.join(' · ')
}

/**
 * True only when LM Studio positively reported that the model cannot take
 * images. An unknown capability (older server, model not in the catalog) is
 * not a refusal — warning on "we don't know" would train users to dismiss the
 * warning that matters.
 */
export function knownToLackVision(model: ModelInfo | undefined): boolean {
  return Boolean(model && model.type && model.type !== 'vlm')
}
