/**
 * v2.8: diff-reviewed writes — the pure half.
 *
 * `write_file` overwrites a whole file after a dialog that shows a path and a
 * character count. A reviewed write shows the reader exactly what changes:
 * the model proposes edits, the app computes the unified diff between the
 * file as it is and the file as it would be, the reader sees that diff in
 * the chat and applies or discards it. This module is the arithmetic: an
 * LCS line diff rendered as a unified patch, the search-and-replace edits a
 * small model can state reliably, and the counts the block shows.
 *
 * Pure: no filesystem, no Electron. The tool handler reads and writes; the
 * block renders; the tests cover the seams between them.
 */

export interface PatchEdit {
  /** Text that must occur exactly once in the file, or an empty string to append. */
  search: string
  replace: string
}

export interface PatchStats {
  added: number
  removed: number
  hunks: number
}

export const MAX_PATCH_CHARS = 200_000
export const MAX_DIFF_LINES = 4_000

/** Apply search-and-replace edits in order. Each search must match exactly once. */
export function applyEdits(original: string, edits: PatchEdit[]): { ok: true; text: string } | { ok: false; error: string } {
  let text = original
  for (const [i, e] of edits.entries()) {
    if (typeof e?.search !== 'string' || typeof e?.replace !== 'string') return { ok: false, error: `Edit ${i + 1} needs a search string and a replace string.` }
    if (e.search === '') {
      text = text.length === 0 || text.endsWith('\n') ? `${text}${e.replace}` : `${text}\n${e.replace}`
      continue
    }
    const first = text.indexOf(e.search)
    if (first < 0) return { ok: false, error: `Edit ${i + 1}: the search text was not found in the file. Quote it exactly as the file has it, including whitespace.` }
    const second = text.indexOf(e.search, first + e.search.length)
    if (second >= 0) return { ok: false, error: `Edit ${i + 1}: the search text occurs more than once; include more surrounding lines so it is unique.` }
    text = text.slice(0, first) + e.replace + text.slice(first + e.search.length)
  }
  if (text.length > MAX_PATCH_CHARS) return { ok: false, error: `The result would be over ${MAX_PATCH_CHARS.toLocaleString('en-US')} characters.` }
  return { ok: true, text }
}

function splitLines(s: string): string[] {
  if (s === '') return []
  const lines = s.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Longest-common-subsequence alignment of two line arrays, as a list of ops. */
function diffLines(a: string[], b: string[]): { op: ' ' | '-' | '+'; line: string }[] {
  const n = a.length
  const m = b.length
  // Trim common prefix and suffix first: most edits touch a small region.
  let start = 0
  while (start < n && start < m && a[start] === b[start]) start++
  let endA = n
  let endB = m
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const ops: { op: ' ' | '-' | '+'; line: string }[] = []
  for (let i = 0; i < start; i++) ops.push({ op: ' ', line: a[i]! })
  // LCS over the middle (bounded; beyond the bound the middle is replaced whole).
  if (midA.length * midB.length > 4_000_000) {
    for (const l of midA) ops.push({ op: '-', line: l })
    for (const l of midB) ops.push({ op: '+', line: l })
  } else {
    const rows = midA.length + 1
    const cols = midB.length + 1
    const table = new Uint32Array(rows * cols)
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        table[i * cols + j] = midA[i] === midB[j] ? table[(i + 1) * cols + j + 1]! + 1 : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        ops.push({ op: ' ', line: midA[i]! })
        i++
        j++
      } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
        ops.push({ op: '-', line: midA[i]! })
        i++
      } else {
        ops.push({ op: '+', line: midB[j]! })
        j++
      }
    }
    while (i < midA.length) ops.push({ op: '-', line: midA[i++]! })
    while (j < midB.length) ops.push({ op: '+', line: midB[j++]! })
  }
  for (let i = endA; i < n; i++) ops.push({ op: ' ', line: a[i]! })
  return ops
}

/** A unified diff with `context` lines around each change, and its counts. */
export function unifiedDiff(oldText: string, newText: string, path: string, context = 3): { diff: string; stats: PatchStats } {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  const ops = diffLines(a, b)
  const out: string[] = [`--- ${path}`, `+++ ${path}`]
  let added = 0
  let removed = 0
  let hunks = 0
  let i = 0
  let lineA = 1
  let lineB = 1
  while (i < ops.length) {
    if (ops[i]!.op === ' ') {
      i++
      lineA++
      lineB++
      continue
    }
    // A hunk: from `context` lines before the first change to `context` after the last, merging changes closer than 2×context.
    let hStart = i
    let back = 0
    while (hStart > 0 && back < context && ops[hStart - 1]!.op === ' ') {
      hStart--
      back++
    }
    let hEnd = i
    let sinceChange = 0
    while (hEnd < ops.length) {
      if (ops[hEnd]!.op === ' ') {
        sinceChange++
        if (sinceChange > context * 2) break
      } else sinceChange = 0
      hEnd++
    }
    // trim trailing context beyond `context`
    let trailing = 0
    while (hEnd > i && ops[hEnd - 1]!.op === ' ' && trailing < 0) trailing++
    let tail = hEnd
    let ctx = 0
    while (tail > i && ops[tail - 1]!.op === ' ') {
      tail--
      ctx++
    }
    hEnd = Math.min(hEnd, tail + Math.min(ctx, context))
    const startA = lineA - back
    const startB = lineB - back
    let countA = 0
    let countB = 0
    const body: string[] = []
    for (let k = hStart; k < hEnd; k++) {
      const o = ops[k]!
      body.push(`${o.op}${o.line}`)
      if (o.op !== '+') countA++
      if (o.op !== '-') countB++
      if (o.op === '+') added++
      if (o.op === '-') removed++
    }
    out.push(`@@ -${startA},${countA} +${startB},${countB} @@`, ...body)
    hunks++
    // advance line counters past the hunk
    for (let k = i; k < hEnd; k++) {
      const o = ops[k]!
      if (o.op !== '+') lineA++
      if (o.op !== '-') lineB++
    }
    i = hEnd
    if (out.length > MAX_DIFF_LINES) {
      out.push(`… diff truncated at ${MAX_DIFF_LINES} lines`)
      break
    }
  }
  return { diff: out.join('\n'), stats: { added, removed, hunks } }
}

/** One line for the block header: "+12 −3 in 2 hunks". */
export function describeStats(s: PatchStats, isNew: boolean): string {
  if (isNew) return `new file, ${s.added} line${s.added === 1 ? '' : 's'}`
  return `+${s.added} −${s.removed} in ${s.hunks} hunk${s.hunks === 1 ? '' : 's'}`
}
