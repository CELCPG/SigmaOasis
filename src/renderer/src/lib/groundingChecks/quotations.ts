// Split out of lib/toolGrounding.ts (v2.4): the "quotations" section. Behaviour-neutral —
// every declaration is the one that lived there, moved. lib/toolGrounding.ts re-exports
// all of them, so callers and tests are unchanged.



export // ---- quotations ----------------------------------------------------------------

/**
 * v1.14: text the reply presents as verbatim, checked against what came back.
 *
 * The library hands the model numbered passages and the turn block tells it to
 * quote figures and steps rather than paraphrase them. It does quote — and a
 * measured turn put `"checking leftovers daily,"` inside quotation marks when
 * the retrieved passage reads "check leftovers daily for spoilage". One word
 * away, in the register of the pack, presented exactly as the true quotation
 * two paragraphs above it was. The substring test that catches it is ten lines
 * long and runs on data the app already holds in the same message.
 *
 * Strict on purpose: character for character after folding whitespace, case
 * and the unicode quote/dash variants a renderer introduces. A span stitched
 * from two places in the source with a dash is not a quotation from either,
 * and tolerating the join would license exactly the fabrication this catches.
 * An explicit ellipsis is the one exception, because that is the writer
 * *marking* the omission rather than hiding it.
 */
