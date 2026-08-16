import type { EvalScoreSummary } from '../types'
import { isLikelyReasoningModel } from './reasoning'
import { recommendedSampling } from './sampling'

/**
 * v1.5.1 Model profiles: what the app knows about a model family, in one place
 * and shown to the user.
 *
 * Small models differ far more than large ones — in whether they think out
 * loud, whether they call tools reliably, what sampling they were tuned for —
 * and the app already carried that knowledge in four places (the reasoning
 * splitter, the closed-think prefill in llm.ts, the sampling recipes, the
 * eval harness) without ever saying so. A profile gathers it, so the model
 * picker can state it plainly, and so features that should adapt (the
 * think-harder pass, tool exposure) have one thing to read.
 *
 * Two kinds of fact, kept apart: what is *measured* on this machine (the
 * tool-choice eval, when the user has run it) and what is a *prior* from the
 * family and size (a 4B model's tool calling is usually shaky). A measured
 * value always wins over a prior and the profile says which it is showing.
 */

export type ToolCallingLevel = 'reliable' | 'mixed' | 'unreliable' | 'unknown'

export interface ModelProfile {
  /** Family label, e.g. "Qwen3", or null when unrecognised. */
  family: string | null
  /** Parameter count in billions when the id says so (e.g. "9b"), else null. */
  sizeB: number | null
  /** Emits chain-of-thought the splitter separates. */
  reasoning: boolean
  /**
   * How the app keeps thinking out of tool/JSON calls: 'closed-think' = the
   * llm.ts prefill of an empty <think> block; 'native' = the model's own
   * control tokens; 'none' = not a reasoning family.
   */
  thinkingControl: 'closed-think' | 'native' | 'none'
  /** Published sampling recipe label, when the family has one. */
  samplingRecipe: string | null
  toolCalling: { level: ToolCallingLevel; basis: 'measured' | 'prior' | 'none'; detail: string }
  /**
   * Whether the think-harder pass is worth its cost by default for math and
   * logic on this model: small non-reasoning models gain the most from a
   * review pass; a large reasoning model already deliberates.
   */
  deliberationWorthwhile: boolean
  notes: string[]
}

const CLOSED_THINK_FAMILIES = /qwen3|deepseek[-_]?r1|r1[-_]?distill|magistral/i
const NATIVE_THINK_FAMILIES = /gemma[-_]?4|gpt[-_]?oss/i

const FAMILY_LABELS: { pattern: RegExp; label: string }[] = [
  { pattern: /qwen[-_]?3/i, label: 'Qwen3' },
  { pattern: /qwen/i, label: 'Qwen' },
  { pattern: /gemma[-_]?4/i, label: 'Gemma 4' },
  { pattern: /gemma/i, label: 'Gemma' },
  { pattern: /llama[-_]?3/i, label: 'Llama 3' },
  { pattern: /llama/i, label: 'Llama' },
  { pattern: /magistral|ministral|mistral|mixtral/i, label: 'Mistral' },
  { pattern: /deepseek[-_]?r1|r1[-_]?distill/i, label: 'DeepSeek-R1' },
  { pattern: /deepseek/i, label: 'DeepSeek' },
  { pattern: /gpt[-_]?oss/i, label: 'gpt-oss' },
  { pattern: /phi[-_]?\d/i, label: 'Phi' },
  { pattern: /smollm/i, label: 'SmolLM' },
  { pattern: /granite/i, label: 'Granite' }
]

/** "…-9b-…", "27B", "e4b" (Gemma effective size), "8x7b" → 7. */
export function parseSizeB(modelId: string): number | null {
  const m = modelId.match(/(?:^|[^a-z0-9])(?:e|\d+x)?(\d{1,3}(?:\.\d)?)b(?![a-z0-9])/i)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 && n < 1000 ? n : null
}

/**
 * Prior on tool calling from family and size. Deliberately coarse and stated
 * as a prior: the eval harness exists so this can be replaced by a measurement.
 */
