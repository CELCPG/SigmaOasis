/**
 * Documents: the files people actually have (v4.0, C1 — an experiment, off by default).
 *
 * `read_document` turns `.docx`, `.xlsx`, `.pptx`, `.csv`, `.md` and `.txt`
 * into text a model can read — headings, paragraphs, bullet lines, tables as
 * pipe tables, sheets by name — and `.pdf` through the host's extractor (the
 * app's own; the CLI has none and says so). `write_document` goes the other
 * way: Markdown to `.docx`, `.md` or `.txt`; rows to `.xlsx` or `.csv`.
 *
 * The Office formats are ZIP archives of XML read and written here directly
 * (./zip.ts) — no library, no sandbox, the same bytes on every machine. The
 * writers make the smallest files Word and Excel open: a `.docx` with three
 * heading styles and bullet paragraphs, an `.xlsx` with inline strings and
 * numbers. What a writer makes, the reader reads back to the same text, which
 * is what the chat shows as the diff of a document edit.
 *
 * Plain Node, no Electron.
 */
import { extname } from 'path'
import { readZip, writeZip } from './zip'

export const READABLE_DOCUMENTS = ['.docx', '.xlsx', '.pptx', '.pdf', '.csv', '.md', '.txt'] as const
export const WRITABLE_DOCUMENTS = ['.docx', '.xlsx', '.csv', '.md', '.txt'] as const

export type PdfReader = (bytes: Buffer) => Promise<string>

// ---- XML, just enough ---------------------------------------------------------

const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" }

export function decodeXml(s: string): string {
  return s.replace(/&(?:lt|gt|amp|quot|apos);|&#(\d+);|&#x([0-9a-fA-F]+);/g, (m, dec: string | undefined, hex: string | undefined) => {
    if (dec) return String.fromCodePoint(Number(dec))
    if (hex) return String.fromCodePoint(parseInt(hex, 16))
    return ENTITIES[m] ?? m
  })
}

export function encodeXml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

/** Every element `<tag …>…</tag>` (or self-closing) at any depth, in document order, as its inner XML. */
function elements(xml: string, tag: string): string[] {
  const out: string[] = []
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${tag}>)`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) out.push(m[1] ?? '')
  return out
}

function attr(openTag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(openTag)
  return m ? decodeXml(m[1]!) : null
}

// ---- Word ----------------------------------------------------------------------

/** A paragraph's text: its runs joined, tabs and breaks as spaces and newlines. */
function paragraphText(pXml: string): string {
  return decodeXml(
    pXml
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br\/>/g, '\n')
      .replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g, '$1')
      .replace(/<[^>]+>/g, '')
  )
}

function docxParagraph(pXml: string): string {
  const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(pXml)?.[1] ?? ''
  const text = paragraphText(pXml).trim()
  const level = /^Heading(\d)$/i.exec(style)?.[1] ?? (/^Title$/i.test(style) ? '1' : null)
  if (level && text) return `${'#'.repeat(Math.min(6, Number(level) || 1))} ${text}`
  if ((/ListBullet|ListParagraph/i.test(style) || /<w:numPr>/.test(pXml)) && text) return `- ${text.replace(/^[•\-*]\s*/, '')}`
  return text
}

/** `word/document.xml` as Markdown-ish text: headings, paragraphs, bullets, tables. */
export function docxToText(bytes: Buffer): string {
  const files = readZip(bytes)
  const xml = files.get('word/document.xml')?.toString('utf8')
  if (!xml) throw new Error('not a Word document (no word/document.xml)')
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml
  const out: string[] = []
  // Walk the body's top level: a paragraph or a table, in order.
  const re = /<w:tbl>([\s\S]*?)<\/w:tbl>|<w:p(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/w:p>)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    if (m[1] !== undefined) {
      const rows = elements(m[1], 'w:tr').map((tr) => elements(tr, 'w:tc').map((tc) => elements(tc, 'w:p').map(paragraphText).join(' ').trim().replace(/\|/g, '\\|')))
      if (rows.length === 0) continue
      const width = Math.max(...rows.map((r) => r.length))
      const pad = (r: string[]): string[] => [...r, ...Array<string>(width - r.length).fill('')]
      out.push(`| ${pad(rows[0]!).join(' | ')} |`, `| ${Array<string>(width).fill('---').join(' | ')} |`, ...rows.slice(1).map((r) => `| ${pad(r).join(' | ')} |`), '')
    } else {
      out.push(docxParagraph(m[2] ?? ''))
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

const CONTENT_TYPES = (parts: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${parts.join('')}</Types>`

