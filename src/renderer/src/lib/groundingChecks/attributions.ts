// Split out of lib/toolGrounding.ts (v2.4): the "attributions" section. Behaviour-neutral —
// every declaration is the one that lived there, moved. lib/toolGrounding.ts re-exports
// all of them, so callers and tests are unchanged.

import {
  citedIndices,
  danglingCitations,
  retrievedCitations,
  turnLookups,
  type Citation,
  type Lookup
} from '../citations'
import { FENCED, INLINE_CODE, looksLikeTitle } from './quotations'



// ---- attributions ---------------------------------------------------------------

/**
 * `[5] (USDA Safe Food Handling)` — a marker with the document it names.
 *
 * Two shapes, both of which a model reaches for unprompted: a parenthetical
 * straight after the marker, and a marker opening a line or a table cell with
 * the document's title after it. Bounded and punctuation-free so an ordinary
 * aside — "[5] (see the note below), which says…" — is not read as a title.
 *
 * v1.15 adds a third, which is the one a model reaches for when it attributes
 * a figure mid-sentence: the marker INSIDE the parenthetical, the document
 * after it — `(source: [1] Cold Food Storage Chart)`. Measured (task V1,
 * run-1): the storage figure was attributed to that when [1] is *Safe minimum
 * internal temperatures* and the chart is [5]. Neither shape above sees it —
 * one wants the title in the brackets' wake, the other wants the marker to
 * open the line — so the check built for exactly this error said nothing.
 *
 * The lead-in word is optional; the closing paren is not. Bounding the title
 * by `)` is what stops it running on into prose and turning an ordinary
 * sentence into a document name, and `(sources: [1], [2], [4])` is not matched
 * at all — a marker followed by a comma names no document.
 */
const ATTRIBUTIONS = [
  /\[(\d{1,3})\][ \t]*\(([^)\n]{2,60})\)/g,
  /^[ \t|>*_-]*\[(\d{1,3})\][ \t]+([^|\n\t]{2,60}?)[ \t]*(?:\||\t|$)/gm,
  /\((?:(?:sources?|from|per|see|via|ref|citing|cited in)[ \t]*:?[ \t]*)?\[(\d{1,3})\][ \t]+([^)\n]{2,60})\)/gi,
  // v2.2, and it is the other half of the credit line `carriesAQuotation`
  // stopped mis-reading as a quotation. A signed blockquote —
  // `> "…chilled." [7] — FDA, Refrigerator thermometers — cold facts` — puts
  // the marker mid-line and the document after a dash, which is the one shape
  // none of the three above can see: the first two want the title in
  // parentheses, and pattern two wants the marker to OPEN the line. So the
  // turn that stopped crying wolf about the signature would also have said
  // nothing whatever had the signature been wrong, which is half a repair.
  //
  // The dash is the gate and it is doing real work. A marker followed by
  // ordinary prose (`the passage at [3] gives the figure`) names no document
  // and is not matched at all; `looksLikeTitle` then throws out the asides a
  // dash does introduce, because they carry sentence punctuation or fewer than
  // two capitals. Anchored to the line's end, because a credit line ends its
  // line — that is what makes it a signature rather than a clause.
  /\[(\d{1,3})\][ \t]*[–—-][ \t]*([^|\n\t]{2,60})[ \t]*$/gm
]

/** Words carrying no identity — a title match on "of" would mean nothing. */
const TITLE_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'and', 'in', 'on', 'at', 'to', 'from', 'with', 'by', 'passage'
])

function titleWords(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).filter((w) => !TITLE_STOPWORDS.has(w))
  )
}

/**
 * Attributions naming a document that is not the passage the marker points at.
 *
 * `danglingCitations` catches a marker naming no retrieved passage. This
 * catches the marker that resolves — and is then labelled with someone else's
 * document. Measured: a reply attributed `[5]` to "USDA Safe Food Handling"
 * when passage [5] was USDA's *Leftovers and food safety* and "Safe food
 * handling" was passage [4], an FDA page. The citation opens correctly, so by
 * eye it checks out; the name over it sends the reader to the wrong document.
 *
 * The test uses the retrieved labels as its whole vocabulary, which is what
 * keeps it quiet. A word the model added that belongs to no passage at all
 * ("USDA FSIS …" for a page the label calls USDA) is extra detail this cannot
 * judge and does not fault. A word that belongs to a *different* retrieved
 * passage and not this one is the swap itself. And an attribution with no
 * overlap at all names a document the turn never retrieved.
 */
export function misattributedCitations(answer: string, retrieved: Citation[]): string[] {
  if (retrieved.length === 0) return []
  const labels = new Map(retrieved.map((c) => [c.index, titleWords(c.label)]))
  const prose = answer.replace(FENCED, ' ').replace(INLINE_CODE, ' ')
  const flagged: string[] = []
  const seen = new Set<string>()
  for (const pattern of ATTRIBUTIONS) {
    for (const m of prose.matchAll(pattern)) {
      const index = Number(m[1])
      const name = m[2].trim()
      const own = labels.get(index)
      if (!own || !looksLikeTitle(name)) continue
      const words = titleWords(name)
      if (words.size === 0) continue
      const elsewhere = new Set<string>()
      for (const [i, set] of labels) if (i !== index) for (const w of set) elsewhere.add(w)
      const foreign = [...words].some((w) => !own.has(w) && elsewhere.has(w))
      const supported = [...words].some((w) => own.has(w))
      if (!foreign && supported) continue
      const finding = `[${index}] ${name}`
      if (seen.has(finding)) continue
      seen.add(finding)
      flagged.push(finding)
    }
  }
  return flagged
}
