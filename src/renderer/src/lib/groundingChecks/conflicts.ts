// Split out of lib/toolGrounding.ts (v2.4): the "conflicts" section. Behaviour-neutral —
// every declaration is the one that lived there, moved. lib/toolGrounding.ts re-exports
// all of them, so callers and tests are unchanged.

import type { ToolCallRecord } from '../../types'
import { NUMERIC_TOOLS } from './report'



// ---- cross-tool figure conflicts (v1.12) --------------------------------------

/**
 * Two numeric tools stating different values for the same labelled figure in
 * one turn. Measured live on market_data's first real outing: the tool said
 * "period return (6mo): 14.61%" and the model's own run_python printed
 * "Period Return: -8.99%" — same turn, same label, wildly different numbers.
 * The reply happened to relay the right one, but nothing would have said a
 * word if it had picked the wrong one. This check makes the disagreement
 * itself visible; it does not adjudicate which side is right.
 *
 * Deliberately conservative: only figures written as an explicit
 * `label: value` line, only exact normalized-label matches across DIFFERENT
 * tool calls, only like units (% with %, $ with $), and only disagreements
 * beyond both a relative and an absolute threshold. A false "conflict" badge
 * teaches the reader to dismiss the badge — the recurring lesson of this file.
 */
interface LabeledFigure {
  label: string
  value: number
  unit: '%' | '$' | ''
  /** As written, for the report. */
  shown: string
}

const LABELED_FIGURE =
  /^[\s\-–•*]*([A-Za-z][A-Za-z0-9 /_'&.-]{3,48}?)(?:\s*\([^)]{0,24}\))?\s*[:=]\s*(\$)?\s*(-?\d[\d,]*(?:\.\d+)?)\s*(%)?/gm

function normalizeFigureLabel(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}

export function labeledFiguresIn(text: string): LabeledFigure[] {
  const out: LabeledFigure[] = []
  for (const m of text.matchAll(LABELED_FIGURE)) {
    const value = Number(m[3]!.replace(/,/g, ''))
    if (!Number.isFinite(value)) continue
    const label = normalizeFigureLabel(m[1]!)
    if (label.length < 4) continue
    out.push({
      label,
      value,
      unit: m[4] ? '%' : m[2] ? '$' : '',
      shown: `${m[1]!.trim()}: ${m[2] ?? ''}${m[3]}${m[4] ?? ''}`
    })
  }
  return out
}

/** Disagreement thresholds: beyond both, or it is rounding, not conflict. */
const CONFLICT_REL = 0.01
const CONFLICT_ABS = 0.02
const MAX_CONFLICTS = 3

export function conflictingToolFigures(records: ToolCallRecord[]): string[] {
  const numeric = records.filter((r) => NUMERIC_TOOLS.has(r.name) && r.status === 'done' && r.result)
  if (numeric.length < 2) return []
  const perRecord = numeric.map((r) => ({ name: r.name, figures: labeledFiguresIn(r.result ?? '') }))
  const conflicts: string[] = []
  const seen = new Set<string>()
  for (let a = 0; a < perRecord.length; a++) {
    for (let b = a + 1; b < perRecord.length; b++) {
      for (const fa of perRecord[a]!.figures) {
        for (const fb of perRecord[b]!.figures) {
          if (fa.label !== fb.label || fa.unit !== fb.unit) continue
          const abs = Math.abs(fa.value - fb.value)
          const rel = abs / Math.max(Math.abs(fa.value), Math.abs(fb.value), 1e-9)
          if (abs <= CONFLICT_ABS || rel <= CONFLICT_REL) continue
          const key = `${fa.label}|${fa.value}|${fb.value}`
          if (seen.has(key)) continue
          seen.add(key)
          conflicts.push(
            `${perRecord[a]!.name} says "${fa.shown}" but ${perRecord[b]!.name} says "${fb.shown}"`
          )
          if (conflicts.length >= MAX_CONFLICTS) return conflicts
        }
      }
    }
  }
  return conflicts
}
