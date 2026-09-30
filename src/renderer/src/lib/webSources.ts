import type { ToolCallRecord } from '../types'
import type { Citation } from './citations'

/**
 * v4.1 (G3): the turn's web sources, numbered once for the whole turn.
 *
 * Library passages have carried `[n]` markers since v1.13, and the checks read
 * them: a marker naming nothing retrieved, a marker labelled with another
 * document. Web answers carried none. The search handler numbered its results
 * `1.`–`8.` per call, a fetched page had no number at all, and a turn that
 * searched twice handed the model two different "1."s — so a reply built from
 * the web could not say which sentence came from where, and nothing could
 * check it if it tried.
 *
 * Numbered here, in the renderer, for the reason `renumberPassages` is: "the
 * turn" only exists here — the handlers are stateless and answer one call at a
 * time. One sequence for the turn, shared with the library's passages
 * (`passagesHandedOver` counts both), so `[3]` names one thing. A URL keeps
 * the number it was first given: the page the model fetches is the result it
 * was shown, not a new source.
 *
 * The instruction to cite rides the numbered output itself, so it reaches the
 * model exactly on the turns that used the web and on no other.
 */

/** The handler's own list item: `1. Title` over an indented URL (toolHandlers/web.ts). */
const RESULT_ITEM = /^(\d{1,2})\. ([^\n]*)\n {3}(https?:\/\/\S+)/gm
/** The same item once numbered for the turn. */
const NUMBERED_RESULT = /^\[(\d{1,3})\] ([^\n]*)\n {3}(https?:\/\/\S+)/gm
/** A fetched page's title line, numbered or not. */
const PAGE_LINE = /^(?:\[(\d{1,3})\] )?Page: ([^\n]*)$/m
/** A fetched page's URL line. */
const PAGE_URL = /^URL: (\S+)$/m

/** Said once under a numbered result list — the rule, and why a snippet is not enough. */
export const CITE_RESULTS_NOTE =
  'Cite a result by its bracketed number: put [n] after each sentence that uses it. A snippet is ' +
  'a lead, not a source — before stating a live figure (weather, a price, a score, a time) from ' +
  'one, read its page with fetch_webpage, or say plainly that it comes from a search snippet.'

/** Said once under a numbered page. */
export function citePageNote(n: number): string {
  return `This page is source [${n}]: put [${n}] after each sentence that uses it.`
}

/** One spelling per page: scheme, `www.`, a trailing slash and the fragment do not make a new source. */
export function sourceKey(url: string): string {
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    const path = u.pathname.replace(/\/+$/, '')
    return `${host}${path}${u.search}`
  } catch {
    return url.trim().toLowerCase()
  }
}

/** Every web source this turn has numbered, by page, with its number. */
function numberedUrls(records: ToolCallRecord[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of records) {
    if (r.status !== 'done' || !r.result) continue
    if (r.name === 'web_search') {
      for (const m of r.result.matchAll(NUMBERED_RESULT)) {
        const key = sourceKey(m[3])
        if (!out.has(key)) out.set(key, Number(m[1]))
      }
    } else if (r.name === 'fetch_webpage') {
      const n = PAGE_LINE.exec(r.result)?.[1]
      if (!n) continue
      for (const url of [String(r.args?.url ?? ''), PAGE_URL.exec(r.result)?.[1] ?? '']) {
        if (url && !out.has(sourceKey(url))) out.set(sourceKey(url), Number(n))
      }
    }
  }
  return out
}

/** The highest number this turn's web sources have taken. `passagesHandedOver` folds it in. */
export function highestWebSource(records: ToolCallRecord[]): number {
  let high = 0
  for (const n of numberedUrls(records).values()) if (n > high) high = n
  return high
}

/**
 * Number one web tool's output for the turn, continuing from `handedOver` —
 * the highest number anything this turn has already handed the model. Output
 * of any other tool, and output with nothing to number, comes back unchanged.
 */
export function numberWebSources(
  name: string,
  args: Record<string, unknown>,
  output: string,
  records: ToolCallRecord[],
  handedOver: number
): string {
  if (name !== 'web_search' && name !== 'fetch_webpage') return output
  const known = numberedUrls(records)
  let next = handedOver
  const numberFor = (...urls: string[]): number => {
    for (const url of urls) {
      const n = url ? known.get(sourceKey(url)) : undefined
      if (n !== undefined) return n
    }
    next += 1
    for (const url of urls) if (url) known.set(sourceKey(url), next)
    return next
  }

  if (name === 'web_search') {
    let numbered = false
    const out = output.replace(RESULT_ITEM, (_m, _i: string, title: string, url: string) => {
      numbered = true
      return `[${numberFor(url)}] ${title}\n   ${url}`
    })
    return numbered ? `${out}\n\n${CITE_RESULTS_NOTE}` : output
  }

  if (!PAGE_LINE.test(output) || PAGE_LINE.exec(output)?.[1]) return output
  const n = numberFor(String(args.url ?? ''), PAGE_URL.exec(output)?.[1] ?? '')
  return `${output.replace(PAGE_LINE, (_m, _n: string, title: string) => `[${n}] Page: ${title}`)}\n\n${citePageNote(n)}`
}

/** A result's snippet: its block, from the URL line to the blank line after it. */
function blockAfter(text: string, from: number): string {
  const end = text.indexOf('\n\n', from)
  return text.slice(from, end < 0 ? text.length : end).trim()
}

/** Beyond this, a fetched page's text is not what a citation check needs. */
const MAX_PAGE_TEXT = 6000

/**
 * The web sources this turn numbered, as citations — the same shape the
 * library's passages parse into, so the marker binder and the checks read
 * both through one list. A number is claimed once, first come.
 */
export function webCitations(records: ToolCallRecord[]): Citation[] {
  const byIndex = new Map<number, Citation>()
  const done = records.filter((r) => r.status === 'done' && r.result)
  // Pages first: a result the model went on to read keeps its number, and the
  // page's text — not the snippet's — is what that number now stands for.
  for (const r of done) {
    if (r.name !== 'fetch_webpage') continue
    const page = PAGE_LINE.exec(r.result!)
    const url = PAGE_URL.exec(r.result!)
    if (!page?.[1] || !url) continue
    const index = Number(page[1])
    if (byIndex.has(index)) continue
    const text = r.result!.slice(url.index + url[0].length).trim().slice(0, MAX_PAGE_TEXT)
    byIndex.set(index, { index, label: page[2].trim() || url[1], source: url[1], href: url[1], ...(text ? { text } : {}) })
  }
  for (const r of done) {
    if (r.name !== 'web_search') continue
    for (const m of r.result!.matchAll(NUMBERED_RESULT)) {
      const index = Number(m[1])
      if (byIndex.has(index)) continue
      const text = blockAfter(r.result!, (m.index ?? 0) + m[0].length)
      byIndex.set(index, { index, label: m[2].trim(), source: m[3], href: m[3], ...(text ? { text } : {}) })
    }
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index)
}
