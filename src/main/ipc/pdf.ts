import { inflateSync, inflateRawSync, unzipSync } from 'zlib'

/**
 * Minimal PDF text extraction.
 *
 * Papers, standards, filings and datasheets are among the highest-value sources
 * for research, and v0.6 refused all of them on content type. No PDF library is
 * available to install here, so this extracts text directly using Node's
 * built-in zlib.
 *
 * What it handles: FlateDecode (and undecoded) content streams, literal `(...)`
 * and hex `<...>` strings, the text-showing operators (Tj, TJ, ' and "), text
 * positioning as line/paragraph breaks, and per-font ToUnicode CMaps —
 * `bfchar`/`bfrange` — which is what modern PDF producers use and what makes
 * the difference between readable text and mojibake.
 *
 * What it does not handle: encrypted PDFs, scanned images with no text layer,
 * and exotic filters (LZW, JBIG2, CCITT). Rather than emit plausible-looking
 * garbage in those cases — the worst outcome, because a model cannot tell
 * garbage from content — extraction ends with `isLikelyText` and returns a
 * clear failure instead. Extraction being heuristic is exactly why that gate
 * exists.
 */

export interface PdfOutcome {
  ok: true
  text: string
  title: string
  pages: number
}

export interface PdfFailure {
  ok: false
  error: string
}

/** Objects scanned before giving up, so a hostile file cannot spin the CPU. */
const MAX_OBJECTS = 5000
/** Decompressed bytes accepted in total. */
const MAX_DECOMPRESSED_BYTES = 40 * 1024 * 1024
/** Characters of extracted text kept. */
const MAX_TEXT_CHARS = 2_000_000

// ---- byte helpers ------------------------------------------------------------

/**
 * PDF structure is ASCII-ish; binary stream payloads are sliced by index rather
 * than read as text, so latin1 (a byte-preserving 1:1 mapping) is the right
 * lens for scanning. Never utf-8: that would corrupt offsets.
 */
function toLatin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1')
}

/** Try every inflate variant a PDF might have used before giving up. */
function tryInflate(bytes: Buffer): Buffer | null {
  for (const fn of [inflateSync, inflateRawSync, unzipSync]) {
    try {
      return fn(bytes)
    } catch {
      // Next variant.
    }
  }
  // Some producers leave leading garbage before the zlib header.
  for (let skip = 1; skip <= 2; skip++) {
    try {
      return inflateSync(bytes.subarray(skip))
    } catch {
      // Give up below.
    }
  }
  return null
}

// ---- object + stream scanning -----------------------------------------------

interface PdfObject {
  id: string
  /** The object's dictionary text (between `obj` and `stream`/`endobj`). */
  dict: string
  /** Decoded stream payload, when the object had one we could decode. */
  stream?: Buffer
}

/**
 * Collect indirect objects and decode their streams.
 *
 * The cross-reference table is deliberately not used: it is the part of a PDF
 * most often stale, rebuilt, or split across incremental updates, and a linear
 * scan finds every object regardless. We are extracting text, not rendering.
 */
function scanObjects(raw: Uint8Array): PdfObject[] {
  const latin1 = toLatin1(raw)
  const objects: PdfObject[] = []
  const objRe = /(\d+)\s+(\d+)\s+obj\b/g
  let decompressed = 0
  let match: RegExpExecArray | null

  while ((match = objRe.exec(latin1)) !== null && objects.length < MAX_OBJECTS) {
    const bodyStart = match.index + match[0].length
    const endObj = latin1.indexOf('endobj', bodyStart)
    const streamIdx = latin1.indexOf('stream', bodyStart)
    const limit = endObj === -1 ? latin1.length : endObj

    const hasStream = streamIdx !== -1 && streamIdx < limit
    const dict = latin1.slice(bodyStart, hasStream ? streamIdx : limit)
    const object: PdfObject = { id: `${match[1]}_${match[2]}`, dict }

    if (hasStream) {
      // `stream` is followed by CRLF or LF, then payload bytes.
      let payloadStart = streamIdx + 'stream'.length
      if (latin1[payloadStart] === '\r') payloadStart++
      if (latin1[payloadStart] === '\n') payloadStart++

      const endStream = latin1.indexOf('endstream', payloadStart)
      if (endStream !== -1) {
        const declared = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict)
        // Prefer the declared length, but never trust it past `endstream`.
        const byLength = declared ? payloadStart + Number(declared[1]) : endStream
        const payloadEnd = Math.min(endStream, byLength > payloadStart ? byLength : endStream)
        const payload = Buffer.from(raw.subarray(payloadStart, payloadEnd))

        if (/\/FlateDecode/.test(dict)) {
          const inflated = tryInflate(payload)
          if (inflated && decompressed + inflated.byteLength <= MAX_DECOMPRESSED_BYTES) {
            decompressed += inflated.byteLength
            object.stream = inflated
          }
        } else if (!/\/(?:DCT|JPX|JBIG2|CCITT|LZW|RunLength)Decode/.test(dict)) {
          // Uncompressed content stream.
          object.stream = payload
        }
        objRe.lastIndex = Math.max(objRe.lastIndex, endStream)
      }
    }
    objects.push(object)
  }
  return objects
}