/** Code is not prose: a string literal in a snippet is not a citation claim. */
const FENCED = /```[\s\S]*?(?:```|$)/g
export const INLINE_CODE = /`[^`\n]*`/g

const STRAIGHT_QUOTED = /"([^"\n]{25,400})"/g
const CURLY_QUOTED = /“([^”\n]{25,400})”/g
const BLOCKQUOTE_LINE = /^[ \t]{0,3}>[ \t]?(.{25,400})$/gm

const QUOTED_SPANS = [STRAIGHT_QUOTED, CURLY_QUOTED, BLOCKQUOTE_LINE]

/**
 * v2.2: the credit line under a blockquote is the quoter's, not the source's.
 *
 * Measured, blind, round 9, task TH3. The reply blockquoted a pack line and
 * signed it, which is the shape a model reaches for when it is asked to quote
 * *and* attribute in one breath:
 *
 *     > "Cold air must circulate around refrigerated foods to keep them
 *       properly chilled." [7] — FDA, Refrigerator thermometers — cold facts
 *
 * The quotation inside the marks is verbatim and the straight-quote pattern
 * passed it. The blockquote pattern then bounded the SAME claim by the line
 * instead — carrying the closing mark, the marker and the signature — matched
 * nothing, and the badge said the quotation appears "in no tool output this
 * turn". `misquotedSpans` marked the divergence honestly (`⟪" [7] — FDA,
 * Refrigerator thermometers — cold facts⟫`), so the marker was right and the
 * headline over it was wrong: a fabrication warning on a quotation that is
 * word for word in the source.
 *
 * v1.15 trimmed a marker off either edge for the same reason and stopped
 * there, which is round 5's recurring shape — an enumeration of the furniture
 * seen so far, defeated by the next piece. The general rule was already
 * written down twelve lines above, in the fold that will not delete a
 * quotation mark: **the marks are where the verbatim claim starts and stops.**
 * A blockquote carrying a quotation of citation length is that quotation, and
 * every one of those is already collected by the two patterns above; a
 * blockquote carrying no marks is still bounded by its line, which is what the
 * pattern is for.
 *
 * What it gives up is a miss, not a false alarm: an invented gloss written
 * *outside* the marks inside a blockquote is no longer read as quoted. It was
 * never presented as quoted, every other rung still reads it, and round 4
 * settled which of the two errors costs more.
 */
function carriesAQuotation(line: string): boolean {
  for (const pattern of [STRAIGHT_QUOTED, CURLY_QUOTED]) {
    // `.exec` on a global pattern would carry `lastIndex` to the next line.
    for (const m of line.matchAll(pattern)) {
      if (flattenQuote(m[1]).length >= MIN_QUOTED) return true
    }
  }
  return false
}

export /** Explicit elision — the quoter said a cut is here, so each side is checked apart. */
const ELISION = /\s*(?:\.\.\.|…|\[\.\.\.\]|\[…\])\s*/
const ELISION_G = new RegExp(ELISION.source, 'g')

/** The shortest quoted span that reads as a citation rather than scare quotes. */
const MIN_QUOTED = 25

/**
 * v1.17: emphasis is markup, not words — and it was on both sides of this check
 * and in the badge's own output.
 *
 * Measured (task V2): the reply bolded the figure inside a quotation it had
 * copied verbatim, and the badge printed
 * `⚠️ …the standard deduction rises to **$3…` — raw markdown in user-facing
 * text, and a fabrication warning on a passage the source states word for word.
 * `**$30,000**` and `$30,000` are the same quotation; the reader saw no
 * asterisks either way, so neither does the comparison, and neither does the
 * excerpt the badge shows.
 *
 * Paired delimiters only, a delimiter may not appear inside its own run, and
 * the run may not open or close on a space — CommonMark's flanking rule, and
 * the reason a footnoted source line (`within 2 hours* of cooking. *Or 1 hour
 * above 90 °F`) keeps both of its asterisks. That rule matters more here than
 * it does in a renderer: this fold runs over the corpus and over the reply
 * separately, so a delimiter that pairs up on one side and not the other would
 * manufacture exactly the false positive it is here to remove. A single `_` is
 * left alone for the same reason — `use_by_date` and `snake_case` are ordinary
 * tool output, and CommonMark does not read an intraword underscore as
 * emphasis either. A link needs its `(` against the `]`, so the attribution
 * shape `[5] (USDA Safe Food Handling)` is not one.
 */
const MARKDOWN_MARKUP: [RegExp, string][] = [
  [/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1'],
  [/\*\*([^*\s](?:[^*\n]*[^*\s])?)\*\*/g, '$1'],
  [/__([^_\s](?:[^_\n]*[^_\s])?)__/g, '$1'],
  [/~~([^~\s](?:[^~\n]*[^~\s])?)~~/g, '$1'],
  [/\*([^*\s](?:[^*\n]*[^*\s])?)\*/g, '$1']
]

function stripMarkdown(text: string): string {
  let out = text
  for (const [pattern, to] of MARKDOWN_MARKUP) out = out.replace(pattern, to)
  return out
}

/**
 * v1.17: the glyph a quotation mark is drawn with is the renderer's choice, not
 * the source's claim.
 *
 * Measured (task TH3): the pack reads `the simple rule is: “When in doubt,
 * throw it out.”`. The reply quoted the sentence around it, so its own outer
 * pair took the double marks and the nested one came out as
 * `‘When in doubt, throw it out.’`. Curly already folded to straight — single
 * to double did not — so two glyphs out of a hundred and four fired a
 * fabrication warning on a verbatim quotation.
 *
 * Every quotation glyph folds to one, and the dash family with it. The line is
 * drawn at the glyph's SHAPE: nothing here deletes a mark or moves one.
 * Swapping « for " cannot change which words are quoted. Dropping one can —
 * `"when in doubt", throw it out` and `"when in doubt, throw it out"` are
 * different claims about where the source's sentence ended, and they stay
 * different strings through this fold.
 */
const QUOTE_GLYPH = /['‘’‚‛ʼ`´"“”„‟′″‵‶«»‹›]/
const DASH_GLYPH = /[‐‑‒–—―−]/
const WHITESPACE = /\s/

/**
 * The comparison form, plus the index in the original that each character of it
 * came from — which is what lets the badge point at the divergence in the text
 * the reader actually saw.
 */
interface FlatText {
  flat: string
  /** `at[i]` is the offset in the original of `flat[i]`. Same length as `flat`. */
  at: number[]
}

function flattenParts(text: string): FlatText {
  const chars: string[] = []
  const at: number[] = []
  let pendingSpace = -1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (WHITESPACE.test(ch)) {
      if (chars.length > 0 && pendingSpace < 0) pendingSpace = i
      continue
    }
    const folded = QUOTE_GLYPH.test(ch) ? '"' : DASH_GLYPH.test(ch) ? '-' : ch.toLowerCase()
    if (pendingSpace >= 0) {
      chars.push(' ')
      at.push(pendingSpace)
      pendingSpace = -1
    }
    for (let k = 0; k < folded.length; k++) {
      chars.push(folded[k]!)
      at.push(i)
    }
  }
  return { flat: chars.join(''), at }
}

