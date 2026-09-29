/**
 * The one place a Settings control's look is decided (v4.0). Fourteen tabs had
 * four label sizes, four button paddings and three status palettes between
 * them; every class string a kit component uses is here, so a tab that
 * reaches for one of these cannot drift.
 */

/** A field, select or textarea: the surface, one padding, the ring from index.css. */
export const FIELD =
  'rounded-lg border border-black/10 bg-transparent px-3 py-2 text-sm text-ink-primary outline-none dark:border-white/10'
/** The same, sized for a control inside a list row. */
export const FIELD_COMPACT =
  'rounded-lg border border-black/10 bg-transparent px-2 py-1 text-xs text-ink-primary outline-none dark:border-white/10'

/** Labels: one size, one weight. */
export const LABEL = 'text-sm font-medium text-ink-primary'
/** Help under a label: one size, one ink. */
export const HELP = 'text-xs leading-relaxed text-ink-secondary'
/** A section's title. */
export const SECTION_TITLE = 'text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-tertiary'

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40'
const BUTTON_SIZE = { sm: 'px-2.5 py-1 text-xs', md: 'px-3 py-1.5 text-sm' } as const
const BUTTON_KIND = {
  primary: 'bg-accent text-white hover:bg-accent-hover disabled:hover:bg-accent',
  secondary:
    'border border-black/10 text-ink-primary hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/10',
  ghost: 'text-ink-secondary hover:bg-black/5 hover:text-ink-primary dark:hover:bg-white/10',
  danger:
    'border border-black/10 text-ink-danger hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/10'
} as const

export type ButtonKind = keyof typeof BUTTON_KIND
export type ButtonSize = keyof typeof BUTTON_SIZE

export function buttonClass(kind: ButtonKind = 'secondary', size: ButtonSize = 'sm'): string {
  return `${BUTTON_BASE} ${BUTTON_SIZE[size]} ${BUTTON_KIND[kind]}`
}

/** Status: one palette, through the ink variables so both themes read. */
export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'muted'
export const DOT_TONE: Record<Tone, string> = {
  ok: 'bg-[var(--text-ok)]',
  warn: 'bg-[var(--text-warn)]',
  danger: 'bg-[var(--text-danger)]',
  info: 'bg-[var(--text-info)]',
  muted: 'bg-ink-muted'
}
export const TEXT_TONE: Record<Tone, string> = {
  ok: 'text-ink-ok',
  warn: 'text-ink-warn',
  danger: 'text-ink-danger',
  info: 'text-ink-info',
  muted: 'text-ink-tertiary'
}
/** Surfaces carry the hue; the ink stays on the tone above. */
export const NOTICE_TONE: Record<Tone, string> = {
  ok: 'bg-emerald-500/10 border-emerald-500/25',
  warn: 'bg-amber-500/10 border-amber-500/30',
  danger: 'bg-red-500/10 border-red-500/25',
  info: 'bg-sky-500/10 border-sky-500/25',
  muted: 'bg-black/5 border-black/10 dark:bg-white/5 dark:border-white/10'
}

/** A card inside a tab: the glass surface at the small radius, one padding. */
export const CARD = 'glass-panel rounded-xl p-4'