// ---- ToUnicode CMaps --------------------------------------------------------

type CMap = Map<number, string>

/** Parse a hex string like `<0041>` or `<00410042>` into code units. */
function hexToCodes(hex: string, bytesPerCode: number): number[] {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '')
  const width = bytesPerCode * 2
  const codes: number[] = []
  for (let i = 0; i + width <= clean.length; i += width) {
    codes.push(parseInt(clean.slice(i, i + width), 16))
  }
  return codes
}

/** A CMap destination is UTF-16BE; may be several units for a ligature. */
function hexToString(hex: string): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '')
  let out = ''
  for (let i = 0; i + 4 <= clean.length; i += 4) {
    const unit = parseInt(clean.slice(i, i + 4), 16)
    if (unit === 0) continue
    out += String.fromCharCode(unit)
  }
  // Odd trailing byte pair: treat as single-byte code.
  if (clean.length % 4 === 2) out += String.fromCharCode(parseInt(clean.slice(-2), 16))
  return out
}

/**
 * Build a code → text map from a ToUnicode CMap stream. This is what turns the
 * glyph indices modern PDFs emit back into characters.
 */
export function parseToUnicodeCMap(cmap: string): CMap {
  const map: CMap = new Map()

  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const codes = hexToCodes(pair[1], pair[1].length <= 2 ? 1 : 2)
      const value = hexToString(pair[2])
      if (codes.length > 0 && value) map.set(codes[0], value)
    }
  }

  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1]
    // Form 1: <lo> <hi> <dstStart>
    for (const r of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const lo = parseInt(r[1], 16)
      const hi = parseInt(r[2], 16)
      const dst = hexToString(r[3])
      if (!dst || hi < lo || hi - lo > 65535) continue
      const base = dst.charCodeAt(dst.length - 1)
      const prefix = dst.slice(0, -1)
      for (let c = lo; c <= hi; c++) {
        map.set(c, prefix + String.fromCharCode(base + (c - lo)))
      }
    }
    // Form 2: <lo> <hi> [ <d1> <d2> … ]
    for (const r of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g)) {
      const lo = parseInt(r[1], 16)
      const items = [...r[3].matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => hexToString(m[1]))
      items.forEach((value, i) => {
        if (value) map.set(lo + i, value)
      })
    }
  }
  return map
}

/**
 * Map each font resource name (`/F1`) to its ToUnicode CMap.
 *
 * Font dictionaries reference the CMap indirectly (`/ToUnicode 12 0 R`), so this
 * resolves through the object table.
 */
function buildFontMaps(objects: PdfObject[]): Map<string, CMap> {
  const byId = new Map(objects.map((o) => [o.id, o]))
  const fontMaps = new Map<string, CMap>()

  // Font objects, keyed by object id.
  const cmapByFontObject = new Map<string, CMap>()
  for (const object of objects) {
    if (!/\/Type\s*\/Font/.test(object.dict)) continue
    const ref = /\/ToUnicode\s+(\d+)\s+(\d+)\s+R/.exec(object.dict)
    if (!ref) continue
    const cmapObject = byId.get(`${ref[1]}_${ref[2]}`)
    if (!cmapObject?.stream) continue
    const parsed = parseToUnicodeCMap(cmapObject.stream.toString('latin1'))
    if (parsed.size > 0) cmapByFontObject.set(object.id, parsed)
  }

  // Resource dictionaries map the in-stream name (/F1) to a font object.
  for (const object of objects) {
    const fontDict = /\/Font\s*<<([\s\S]*?)>>/.exec(object.dict)
    if (!fontDict) continue
    for (const entry of fontDict[1].matchAll(/\/([^\s/<>]+)\s+(\d+)\s+(\d+)\s+R/g)) {
      const cmap = cmapByFontObject.get(`${entry[2]}_${entry[3]}`)
      if (cmap) fontMaps.set(entry[1], cmap)
    }
  }

  // Fall back to a single merged map when resources could not be tied to names:
  // better to decode with the only CMap present than not at all.
  if (fontMaps.size === 0 && cmapByFontObject.size > 0) {
    const merged: CMap = new Map()
    for (const cmap of cmapByFontObject.values()) {
      for (const [code, value] of cmap) if (!merged.has(code)) merged.set(code, value)
    }
    fontMaps.set('*', merged)
  }
  return fontMaps
}

