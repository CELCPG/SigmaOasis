import type { ToolCallRecord } from '../types'

/**
 * v1.13: making a citation the app produced followable.
 *
 * The library hands the model numbered passages — `[1] pack › doc · 31% in`,
 * each with the document's own `source:` line under it — and the turn block
 * tells it to "cite them by their bracketed number". It does: a measured tax
 * question came back with "[1]" and "[2]" in the body. Both resolved to
 * nothing. The strip under the reply listed the passages without their
 * numbers, so a marker had nothing to name; the IRS URL the lookup had
 * already retrieved was rendered nowhere at all; and nothing checked that a
 * marker named a passage that existed. A URL the model merely typed into
 * prose became a working link, while the one the app verified stayed dead.
 *
 * This module parses the locators back out of the app's own tool output. The
 * renderer uses them to turn an inline `[n]` into the passage it names, and
 * the grounding pass reports an `[n]` that names no retrieved passage — the
 * same class of finding as an invented figure or link, caught the same
 * mechanical way, with no model in the loop.
 */

export interface Citation {
  /** The bracketed number the model was given for this passage. */
  index: number
  /** The citation line: pack › document › section · N% in. */
  label: string
  /** The document's locator — a URL for a published pack, a path for a folder pack. */
  source?: string
  /** The source when it is a web URL: the only kind this app ever makes clickable. */
  href?: string
}

/** The `[n] citation` line that opens each passage block of a lookup result. */
const PASSAGE_HEADER = /^\[(\d{1,3})\][ \t]+(\S.*)$/gm
/** The `source:` line the formatter indents directly under that header. */
const PASSAGE_SOURCE = /^\n[ \t]+source:[ \t]*(\S+)/

/**
 * A bracketed marker in prose. Not after a word character or a closing
 * bracket, so `items[1]` and `m[0][1]` stay array indexing, and not before
 * `(`, which would be a markdown link.
 */
export const CITATION_MARKER = /(?<![\w\])])\[(\d{1,3})\](?!\()/g

const FENCED_CODE = /```[\s\S]*?(?:```|$)/g
const INLINE_CODE = /`[^`\n]*`/g

/** Only http(s) sources are linkable — a folder pack's source is a local path. */
export function webSource(source: string | undefined): string | undefined {
  if (!source) return undefined
  try {
    const { protocol } = new URL(source)
    return protocol === 'http:' || protocol === 'https:' ? source : undefined
  } catch {
    return undefined
  }
}

/** The passages one `reference_lookup` result handed over, in the order it numbered them. */
export function parseCitations(output: string): Citation[] {
  const out: Citation[] = []
  for (const m of output.matchAll(PASSAGE_HEADER)) {
    const source = PASSAGE_SOURCE.exec(output.slice(m.index + m[0].length))?.[1]
    const href = webSource(source)
    out.push({
      index: Number(m[1]),
      label: m[2].trim(),
      ...(source ? { source } : {}),
      ...(href ? { href } : {})
    })
  }
  return out
}

/**
 * Every passage this turn's library lookups produced. Two lookups both number
 * from [1]; the first one to claim a number keeps it, which is also how the
 * model read them — it saw the earlier block first.
 */
export function retrievedCitations(records: ToolCallRecord[]): Citation[] {
  const byIndex = new Map<number, Citation>()
  for (const r of records) {
    if (r.name !== 'reference_lookup' || r.status !== 'done') continue
    for (const c of parseCitations(r.result ?? '')) {
      if (!byIndex.has(c.index)) byIndex.set(c.index, c)
    }
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index)
}

/** The bracketed numbers a reply cites, code blocks excluded. */
export function citedIndices(answer: string): number[] {
  const prose = answer.replace(FENCED_CODE, ' ').replace(INLINE_CODE, ' ')
  const seen = new Set<number>()
  for (const m of prose.matchAll(CITATION_MARKER)) seen.add(Number(m[1]))
  return [...seen].sort((a, b) => a - b)
}

/**
 * Markers the reply used that name no retrieved passage.
 *
 * Gated on something actually having been retrieved: with no lookup behind it
 * a `[1]` is the model's own footnote and none of this check's business. When
 * passages *were* handed over and the reply cites a number that is not among
 * them, the citation points at nothing — an invented source, told in the one
 * notation the reader is most likely to trust.
 */
export function danglingCitations(answer: string, retrieved: Citation[]): string[] {
  if (retrieved.length === 0) return []
  const known = new Set(retrieved.map((c) => c.index))
  return citedIndices(answer)
    .filter((i) => !known.has(i))
    .map((i) => `[${i}]`)
}
