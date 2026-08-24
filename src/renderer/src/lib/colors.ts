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

/*
 * The badge inks are the light-theme half of each pair. A -600 role badge on
 * its own 15%-tinted pill measures 4.3:1 (blue), 4.4:1 (purple) and 2.8:1
 * (green) over the glass panel — the name of the role that answered, below AA.
 * One step darker clears it; green needs two, because green-700 is still only
 * 4.3:1 on a pale green pill. The dark-theme -400s were already 6.5:1.
 */
export const ACCENT: Record<AccentColor, AccentSet> = {
  blue: {
    dot: 'bg-blue-500',
    ring: 'ring-blue-500',
    badge: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
    text: 'text-blue-500',
    border: 'border-blue-500/40',
    bgSoft: 'bg-blue-500/10'
  },
  purple: {
    dot: 'bg-purple-500',
    ring: 'ring-purple-500',
    badge: 'bg-purple-500/15 text-purple-700 dark:text-purple-400',
    text: 'text-purple-500',
    border: 'border-purple-500/40',
    bgSoft: 'bg-purple-500/10'
  },
  green: {
    dot: 'bg-green-500',
    ring: 'ring-green-500',
    badge: 'bg-green-500/15 text-green-800 dark:text-green-400',
    text: 'text-green-500',
    border: 'border-green-500/40',
    bgSoft: 'bg-green-500/10'
  }
}