export /** Fold the differences a renderer or a keyboard introduces, and nothing else. */
function flattenQuote(text: string): string {
  return flattenParts(text).flat
}

/**
 * v1.15: the citation marker a quoter puts beside a quotation — `[1]`, `[2][3]`,
 * `[1, 2]`. It is the quoter's own attribution, never a word the source wrote.
 *
 * Measured (task V2): a passage quoted word for word inside a markdown
 * blockquote, `> "…tax year 2024." [1]`. The blockquote pattern bounds a span
 * by the line rather than by the quotation marks, so the span carried the marks
 * and the marker, matched nothing, and the badge cried wolf on a quotation the
 * straight-quote pattern had already matched and passed in the same reply.
 * Trimmed at either edge, like the quoter's other punctuation below; the body
 * still has to be in the corpus character for character.
 */
const MARKER = String.raw`(?:\s*\[\d{1,3}(?:\s*[,;]\s*\d{1,3})*\])+`
const MARKER_HEAD = new RegExp(`^${MARKER}`)
const MARKER_TAIL = new RegExp(`${MARKER}[\\s.]*$`)

/** Trailing prose punctuation the quoter added is not part of the source line. */
function trimQuoteEdges(span: string): string {
  return span
    .replace(MARKER_HEAD, '')
    .replace(MARKER_TAIL, '')
    .replace(/^[\s'"([-]+/, '')
    .replace(/[\s'"),.;:-]+$/, '')
}

/**
 * v2.2: the signature at the end of a blockquote, which is the quoter's too.
 *
 * `MARKER_TAIL` above trims `[7]`, and round 9 wrote `[7] — FDA, Refrigerator
 * thermometers — cold facts`, so the marker was no longer last and none of it
 * came off. That is v1.15's repair one piece of furniture behind the model —
 * the recurring shape this file keeps recording — and it is the case
 * `carriesAQuotation` cannot reach, because a blockquote with no quotation
 * marks has no marks to be bounded by.
 *
 * It runs at the span, before the fold, and only on a blockquote. Both halves
 * of that matter. Before the fold, because `looksLikeTitle` reads capitals and
 * `flattenQuote` lower-cases — the first version of this ran inside
 * `trimQuoteEdges`, which is called on folded text, and silently never fired.
 * Only on a blockquote, because inside quotation marks the marks are the
 * boundary and everything between them is offered as the source's.
 *
 * Three gates on the tail itself, each load-bearing. The dash opens the line or
 * is **spaced**, or `use-by date Kept Cold` reads as a signature. The tail
 * **ends the line**, because a signature does. And it passes `looksLikeTitle` —
 * the same test the attribution rung uses to tell a document from a sentence —
 * which is what keeps a recorded true positive alive: the stitched `Ground
 * meats, such as beef and pork — 160°F` has one word after its dash and no
 * capital, so nothing is trimmed and the invented join is still reported.
 *
 * What it can cost is a fabrication written *as* a title-shaped signature at
 * the very end of a line. That is a miss; the alternative — trimming on the
 * dash alone — deletes source text from the comparison and turns real
 * misquotations into passes, which is the error that cannot be allowed.
 */
const CREDIT_TAIL = /(?:^|[ \t])[–—-][ \t]+([^\n]{2,60})$/

function withoutCredit(line: string): string {
  const m = CREDIT_TAIL.exec(line)
  return m && looksLikeTitle(m[1]!) ? line.slice(0, m.index).trimEnd() : line
}

/** Every span the reply offers as a direct quotation, in the order it wrote them. */
function quotedSpans(answer: string): string[] {
  const prose = stripMarkdown(answer.replace(FENCED, ' ').replace(INLINE_CODE, ' '))
  const out: string[] = []
  for (const pattern of QUOTED_SPANS) {
    for (const m of prose.matchAll(pattern)) {
      let span = m[1].trim()
      if (pattern === BLOCKQUOTE_LINE) {
        // See `carriesAQuotation`: a blockquote that carries its own quotation
        // marks has already been read at the marks, by the patterns above.
        if (carriesAQuotation(span)) continue
        // …and one that does not is bounded by its line, so its signature has
        // to come off the end. See `withoutCredit`.
        span = withoutCredit(span)
      }
      if (flattenQuote(span).length < MIN_QUOTED) continue
      out.push(span)
    }
  }
  return out
}

/** One side of an explicit elision, and where in the flattened span it starts. */
interface QuotePart {
  text: string
  at: number
}

function quoteParts(flat: string): QuotePart[] {
  const parts: QuotePart[] = []
  let at = 0
  for (const m of flat.matchAll(ELISION_G)) {
    const text = flat.slice(at, m.index)
    if (text) parts.push({ text, at })
    at = m.index + m[0].length
  }
  const rest = flat.slice(at)
  if (rest) parts.push({ text: rest, at })
  return parts
}

function inSource(text: string, source: string): boolean {
  return source.includes(text) || source.includes(trimQuoteEdges(text))
}

/**
 * The longest run from one end of `text` that occurs anywhere in `source`.
 * Binary search is exact here: if a prefix of length k is absent, so is every
 * longer one.
 */
function longestAnchor(text: string, source: string, fromEnd: boolean): number {
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const run = fromEnd ? text.slice(text.length - mid) : text.slice(0, mid)
    if (source.includes(run)) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * An anchor shorter than this is a coincidence, not evidence: `s.`, `, and` and
 * `the ` occur in every English paragraph, and letting one bound the marker
 * would point the reader at the wrong words.
 */
const ANCHOR_MIN = 5

const LETTER = /\p{L}/u

/**
 * Where the quotation stops matching, as `[start, end)` in `text`: everything
 * before it is in the source, and so is everything after. An empty range means
 * the two anchors met — the words are all there, in a different arrangement —
 * and the badge then shows the span without singling anything out.
 */
function divergentRange(text: string, source: string): { start: number; end: number } {
  const head = longestAnchor(text, source, false)
  const tail = longestAnchor(text, source, true)
  const start = head >= ANCHOR_MIN ? head : 0
  let end = Math.max(start, tail >= ANCHOR_MIN ? text.length - tail : text.length)
  // The two ends are not read the same way, so they are not rounded the same
  // way. The head grows from the quotation's own first character, so where it
  // stops is a fact about the sentence — `check|ing leftovers daily` is exactly
  // how far the source and the reply agree, and saying so is the useful thing.
  // The tail is anchored to nothing the reader is reading in that direction: a
  // few letters agreeing at the end of a word is an artefact of the search, so
  // a break that stops inside a word takes the rest of that word with it.
  // Letters only — a digit is not a spelling, and `$3⟪2⟫,000` is the whole
  // point of marking the break at all.
  while (end > start && end < text.length && LETTER.test(text[end]!) && LETTER.test(text[end - 1]!)) {
    end++
  }
  return { start, end }
}

/**
 * v1.17. The badge used to print the first 72 characters of the span and an
 * ellipsis, which on the two runs that produced this fix cut the sentence off
 * *before* the words it was complaining about — a fabrication warning on text
 * with nothing visibly wrong in it. A reader who cannot see the difference
 * cannot check it, and a warning that cannot be checked is one they learn to
 * skip.
 *
 * So the excerpt is a window centred on the break rather than a prefix, and the
 * break itself is marked. `⟪⟫` is not a fabrication verdict on the words inside
 * it: it is where the app stopped being able to find the quotation in what the
 * tools returned.
 */
export const QUOTE_BREAK_MARKS = ['⟪', '⟫'] as const

/** Whether a reported quotation carries the marker, and so needs its legend. */
export function marksABreak(quote: string): boolean {
  return quote.includes(QUOTE_BREAK_MARKS[0])
}

/** Long enough to carry both sides of the break, short enough to stay a line. */
const EXCERPT = 88

/** Do not cut a word in half at the ellipsis: take the nearest space, if it is near. */
function snapStart(text: string, from: number, limit: number): number {
  for (let i = from; i < Math.min(limit, from + 12); i++) {
    if (WHITESPACE.test(text[i]!)) return i + 1
  }
  return from
}

function snapEnd(text: string, to: number, limit: number): number {
  for (let i = to; i > Math.max(limit, to - 12); i--) {
    if (WHITESPACE.test(text[i]!)) return i
  }
  return to
}

function markedExcerpt(display: string, start: number, end: number): string {
  const [open, close] = QUOTE_BREAK_MARKS
  const width = end - start
  // Nothing to single out: the break runs the length of the span (the whole
  // quotation is unsupported, and the sentence above already says so), or it is
  // wider than the window, in which case every word shown is inside it anyway.
  if (width <= 0 || width >= Math.min(EXCERPT, display.length)) {
    return display.length > EXCERPT
      ? `${display.slice(0, snapEnd(display, EXCERPT, 0)).trimEnd()}…`
      : display
  }
  const room = EXCERPT - width
  let to = Math.min(display.length, end + Math.floor(room / 2))
  // Whatever the right-hand side did not need is spent on the left, so a break
  // near the end of the span still gets its run-up.
  const from = Math.max(0, start - (room - (to - end)))
  to = Math.min(display.length, end + (room - (start - from)))
  const cutLeft = from > 0
  const cutRight = to < display.length
  const head = display.slice(cutLeft ? snapStart(display, from, start) : 0, start)
  const tail = display.slice(end, cutRight ? snapEnd(display, to, end) : display.length)
  return (
    (cutLeft ? `…${head.trimStart()}` : head) +
    open +
    display.slice(start, end) +
    close +
    (cutRight ? `${tail.trimEnd()}…` : tail)
  )
}

/**
 * Quoted spans in `answer` that no captured tool output contains.
 *
 * `corpus` is what the tools *returned*, plus the user's own words — never the
 * arguments the model chose. A model that passes its invention to a lookup as
 * the query would otherwise find it quoted back into the corpus and certified.
 */
export function misquotedSpans(answer: string, corpus: string): string[] {
  const source = flattenQuote(stripMarkdown(corpus))
  if (!source) return []
  const flagged: string[] = []
  const seen = new Set<string>()
  for (const span of quotedSpans(answer)) {
    const { flat, at } = flattenParts(span)
    // Keyed on the trimmed form: a blockquote and the quotation marks inside it
    // are two patterns bounding one claim, and one claim earns one finding. The
    // quote patterns run tightest-first, so the reported span is the tighter.
    const key = trimQuoteEdges(flat)
    // Nothing left once the quoter's own furniture comes off — a span that is
    // all marker and punctuation offers no words as the source's, so there is
    // no quotation to check. `inSource` reaches the same verdict by way of
    // `includes('')`; saying it here means it is not an accident.
    if (key === '') continue
    if (seen.has(key)) continue
    const missing = quoteParts(flat).find((part) => !inSource(part.text, source))
    if (!missing) continue
    seen.add(key)
    // The break is located in whichever form failed — the tighter one, since
    // that is the one that had its last chance to match.
    const tight = trimQuoteEdges(missing.text) || missing.text
    const shift = missing.at + Math.max(0, missing.text.indexOf(tight))
    const { start, end } = divergentRange(tight, source)
    flagged.push(
      markedExcerpt(
        span,
        at[shift + start] ?? span.length,
        shift + end < at.length ? at[shift + end]! : span.length
      )
    )
  }
  return flagged
}

export /**
 * A title, not a sentence: no sentence punctuation, short enough to be a name,
 * and carrying at least two capitalised words. The capitalisation is what
 * separates "(USDA Safe Food Handling)" from "(see the note below, which
 * qualifies it)" — an aside the check has no business ruling on, and which
 * shares no word with any label, so without this it read as a document nothing
 * retrieved.
 */
function looksLikeTitle(text: string): boolean {
  const words = text.trim().split(/\s+/)
  if (/[.!?;]/.test(text) || words.length > 10) return false
  return words.filter((w) => /^[A-Z]/.test(w)).length >= 2
}
