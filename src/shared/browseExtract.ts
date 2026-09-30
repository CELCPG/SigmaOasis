/**
 * What `browse(url, instruction)` hands back (v4.0, C4 — an experiment, off by default).
 *
 * The headless renderer (main/ipc/render.ts) loads a page that is an
 * application and extracts its text and links; this picks, from that, what
 * the instruction asks for — deterministically, with no model in the way:
 *
 *   - "links …"   the outbound links whose text or URL holds the instruction's words;
 *   - "price …"   the lines that carry a currency amount, with the words near them;
 *   - anything else: the passages scoring highest for the instruction's words,
 *     the way fetch_webpage's `query` picks passages.
 *
 * Pure, so node:test reaches it without a browser.
 */

export interface BrowsePage {
  title: string
  text: string
  links: { text: string; url: string }[]
}

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'with', 'from', 'find', 'get', 'list', 'show', 'me', 'all', 'every', 'each', 'page', 'this', 'that', 'is', 'are', 'what', 'which'])
const CURRENCY = /(?:[$€£¥]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|CAD|AUD|JPY|CHF|kr|zł|€|£|\$))/

export function instructionWords(instruction: string): string[] {
  return [...new Set(instruction.toLowerCase().match(/[a-z0-9][a-z0-9'-]{1,}/g) ?? [])].filter((w) => !STOP.has(w))
}

/** The page's text as passages: paragraphs, or windows of a few lines when there are no blank lines. */
export function passages(text: string, maxChars = 700): string[] {
  const blocks = text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
  const out: string[] = []
  for (const b of blocks) {
    if (b.length <= maxChars) {
      out.push(b)
      continue
    }
    const lines = b.split('\n')
    let cur = ''
    for (const line of lines) {
      if ((cur + '\n' + line).length > maxChars && cur) {
        out.push(cur.trim())
        cur = line
      } else cur = cur ? `${cur}\n${line}` : line
    }
    if (cur.trim()) out.push(cur.trim())
  }
  return out
}

/**
 * v4.0.2: how often a word starts a word of the passage. A plain substring
 * count read "rain" in "training" and "art" in "start"; a word start still
 * finds "rains" and "raining".
 */
function wordStarts(hay: string, w: string): number {
  let n = 0
  for (let i = hay.indexOf(w); i !== -1; i = hay.indexOf(w, i + w.length)) {
    if (i === 0 || !/[a-z0-9]/.test(hay[i - 1]!)) n++
  }
  return n
}

function score(passage: string, words: string[]): number {
  const hay = passage.toLowerCase()
  let s = 0
  for (const w of words) {
    const n = wordStarts(hay, w)
    if (n > 0) s += 1 + Math.min(3, n * 0.25)
  }
  return s
}

/** The extraction, sized for a model: at most `maxChars` of what the instruction asked for. */
export function extractByInstruction(page: BrowsePage, instruction: string, maxChars = 12_000): string {
  const words = instructionWords(instruction)
  const wants = instruction.toLowerCase()
  const head = `${page.title}`.trim()
  if (/\blinks?\b|\burls?\b/.test(wants)) {
    // "the download links": the words besides link/url pick; none of them means every link.
    const keys = words.filter((w) => !/^(?:links?|urls?)$/.test(w))
    const hits = keys.length === 0 ? [] : page.links.filter((l) => keys.some((w) => l.text.toLowerCase().includes(w) || l.url.toLowerCase().includes(w)))
    const lines = (hits.length > 0 ? hits : page.links).slice(0, 200).map((l) => `- ${l.text || '(no text)'} → ${l.url}`)
    return clip(`${head}\n\nLinks${hits.length > 0 ? ' matching the instruction' : ''} (${lines.length}):\n${lines.join('\n')}`, maxChars)
  }
  if (/\bprices?\b|\bcost|\bcheapest|\bexpensive|\bamounts?\b/.test(wants)) {
    const lines = page.text.split(/\r?\n/).map((l) => l.trim()).filter((l) => CURRENCY.test(l))
    if (lines.length > 0) return clip(`${head}\n\nLines with an amount (${lines.length}):\n${lines.map((l) => `- ${l}`).join('\n')}`, maxChars)
  }
  const all = passages(page.text)
  const ranked = words.length === 0 ? all : all.map((p, i) => ({ p, i, s: score(p, words) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.p)
  const chosen = (ranked.length > 0 ? ranked : all).slice(0, 12)
  const note = ranked.length === 0 && words.length > 0 ? `\n\n(Nothing on the page matched “${instruction.trim()}”; its first passages follow.)` : ''
  return clip(`${head}${note}\n\n${chosen.join('\n\n')}`, maxChars)
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${(s.length - max).toLocaleString('en-US')} more characters)` : s
}
