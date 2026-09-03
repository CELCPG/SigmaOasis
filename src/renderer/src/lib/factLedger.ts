import { claimKey } from '../../../shared/factLedger'
import type { ClaimClass, LedgerEntryDraft } from '../../../shared/factLedger'
import { measurementsIn } from '../../../shared/measurements'
import { parseCitations, webSource } from './citations'
import type { ToolCallRecord } from '../types'

/**
 * The capture side of the fact ledger (shared/factLedger.ts): which of a
 * reply's claims are worth keeping, and which source each one came from.
 *
 * A claim is a span of a known class — a price, a measurement, an address, a
 * phone number or email, a URL, a date — in a sentence of the reply, and it
 * is *verified* when a source the turn retrieved states the same value in
 * its own text. Presence only, never derivation: the ledger is a record of
 * what a source said, and a figure the model computed from a source has no
 * line in any source to point at. A claim the reply made from nowhere is not
 * captured; that is the grounding pass's business, not this module's.
 *
 * Pure. The main process writes the entries; this module only finds them.
 */

interface Source {
  url: string
  text: string
}

/** Every source with a URL this turn's records handed the model, with its text. */
export function sourcesIn(records: ToolCallRecord[]): Source[] {
  const out: Source[] = []
  for (const r of records) {
    if (r.status !== 'done' || !r.result) continue
    if (r.name === 'web_search') {
      // `n. title\n   url\n   [mark]\n   snippet` blocks, separated by blank lines.
      for (const block of r.result.split(/\n\n+/)) {
        const m = /^\d+\.\s+[^\n]*\n\s+(https?:\/\/\S+)/.exec(block)
        if (m) out.push({ url: m[1], text: block })
      }
    } else if (r.name === 'fetch_webpage') {
      const m = /^URL:\s+(\S+)/m.exec(r.result)
      if (m) out.push({ url: m[1], text: r.result })
    } else if (r.name === 'reference_lookup') {
      for (const c of parseCitations(r.result)) {
        const url = webSource(c.source)
        if (url && c.text) out.push({ url, text: c.text })
      }
    }
  }
  return out
}

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December'
const MONEY = /(?<![\w.])[$€£]\s?\d[\d,]*(?:\.\d{1,2})?(?![\w.])/g
const STREET = /\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Quay|Way|Boulevard|Blvd|Place|Pl|Square|Court|Ct)\b\.?/g
const PHONE = /(?<!\d)(?:\+\d{1,2}\s?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g
const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g
const URL_IN_PROSE = /https?:\/\/[^\s)\]>"']+/g
const DATE_LONG = new RegExp(`\\b(?:\\d{1,2}\\s+(?:${MONTHS})\\s+\\d{4}|(?:${MONTHS})\\s+\\d{1,2},?\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})\\b`, 'g')
const YEAR = /\b(?:1[5-9]|20)\d{2}\b/g
const HISTORICAL_CUE = /\b(founded|established|built|opened|born|incorporated|created|launched|first)\b/i

const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-Z0-9"“(\[$€£])/

/** The reply's sentences, with markdown furniture stripped, long enough to carry a claim. */
export function sentencesOf(reply: string): string[] {
  return reply
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+\.|#{1,6})\s+/, '').trim())
    .filter(Boolean)
    .flatMap((line) => line.split(SENTENCE_BREAK))
    .map((s) => s.trim())
    .filter((s) => s.length >= 12)
}

function normalizeSpan(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\.$/, '').trim().toLowerCase()
}

function stripDigits(text: string): string {
  return text.replace(/[^\d]/g, '')
}

/** Does the source's own text state this span? Per class, at the reply's precision. */
function sourceStates(claimClass: ClaimClass, span: string, source: Source): boolean {
  const text = source.text
  switch (claimClass) {
    case 'money': {
      const wanted = span.replace(/\s/g, '').replace(/,/g, '')
      return [...text.matchAll(MONEY)].some((m) => m[0].replace(/\s/g, '').replace(/,/g, '') === wanted)
    }
    case 'measurement': {
      const [stated] = measurementsIn(span)
      if (!stated) return false
      return measurementsIn(text).some((found) => found.unit === stated.unit && found.value === stated.value)
    }
    case 'contact': {
      if (span.includes('@')) return text.toLowerCase().includes(span.toLowerCase())
      return stripDigits(text).includes(stripDigits(span))
    }
    case 'url':
      return text.toLowerCase().includes(span.toLowerCase().replace(/\/$/, ''))
    default:
      return normalizeSpan(text).includes(normalizeSpan(span))
  }
}

function spansOf(sentence: string): { claimClass: ClaimClass; span: string }[] {
  const out: { claimClass: ClaimClass; span: string }[] = []
  const push = (claimClass: ClaimClass, re: RegExp): void => {
    for (const m of sentence.matchAll(re)) out.push({ claimClass, span: m[0] })
  }
  push('money', MONEY)
  push('address', STREET)
  push('contact', EMAIL)
  push('contact', PHONE)
  push('url', URL_IN_PROSE)
  push('date', DATE_LONG)
  // A bare year is a claim only when the sentence says what happened in it.
  if (HISTORICAL_CUE.test(sentence) && !DATE_LONG.test(sentence)) push('historical', YEAR)
  DATE_LONG.lastIndex = 0
  // Measurements, minus anything already claimed as money or a date.
  const taken = new Set(out.map((o) => o.span))
  for (const m of measurementsIn(sentence)) {
    if (!taken.has(m.raw) && !/^\d{4}$/.test(m.raw.trim())) out.push({ claimClass: 'measurement', span: m.raw })
  }
  return out
}

/**
 * The claims a reply made that a retrieved source states, one draft per
 * (class, question) key — the first sentence that carries a bound claim of a
 * class wins, so a reply that restates a price twice yields one entry.
 */
export function extractLedgerEntries(reply: string, records: ToolCallRecord[], question: string): LedgerEntryDraft[] {
  const sources = sourcesIn(records)
  if (sources.length === 0 || !question.trim()) return []
  const drafts = new Map<string, LedgerEntryDraft>()
  for (const sentence of sentencesOf(reply)) {
    for (const { claimClass, span } of spansOf(sentence)) {
      const key = claimKey(claimClass, question)
      if (drafts.has(key)) continue
      const source = sources.find((s) => sourceStates(claimClass, span, s))
      if (!source) continue
      drafts.set(key, { key, claimClass, value: normalizeSpan(span), sentence, url: source.url, question })
    }
  }
  return [...drafts.values()]
}
