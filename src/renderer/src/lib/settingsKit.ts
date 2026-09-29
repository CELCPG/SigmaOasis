/**
 * The pure parts of the Settings control kit (v4.0), kept out of React so
 * node:test can pin them: a stepper's clamp, a danger row's two-click arm, a
 * segmented control's keyboard model, and the settings index every Row
 * registers in. The components in components/settings/kit/ only draw these.
 */

// ---- Row metadata and the settings index --------------------------------------

/** What a settings row is, apart from its control: enough to search for it and link to it. */
export interface RowMeta {
  /** `<tab>.<key>` — stable across renames of the label, so a deep link survives copy changes. */
  id: string
  label: string
  help?: string
  /** Words a reader might type that the label and help do not contain. */
  keywords?: string[]
}

/**
 * The rows a tab holds, declared once beside the tab and used twice: by the
 * tab's Rows (label and help), and by the settings index (search, deep links).
 * Ids are `<tab>.<key>`, so two tabs may both have a `theme` without colliding.
 */
export function defineRows<const T extends Record<string, Omit<RowMeta, 'id'>>>(
  tab: string,
  rows: T
): { [K in keyof T]: RowMeta } {
  const out = {} as { [K in keyof T]: RowMeta }
  for (const key of Object.keys(rows) as (keyof T & string)[]) {
    out[key] = { ...rows[key], id: `${tab}.${key}` }
  }
  return out
}

/** Every declared row, in declaration order. Tabs register at module load. */
const INDEX: RowMeta[] = []
const SEEN = new Set<string>()

export function registerRows(rows: Record<string, RowMeta>): void {
  for (const meta of Object.values(rows)) {
    if (SEEN.has(meta.id)) continue
    SEEN.add(meta.id)
    INDEX.push(meta)
  }
}

export function settingsIndex(): readonly RowMeta[] {
  return INDEX
}

/** The tab a row id belongs to: the part before the first dot. */
export function tabOfRow(id: string): string {
  const dot = id.indexOf('.')
  return dot < 0 ? id : id.slice(0, dot)
}

/**
 * Rows whose label, help or keywords contain every word of `query`, case-
 * insensitively. An empty query matches nothing: the search field is a filter,
 * and "everything" is what the rail already shows.
 */
export function searchRows(rows: readonly RowMeta[], query: string): RowMeta[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  return rows.filter((r) => {
    const hay = `${r.label} ${r.help ?? ''} ${(r.keywords ?? []).join(' ')} ${r.id}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

// ---- Stepper -------------------------------------------------------------------

/**
 * A typed number, or NaN for a blank — `Number('')` is 0, which would turn an
 * emptied field into the floor rather than leaving the value alone.
 */
export function parseTyped(text: string): number {
  return text.trim() === '' ? NaN : Number(text)
}

/**
 * What a typed or stepped value becomes: clamped to [min, max], snapped to the
 * step from `min`, and never NaN — an empty field commits the value it had.
 */
export function clampStep(value: number, current: number, min: number, max: number, step = 1): number {
  if (!Number.isFinite(value)) return current
  const snapped = step > 0 ? min + Math.round((value - min) / step) * step : value
  const bounded = Math.min(max, Math.max(min, snapped))
  // Steps like 0.1 accumulate binary noise; round to the step's own precision.
  const decimals = step > 0 && step < 1 ? Math.ceil(-Math.log10(step)) : 0
  return Number(bounded.toFixed(decimals))
}

// ---- DangerRow -------------------------------------------------------------------

/** How long an armed danger action stays armed before it disarms itself. */
export const DANGER_ARM_MS = 4000

export type DangerState = { armed: false } | { armed: true; since: number }

/**
 * The two-click rule Reset to defaults has followed since v2.x, as a state
 * machine: the first click arms, a second click within DANGER_ARM_MS acts,
 * and a click after that window arms again rather than acting. Nothing
 * destructive happens on one click, ever.
 */
export function dangerClick(state: DangerState, now: number): { state: DangerState; act: boolean } {
  if (state.armed && now - state.since <= DANGER_ARM_MS) return { state: { armed: false }, act: true }
  return { state: { armed: true, since: now }, act: false }
}

// ---- Segmented -------------------------------------------------------------------

/**
 * The radiogroup keyboard model: arrows move and select, Home and End jump,
 * and movement wraps. Returns the index to select, or null for a key the
 * control does not handle (so Tab still leaves it).
 */
export function segmentedKey(key: string, index: number, count: number): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (index + 1) % count
    case 'ArrowLeft':
    case 'ArrowUp':
      return (index - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

// ---- Toast -----------------------------------------------------------------------

/** How long an apply-as-you-go toast offers Undo. */
export const TOAST_MS = 4000

/** What one applied change says at the panel's foot, and how to undo it. */
export interface ChangeToast {
  id: number
  label: string
  /** The value as the reader would say it: "Dark", "On", "15 px". */
  value: string
  undo: () => void
}

/**
 * The first leaf that differs between two settings objects, depth first —
 * what a toast shows for a change made through a nested partial such as
 * `{ plan: { confirmPlan: true } }`. Arrays are compared as wholes: a model
 * slot's whole change is one change.
 */
export function firstChange(prev: unknown, next: unknown): { path: string; value: unknown } | null {
  const walk = (a: unknown, b: unknown, path: string[]): { path: string; value: unknown } | null => {
    if (a === b) return null
    const objects = a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)
    if (!objects) return { path: path.join('.'), value: b }
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)])
    for (const k of keys) {
      const hit = walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], [...path, k])
      if (hit) return hit
    }
    return null
  }
  return walk(prev, next, [])
}

/** The toasts on screen after one more arrives: newest last, at most `max`, the oldest dropped. */
export function pushToast(list: readonly ChangeToast[], toast: ChangeToast, max = 3): ChangeToast[] {
  const next = [...list, toast]
  return next.length > max ? next.slice(next.length - max) : next
}

/** A boolean, a number with a unit, or a short string, as a toast says it. */
export function describeValue(value: unknown, unit = ''): string {
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  if (typeof value === 'number') return unit ? `${value} ${unit}` : String(value)
  if (value === null || value === undefined || value === '') return 'empty'
  const text = String(value)
  return text.length > 40 ? `${text.slice(0, 37)}…` : text
}