const ROOT_RELS = (target: string, type: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/></Relationships>`

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

const DOCX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles ${W}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="360" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="200" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:style></w:styles>`

function run(text: string): string {
  return text
    .split('\n')
    .map((line) => `<w:r><w:t xml:space="preserve">${encodeXml(line)}</w:t></w:r>`)
    .join('<w:r><w:br/></w:r>')
}

function paragraph(text: string, style?: string): string {
  return `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${run(text)}</w:p>`
}

function isTableLine(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line)
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'))
}

function docxTable(lines: string[]): string {
  const rows = lines.filter((l) => !/^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(l)).map(tableCells)
  const width = Math.max(...rows.map((r) => r.length))
  const tr = (cells: string[]): string =>
    `<w:tr>${[...cells, ...Array<string>(width - cells.length).fill('')].map((c) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${paragraph(c)}</w:tc>`).join('')}</w:tr>`
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>${rows.map(tr).join('')}</w:tbl>`
}

/** Markdown (headings, paragraphs, `- ` bullets, pipe tables) to the smallest `.docx` Word opens. */
export function textToDocx(markdown: string): Buffer {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const body: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (isTableLine(line)) {
      const block: string[] = []
      while (i < lines.length && isTableLine(lines[i]!)) block.push(lines[i++]!)
      body.push(docxTable(block))
      continue
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) body.push(paragraph(heading[2]!.trim(), `Heading${heading[1]!.length}`))
    else if (/^\s*[-*•]\s+/.test(line)) body.push(paragraph(`• ${line.replace(/^\s*[-*•]\s+/, '')}`, 'ListBullet'))
    else if (line.trim() === '') {
      // A blank line separates paragraphs; runs of blanks collapse.
      if (body.length > 0 && !body[body.length - 1]!.startsWith('<w:p></w:p>')) body.push('<w:p></w:p>')
    } else {
      // Consecutive text lines are one paragraph.
      const para: string[] = [line]
      while (i + 1 < lines.length && lines[i + 1]!.trim() !== '' && !isTableLine(lines[i + 1]!) && !/^(#{1,3})\s|^\s*[-*•]\s+/.test(lines[i + 1]!)) para.push(lines[++i]!)
      body.push(paragraph(para.join('\n')))
    }
    i++
  }
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${body.join('')}<w:sectPr/></w:body></w:document>`
  return writeZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES(['<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>', '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>']) },
    { name: '_rels/.rels', data: ROOT_RELS('word/document.xml', 'officeDocument') },
    { name: 'word/document.xml', data: document },
    { name: 'word/_rels/document.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'word/styles.xml', data: DOCX_STYLES }
  ])
}

// ---- Excel ---------------------------------------------------------------------

export type Cell = string | number | boolean | null
export interface Sheet {
  name: string
  rows: Cell[][]
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

export function columnName(index: number): string {
  let n = index + 1
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** Every sheet, by workbook order, as rows of cells (blank cells null, ragged rows padded). */
export function xlsxToSheets(bytes: Buffer): Sheet[] {
  const files = readZip(bytes)
  const workbook = files.get('xl/workbook.xml')?.toString('utf8')
  if (!workbook) throw new Error('not an Excel workbook (no xl/workbook.xml)')
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? ''
  const targets = new Map<string, string>()
  for (const m of rels.matchAll(/<Relationship\s[^>]*>/g)) {
    const id = attr(m[0], 'Id')
    const target = attr(m[0], 'Target')
    if (id && target) targets.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''))
  }
  const shared: string[] = []
  const sst = files.get('xl/sharedStrings.xml')?.toString('utf8')
  if (sst) for (const si of elements(sst, 'si')) shared.push(decodeXml(elements(si, 't').join('')))
  const sheets: Sheet[] = []
  for (const m of workbook.matchAll(/<sheet\s[^>]*>/g)) {
    const name = attr(m[0], 'name') ?? `Sheet${sheets.length + 1}`
    const rid = attr(m[0], 'r:id') ?? ''
    const target = targets.get(rid) ?? `worksheets/sheet${sheets.length + 1}.xml`
    const xml = files.get(`xl/${target}`)?.toString('utf8') ?? files.get(target)?.toString('utf8')
    if (!xml) continue
    const rows: Cell[][] = []
    for (const rowXml of xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
      const row: Cell[] = []
      for (const c of rowXml[1]!.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const open = `<c ${c[1]}>`
        const ref = attr(open, 'r') ?? ''
        const type = attr(open, 't')
        const inner = c[2] ?? ''
        const col = ref ? columnIndex(ref) : row.length
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]
        let value: Cell = null
        if (type === 's') value = shared[Number(v)] ?? null
        else if (type === 'inlineStr') value = decodeXml(elements(inner, 't').join(''))
        else if (type === 'b') value = v === '1'
        else if (type === 'str' || type === 'e') value = v === undefined ? null : decodeXml(v)
        else if (v !== undefined) value = Number(v)
        while (row.length < col) row.push(null)
        row[col] = value
      }
      rows.push(row)
    }
    const width = Math.max(0, ...rows.map((r) => r.length))
    for (const r of rows) while (r.length < width) r.push(null)
    sheets.push({ name, rows })
  }
  return sheets
}

const cellText = (c: Cell): string => (c === null ? '' : typeof c === 'number' ? String(c) : String(c)).replace(/\|/g, '\\|').replace(/\n/g, ' ')

/** Sheets as text: a heading per sheet, then a pipe table. */
export function sheetsToText(sheets: Sheet[]): string {
  const out: string[] = []
  for (const s of sheets) {
    out.push(`## Sheet: ${s.name}`)
    if (s.rows.length === 0) {
      out.push('(empty)', '')
      continue
    }
    const width = Math.max(1, ...s.rows.map((r) => r.length))
    const line = (r: Cell[]): string => `| ${[...r, ...Array<Cell>(width - r.length).fill(null)].map(cellText).join(' | ')} |`
    out.push(line(s.rows[0]!), `| ${Array<string>(width).fill('---').join(' | ')} |`, ...s.rows.slice(1).map(line), '')
  }
  return out.join('\n').trim()
}

