import type { AccentColor } from '../types'

/**
 * Per-role accent colors. Class strings are written out in full so Tailwind's
 * content scan picks them up — do not build them dynamically.
 */
export const ACCENT_KEYS: AccentColor[] = ['blue', 'purple', 'green']

export interface AccentSet {
  dot: string
  ring: string
  badge: string
  text: string
  border: string
  bgSoft: string
}

export const ACCENT: Record<AccentColor, AccentSet> = {
  blue: {
    dot: 'bg-blue-500',
    ring: 'ring-blue-500',
    badge: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
    text: 'text-blue-500',
    border: 'border-blue-500/40',
    bgSoft: 'bg-blue-500/10'
  },
  purple: {
    dot: 'bg-purple-500',
    ring: 'ring-purple-500',
    badge: 'bg-purple-500/15 text-purple-600 dark:text-purple-400',
    text: 'text-purple-500',
    border: 'border-purple-500/40',
    bgSoft: 'bg-purple-500/10'
  },
  green: {
    dot: 'bg-green-500',
    ring: 'ring-green-500',
    badge: 'bg-green-500/15 text-green-600 dark:text-green-400',
    text: 'text-green-500',
    border: 'border-green-500/40',
    bgSoft: 'bg-green-500/10'
  }
}