function toolCallingPrior(family: string | null, sizeB: number | null): { level: ToolCallingLevel; detail: string } {
  if (sizeB !== null && sizeB < 4) return { level: 'unreliable', detail: 'models under ~4B usually mis-pick or malform tool calls' }
  if (sizeB !== null && sizeB < 8) return { level: 'mixed', detail: '4–8B models call tools but choose the wrong one or loop more often' }
  if (family && /Qwen3|Gemma 4|Llama 3|Mistral|gpt-oss/.test(family)) {
    return { level: 'reliable', detail: `${family} at this size usually calls tools well` }
  }
  if (sizeB !== null && sizeB >= 8) return { level: 'mixed', detail: 'size suggests usable tool calling; family not characterised' }
  return { level: 'unknown', detail: 'family and size unrecognised' }
}

/** Reduce a measured eval score to a level. */
export function toolCallingFromEval(score: EvalScoreSummary): { level: ToolCallingLevel; detail: string } {
  if (score.correctTool.of === 0) return { level: 'unknown', detail: 'no tool-choice fixtures run' }
  const rate = score.correctTool.hit / score.correctTool.of
  const spurious = score.spuriousCall.of > 0 ? score.spuriousCall.hit / score.spuriousCall.of : 0
  const loops = score.loop.of > 0 ? score.loop.hit / score.loop.of : 0
  const detail = `measured: tool-choice ${score.correctTool.hit}/${score.correctTool.of}` +
    (score.spuriousCall.of > 0 ? `, spurious ${score.spuriousCall.hit}/${score.spuriousCall.of}` : '') +
    (score.loop.of > 0 ? `, loops ${score.loop.hit}/${score.loop.of}` : '')
  if (rate >= 0.85 && spurious <= 0.15 && loops <= 0.1) return { level: 'reliable', detail }
  if (rate >= 0.6 && spurious <= 0.35) return { level: 'mixed', detail }
  return { level: 'unreliable', detail }
}

export function profileFor(modelId: string, evalScore?: EvalScoreSummary | null): ModelProfile {
  const family = FAMILY_LABELS.find((f) => f.pattern.test(modelId))?.label ?? null
  const sizeB = parseSizeB(modelId)
  const reasoning = isLikelyReasoningModel(modelId)
  const thinkingControl: ModelProfile['thinkingControl'] = CLOSED_THINK_FAMILIES.test(modelId)
    ? 'closed-think'
    : NATIVE_THINK_FAMILIES.test(modelId)
      ? 'native'
      : 'none'
  const recipe = recommendedSampling(modelId)
  const measured = evalScore ? toolCallingFromEval(evalScore) : null
  const toolCalling = measured && measured.level !== 'unknown'
    ? { ...measured, basis: 'measured' as const }
    : (() => {
        const prior = toolCallingPrior(family, sizeB)
        return { ...prior, basis: prior.level === 'unknown' ? ('none' as const) : ('prior' as const) }
      })()

  const notes: string[] = []
  if (reasoning) {
    notes.push(
      thinkingControl === 'closed-think'
        ? 'Reasoning model: chain-of-thought is separated from the answer, and suppressed with an empty think block for tool and JSON calls.'
        : 'Reasoning model: chain-of-thought is separated from the answer as it streams.'
    )
  }
  if (recipe) notes.push(`Published sampling recipe available (${recipe.label}); "auto" top-k/min-p follow it.`)
  if (sizeB !== null && sizeB <= 4) notes.push('Small model: the library, playbooks and think-harder pass matter most here.')

  return {
    family,
    sizeB,
    reasoning,
    thinkingControl,
    samplingRecipe: recipe?.label ?? null,
    toolCalling,
    // A big reasoning model already spends its own tokens deliberating; a
    // small or non-reasoning one gains the most from a second look.
    deliberationWorthwhile: !(reasoning && sizeB !== null && sizeB >= 20),
    notes
  }
}

/** One line for the model picker: `Qwen3 · 9B · reasoning · tools: reliable (measured)`. */
export function describeProfile(p: ModelProfile): string {
  const parts: string[] = []
  if (p.family) parts.push(p.family)
  if (p.sizeB !== null) parts.push(`${p.sizeB % 1 === 0 ? p.sizeB : p.sizeB.toFixed(1)}B`)
  if (p.reasoning) parts.push('reasoning')
  if (p.toolCalling.level !== 'unknown') parts.push(`tools: ${p.toolCalling.level}${p.toolCalling.basis === 'measured' ? ' (measured)' : ' (prior)'}`)
  return parts.join(' · ')
}