export function xlsxToText(bytes: Buffer): string {
  return sheetsToText(xlsxToSheets(bytes))
}

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const src = text.replace(/\r\n/g, '\n')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

export function toCsv(rows: readonly Cell[][]): string {
  const cell = (c: Cell): string => {
    const s = c === null ? '' : String(c)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return `${rows.map((r) => r.map(cell).join(',')).join('\n')}\n`
}

/** A CSV field as a cell: a number when it reads as one, else text. */
export function csvCell(s: string): Cell {
  if (s === '') return null
  return /^-?\d+(?:\.\d+)?$/.test(s.trim()) ? Number(s) : s
}

function sheetXml(rows: readonly Cell[][]): string {
  const cells = rows
    .map((r, ri) => {
      const cs = r
        .map((c, ci) => {
          if (c === null || c === undefined) return ''
          const ref = `${columnName(ci)}${ri + 1}`
          if (typeof c === 'number') return `<c r="${ref}"><v>${c}</v></c>`
          if (typeof c === 'boolean') return `<c r="${ref}" t="b"><v>${c ? 1 : 0}</v></c>`
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${encodeXml(String(c))}</t></is></c>`
        })
        .join('')
      return `<row r="${ri + 1}">${cs}</row>`
    })
    .join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cells}</sheetData></worksheet>`
}

/** Sheets to the smallest `.xlsx` Excel opens (inline strings, numbers, booleans). */
export function sheetsToXlsx(sheets: readonly Sheet[]): Buffer {
  const list = sheets.length > 0 ? sheets : [{ name: 'Sheet1', rows: [] }]
  const names = list.map((s, i) => s.name.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || `Sheet${i + 1}`)
  const entries = [
    {
      name: '[Content_Types].xml',
      data: CONTENT_TYPES([
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        ...list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      ])
    },
    { name: '_rels/.rels', data: ROOT_RELS('xl/workbook.xml', 'officeDocument') },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${encodeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`
    },
    ...list.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows) }))
  ]
  return writeZip(entries)
}

// ---- PowerPoint ----------------------------------------------------------------

export function pptxToText(bytes: Buffer): string {
  const files = readZip(bytes)
  const slides = [...files.keys()]
    .map((n) => ({ n, m: /^ppt\/slides\/slide(\d+)\.xml$/.exec(n) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(a.m![1]) - Number(b.m![1]))
  if (slides.length === 0) throw new Error('not a PowerPoint deck (no slides)')
  const out: string[] = []
  for (const s of slides) {
    const xml = files.get(s.n)!.toString('utf8')
    out.push(`## Slide ${s.m![1]}`)
    for (const p of elements(xml, 'a:p')) {
      const text = decodeXml(elements(p, 'a:t').join('')).trim()
      if (text) out.push(text)
    }
    out.push('')
  }
  return out.join('\n').trim()
}

// ---- the two doors -------------------------------------------------------------

export function documentKind(path: string): string {
  return extname(path).toLowerCase()
}

/** A document's text, by extension. Throws with a sentence for a kind it cannot read. */
export async function readDocument(path: string, bytes: Buffer, readPdf?: PdfReader): Promise<string> {
  switch (documentKind(path)) {
    case '.docx':
      return docxToText(bytes)
    case '.xlsx':
      return xlsxToText(bytes)
    case '.pptx':
      return pptxToText(bytes)
    case '.pdf':
      if (!readPdf) throw new Error('PDF reading needs the app (the CLI has no PDF extractor); open this folder in Sigma Oasis for it.')
      return readPdf(bytes)
    case '.csv':
    case '.md':
    case '.txt':
      return bytes.toString('utf8')
    default:
      throw new Error(`read_document reads ${READABLE_DOCUMENTS.join(', ')}; for other text files use read_file.`)
  }
}

export interface WriteDocumentInput {
  /** Markdown for .docx/.md/.txt; CSV text for .csv or .xlsx when `sheets` is absent. */
  content?: string
  /** Rows for .xlsx (several sheets) or .csv (the first sheet). */
  sheets?: Sheet[]
}

/** The bytes for a document of `path`'s kind. Throws with a sentence when the kind or the input is wrong. */
export function writeDocument(path: string, input: WriteDocumentInput): Buffer {
  const kind = documentKind(path)
  const sheetsFromInput = (): Sheet[] => {
    if (input.sheets && input.sheets.length > 0) {
      return input.sheets.map((s, i) => ({ name: String(s.name ?? `Sheet${i + 1}`), rows: (Array.isArray(s.rows) ? s.rows : []).map((r) => (Array.isArray(r) ? r.map((c) => (typeof c === 'number' || typeof c === 'boolean' || c === null ? c : String(c))) : [])) }))
    }
    if (typeof input.content === 'string') return [{ name: 'Sheet1', rows: parseCsv(input.content).map((r) => r.map(csvCell)) }]
    throw new Error('Give sheets ([{ name, rows }]) or content (CSV text).')
  }
  switch (kind) {
    case '.docx':
      if (typeof input.content !== 'string') throw new Error('Give content: the document as Markdown (headings with #, bullets with -, tables with |).')
      return textToDocx(input.content)
    case '.md':
    case '.txt':
      if (typeof input.content !== 'string') throw new Error('Give content: the text to write.')
      return Buffer.from(input.content, 'utf8')
    case '.xlsx':
      return sheetsToXlsx(sheetsFromInput())
    case '.csv':
      return Buffer.from(toCsv(sheetsFromInput()[0]!.rows), 'utf8')
    default:
      throw new Error(`write_document writes ${WRITABLE_DOCUMENTS.join(', ')}; for other text files use write_file.`)
  }
}
