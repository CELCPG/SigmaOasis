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
