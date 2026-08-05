import type { SamplingSettings } from '../types'

/**
 * v1.2: temperature presets — make the factual/creative trade-off legible to
 * users who should not have to know what temperature is.
 *
 * Lower temperature means fewer invented facts (pure recall at 0.7 measurably
 * increases confabulation on small local models — the v1.1 grounding work);
 * higher means more varied prose. The numeric input stays available; presets
 * are one-click starting points, not a cage.
 */

export interface TemperaturePreset {
  label: string
  value: number
  /** One-line explanation shown on hover. */
  hint: string
}

export const TEMPERATURE_PRESETS: TemperaturePreset[] = [
  {
    label: 'Factual',
    value: 0.3,
    hint: 'Fewer invented facts; steadier, more literal answers. Best for research, code, and numbers.'
  },
  {
    label: 'Balanced',
    value: 0.5,
    hint: 'Some variety without much drift. A reasonable default for general chat.'
  },
  {
    label: 'Creative',
    value: 0.8,
    hint: 'More varied and surprising prose — at the cost of more confabulation on factual recall.'
  }
]

/**
 * Which preset a temperature corresponds to, for highlighting the active chip.
 * Exact match only: a hand-tuned 0.42 highlights nothing — it is custom, and
 * pretending it is "Balanced" would misdescribe what the user set.
 */
export function activePreset(temperature: number): TemperaturePreset | null {
  return TEMPERATURE_PRESETS.find((p) => p.value === temperature) ?? null
}

// ---- Family recipes (v1.5) ----------------------------------------------------

/**
 * The sampling settings a model family's authors published for it.
 *
 * Through v1.4 this app sent temperature and top_p and nothing else, which
 * means every model ran with top-k disabled — not a neutral choice, because
 * the families here are tuned around a specific top-k and misbehave without
 * one. Qwen3 is the sharp case: without top_k 20 it falls into repetition
 * loops, and a repetition loop is the most expensive possible way to produce a
 * worse answer. It reads to the user as the model being slow.
 *
 * These fill in only what the user left on auto (-1). Nothing here overwrites
 * a value someone chose, and `temperature`/`topP` are used only by the
 * explicit "recommended" action in Settings — this app deliberately runs
 * colder than any of these recipes suggest, because pure recall at their
 * temperatures measurably confabulates more on small local models (v1.1).
 */
export interface SamplingRecipe {
  temperature: number
  topP: number
  topK: number
  minP: number
}

interface FamilyRecipe {
  /** Matched against the model id. */
  pattern: RegExp
  /** Shown in Settings, so the user can see whose recipe they are applying. */
  label: string
  recipe: SamplingRecipe
}

const FAMILY_RECIPES: FamilyRecipe[] = [
  {
    pattern: /qwen[-_]?3/i,
    label: 'Qwen3',
    recipe: { temperature: 0.7, topP: 0.8, topK: 20, minP: 0 }
  },
  {
    pattern: /gemma[-_]?[34]/i,
    label: 'Gemma',
    recipe: { temperature: 1.0, topP: 0.95, topK: 64, minP: 0 }
  },
  {
    pattern: /llama[-_]?3/i,
    label: 'Llama 3',
    recipe: { temperature: 0.6, topP: 0.9, topK: 40, minP: 0 }
  },
  {
    pattern: /mistral|magistral|ministral/i,
    label: 'Mistral',
    recipe: { temperature: 0.7, topP: 0.95, topK: 40, minP: 0 }
  }
]

/** The published recipe for a model id, or null when the family is unknown. */
export function recommendedSampling(modelId: string): FamilyRecipe | null {
  return FAMILY_RECIPES.find((f) => f.pattern.test(modelId)) ?? null
}

/** What actually goes on the wire: the user's settings, with auto resolved. */
export interface ResolvedSampling {
  temperature: number
  topP: number
  maxTokens: number
  seed: number | null
  /** 0 means "do not send it" — either disabled, or no recipe to draw on. */
  topK: number
  minP: number
}

/**
 * Resolve `-1` (auto) against the model's family recipe.
 *
 * An unknown family resolves auto to 0 — off, exactly as it behaved through
 * v1.4. Guessing a top-k for a model nobody here has characterized would be a
 * silent change to how it decodes, which is the opposite of the point.
 */
export function resolveSampling(sampling: SamplingSettings, modelId: string): ResolvedSampling {
  const family = recommendedSampling(modelId)
  return {
    temperature: sampling.temperature,
    topP: sampling.topP,
    maxTokens: sampling.maxTokens,
    seed: sampling.seed,
    topK: sampling.topK < 0 ? (family?.recipe.topK ?? 0) : sampling.topK,
    minP: sampling.minP < 0 ? (family?.recipe.minP ?? 0) : sampling.minP
  }
}
