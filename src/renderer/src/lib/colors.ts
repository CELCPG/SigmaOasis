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
  border: string
  bgSoft: string
}

/*
 * The badge inks are the light-theme half of each pair. A -600 role badge on
 * its own 15%-tinted pill measures 4.3:1 (blue), 4.4:1 (purple) and 2.8:1
 * (green) over the glass panel — the name of the role that answered, below AA.
 * One step darker clears it; green needs two, because green-700 is still only
 * 4.3:1 on a pale green pill. The dark-theme -400s were already 6.5:1.
 *
 * These are *label* colours — which role answered — not status. Status ink goes
 * through `text-ink-danger|warn|ok`, which are theme-aware; a label palette is
 * a fixed set of hues, so it stays in raw Tailwind steps and earns its keep by
 * being measured on the pill it actually renders on. v2.2 dropped the unused
 * `text` member, whose `text-<hue>-500` was 2.2–3.9:1 and rendered nowhere.
 */
export const ACCENT: Record<AccentColor, AccentSet> = {
  blue: {
    dot: 'bg-blue-500',
    ring: 'ring-blue-500',
    badge: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
    border: 'border-blue-500/40',
    bgSoft: 'bg-blue-500/10'
  },
  purple: {
    dot: 'bg-purple-500',
    ring: 'ring-purple-500',
    badge: 'bg-purple-500/15 text-purple-700 dark:text-purple-400',
    border: 'border-purple-500/40',
    bgSoft: 'bg-purple-500/10'
  },
  green: {
    dot: 'bg-green-500',
    ring: 'ring-green-500',
    badge: 'bg-green-500/15 text-green-800 dark:text-green-400',
    border: 'border-green-500/40',
    bgSoft: 'bg-green-500/10'
  }
}
