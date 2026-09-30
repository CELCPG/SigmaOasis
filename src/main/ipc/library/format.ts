import { EMPTY_RESULT_LEADS } from '../../../shared/tools'
import type { LibraryPassage, LookupOutcome } from './types'

// v4.2 (L1): what the model reads — citations, the stale-year note and the
// formatted lookup — split out of library.ts unchanged.

/** The citation line the model quotes: pack › document › section (position). */
export function citationOf(p: LibraryPassage): string {
  const parts = [p.packName, p.docTitle]
  if (p.section) parts.push(p.section)
  return `${parts.join(' › ')} · ${Math.round(p.position * 100)}% in`
}

/** Passages formatted for the model, with provenance the model must carry into its answer. */
/**
 * v4.1 (G5): the note a lookup ends with when a passage's figures are for an
 * earlier year than the reader's. Names the passages and the year and says
 * what to do; such a turn carries the web tools (lib/grounding.ts).
 */
export function staleYearNote(passages: LibraryPassage[], year: number): string | null {
  // By document, not by [n]: the renderer renumbers a turn's lookups
  // (renumberPassages), and a note is not a header it would move.
  const stale = new Map<string, number>()
  for (const p of passages) {
    if (p.appliesToYear !== undefined && p.appliesToYear < year) stale.set(p.docTitle, p.appliesToYear)
  }
  if (stale.size === 0) return null
  const named = [...stale].map(([title, y]) => `"${title}" (${y})`).join(', ')
  return (
    `${named} ${stale.size === 1 ? 'states figures for its year' : 'state figures for their years'}; ` +
    `it is now ${year}. Check the ${year} figures with web_search before quoting these as current, and name ` +
    'the year of any figure you quote.'
  )
}

export function formatLookup(outcome: LookupOutcome, query: string, year: number = new Date().getFullYear()): string {
  if (outcome.passages.length === 0) {
    // The lead is the tool table's, not this function's: the badge check reads
    // it back off the record to tell "worked" from "supplied something".
    return [
      `${EMPTY_RESULT_LEADS.get('reference_lookup')!} "${query}".`,
      ...outcome.notes,
      'Say plainly that the library has nothing on this; do not invent a reference.'
    ].join('\n')
  }
  const blocks = outcome.passages.map(
    (p, i) =>
      `[${i + 1}] ${citationOf(p)}` +
      (p.source ? `\n    source: ${p.source}` : '') +
      (p.date ? `\n    date: ${p.date}` : '') +
      (p.appliesToYear !== undefined ? `\n    applies to: ${p.appliesToYear}` : '') +
      (typeof p.checkedAt === 'number' ? `\n    checked: ${new Date(p.checkedAt).toISOString().slice(0, 10)}` : '') +
      (p.license ? `\n    license: ${p.license}` : '') +
      `\n    relevance ${p.score}\n${p.text}`
  )
  const head =
    `Reference passages for "${query}" from the local library (${outcome.mode === 'hybrid' ? 'semantic + keyword' : 'keyword'} ranking), most relevant first. ` +
    'These are the user\'s own installed reference documents, not the live web: cite the bracketed number and the document when you use one, quote figures, dosages and steps rather than paraphrasing them, and if the passages do not answer the question say so instead of filling the gap.'
  const stale = staleYearNote(outcome.passages, year)
  const notes = stale ? [...outcome.notes, stale] : outcome.notes
  return [head, '', ...blocks, ...(notes.length ? ['', ...notes.map((n) => `Note: ${n}`)] : [])].join('\n')
}