// ---- content stream text extraction -----------------------------------------

/** Decode a PDF literal string, resolving escapes and octal codes. */
export function decodeLiteralString(source: string): string {
  let out = ''
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = source[++i]
    switch (next) {
      case 'n': out += '\n'; break
      case 'r': out += '\r'; break
      case 't': out += '\t'; break
      case 'b': out += '\b'; break
      case 'f': out += '\f'; break
      case '(': out += '('; break
      case ')': out += ')'; break
      case '\\': out += '\\'; break
      case '\n': break // line continuation
      case '\r': if (source[i + 1] === '\n') i++; break
      default:
        if (next >= '0' && next <= '7') {
          let octal = next
          while (octal.length < 3 && source[i + 1] >= '0' && source[i + 1] <= '7') {
            octal += source[++i]
          }
          out += String.fromCharCode(parseInt(octal, 8))
        } else if (next !== undefined) {
          out += next
        }
    }
  }
  return out
}

/** Split a content stream into tokens, keeping strings and arrays intact. */
function extractStringsFromContentStream(content: string, fontMaps: Map<string, CMap>): string {
  let out = ''
  let activeCMap: CMap | undefined = fontMaps.get('*')
  let i = 0
  /** Last y translation seen from a Tm, so vertical moves can be detected. */
  let lastY: number | null = null

  const applyCMap = (codes: number[]): string => {
    if (!activeCMap) return ''
    return codes.map((c) => activeCMap!.get(c) ?? '').join('')
  }

  while (i < content.length) {
    const ch = content[i]

    // Font selection: /F1 12 Tf
    if (ch === '/') {
      const name = /^\/([^\s/<>[\]()]+)/.exec(content.slice(i))
      if (name) {
        const after = content.slice(i + name[0].length, i + name[0].length + 24)
        if (/^\s+[\d.]+\s+Tf\b/.test(after)) {
          activeCMap = fontMaps.get(name[1]) ?? fontMaps.get('*')
        }
        i += name[0].length
        continue
      }
    }

    // Literal string: (...) with balanced, escapable parentheses.
    if (ch === '(') {
      let depth = 1
      let j = i + 1
      let raw = ''
      while (j < content.length && depth > 0) {
        const c = content[j]
        if (c === '\\') {
          raw += c + (content[j + 1] ?? '')
          j += 2
          continue
        }
        if (c === '(') depth++
        else if (c === ')') {
          depth--
          if (depth === 0) break
        }
        raw += c
        j++
      }
      const decoded = decodeLiteralString(raw)
      // A literal string under a CID font holds glyph codes, not characters.
      out += activeCMap
        ? applyCMap([...decoded].map((c) => c.charCodeAt(0))) || decoded
        : decoded
      i = j + 1
      continue
    }

    // Hex string: <...>
    if (ch === '<' && content[i + 1] !== '<') {
      const close = content.indexOf('>', i)
      if (close === -1) break
      const hex = content.slice(i + 1, close)
      if (activeCMap) {
        // Two-byte codes are the norm for CID fonts; fall back to one.
        const twoByte = applyCMap(hexToCodes(hex, 2))
        out += twoByte || applyCMap(hexToCodes(hex, 1))
      } else {
        out += hexToString(hex)
      }
      i = close + 1
      continue
    }

    // Positioning operators. A line break is emitted only on an actual vertical
    // move: producers reposition horizontally mid-word constantly (kerning,
    // ligature splits, glyph runs), and treating every Td as a newline chops
    // words in half — "backoff" arrives as "backof" + "f".
    if (ch === 'T' || ch === "'" || ch === '"' || ch === 'E') {
      const op = /^(T[djJmscwzLfr*]|ET|'|")/.exec(content.slice(i))
      if (op) {
        const operator = op[1]
        const before = content.slice(Math.max(0, i - 96), i)

        if (operator === 'Td' || operator === 'TD') {
          // Relative move; ty is the second operand.
          const m = /(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s*$/.exec(before)
          const ty = m ? Math.abs(parseFloat(m[2])) : 1
          if (ty > 0.01) out += '\n'
        } else if (operator === 'Tm') {
          // Absolute text matrix; f (6th operand) is the y translation.
          const m =
            /(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s*$/.exec(
              before
            )
          if (m) {
            const y = parseFloat(m[6])
            if (lastY !== null && Math.abs(y - lastY) > 0.01) out += '\n'
            lastY = y
          }
        } else if (operator === 'T*' || operator === "'" || operator === '"') {
          // Explicit next-line operators.
          out += '\n'
        }
        i += operator.length
        continue
      }
    }

    i++
  }
  return out
}

// ---- quality gate -----------------------------------------------------------

/**
 * Does this look like natural-language text rather than decode noise?
 *
 * A wrong font encoding produces output that is confidently structured and
 * completely wrong. Feeding that to a model is worse than refusing, because
 * nothing downstream can tell it apart from real content — so extraction is
 * gated on the shape of the result, not just on whether parsing threw.
 */
export function isLikelyText(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 32) return false

  let letters = 0
  let spaces = 0
  let controls = 0
  for (const ch of trimmed) {
    const code = ch.codePointAt(0)!
    if (/\p{L}/u.test(ch)) letters++
    else if (ch === ' ' || ch === '\n' || ch === '\t') spaces++
    else if (code < 32 || code === 0xfffd) controls++
  }

  const total = trimmed.length
  if (controls / total > 0.02) return false
  // Decode noise is dominated by symbols and control bytes rather than letters.
  if (letters / total < 0.5) return false
  // Real prose is word-separated; a wrong single-byte encoding often yields one
  // unbroken run. (No upper bound is needed: the letter floor above already caps
  // the space share at 0.5.)
  if (spaces / total < 0.05) return false
  return true
}

/** Collapse the whitespace that content-stream operators leave behind. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, MAX_TEXT_CHARS)
}

/** Document title from the Info dictionary, when present and sane. */
function findTitle(objects: PdfObject[]): string {
  for (const object of objects) {
    const match = /\/Title\s*(?:\(([\s\S]*?)\)|<([0-9a-fA-F\s]+)>)/.exec(object.dict)
    if (!match) continue
    const value = match[1] !== undefined ? decodeLiteralString(match[1]) : hexToString(match[2])
    const clean = value.replace(/[ -]/g, '').trim()
    if (clean) return clean.slice(0, 300)
  }
  return ''
}

// ---- entry point ------------------------------------------------------------

export function extractPdfText(bytes: Uint8Array): PdfOutcome | PdfFailure {
  if (bytes.byteLength === 0) return { ok: false, error: 'The PDF was empty.' }

  const head = toLatin1(bytes.subarray(0, 1024))
  if (!head.includes('%PDF-')) {
    return { ok: false, error: 'Refused: the response was not a PDF (no %PDF- header).' }
  }

  let objects: PdfObject[]
  try {
    objects = scanObjects(bytes)
  } catch (err) {
    return {
      ok: false,
      error: `Could not parse the PDF structure (${err instanceof Error ? err.message : String(err)}).`
    }
  }

  if (toLatin1(bytes).includes('/Encrypt')) {
    return {
      ok: false,
      error:
        'This PDF is encrypted, so its text cannot be extracted. Open it in a PDF reader instead.'
    }
  }

  const fontMaps = buildFontMaps(objects)
  const pageCount = (toLatin1(bytes).match(/\/Type\s*\/Page\b/g) ?? []).length

  let collected = ''
  for (const object of objects) {
    if (!object.stream) continue
    // Skip streams that are plainly not page content.
    if (/\/Type\s*\/(?:XObject|Font|Metadata|XRef|ObjStm)\b/.test(object.dict)) {
      if (!/\/Subtype\s*\/Form\b/.test(object.dict)) continue
    }
    const content = object.stream.toString('latin1')
    if (!/\b(?:Tj|TJ|Td|TD|Tf)\b/.test(content)) continue
    collected += extractStringsFromContentStream(content, fontMaps) + '\n'
    if (collected.length > MAX_TEXT_CHARS) break
  }

  const text = tidy(collected)

  if (!text) {
    return {
      ok: false,
      error:
        'No text layer found in this PDF — it is most likely a scan of a printed document. ' +
        'Extracting text would need OCR, which Sigma Oasis does not do.'
    }
  }
  if (!isLikelyText(text)) {
    return {
      ok: false,
      error:
        'This PDF uses a font encoding that could not be decoded into readable text, so ' +
        'extraction was refused rather than returning garbled content. Try an HTML version ' +
        'of the document if one exists.'
    }
  }

  return { ok: true, text, title: findTitle(objects), pages: pageCount }
}
