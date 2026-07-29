import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join } from 'path'
import { deflateSync } from 'zlib'
import { load } from './harness'

const { extractPdfText, parseToUnicodeCMap, decodeLiteralString, isLikelyText } =
  load<typeof import('../src/main/ipc/pdf')>('pdf')

/** Build a minimal, valid, uncompressed PDF around a content stream. */
function makePdf(contentStream: string, extra = ''): Uint8Array {
  const body = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj
4 0 obj << /Length ${contentStream.length} >>
stream
${contentStream}
endstream
endobj
${extra}
trailer << /Root 1 0 R >>
%%EOF`
  return new Uint8Array(Buffer.from(body, 'latin1'))
}

const PROSE =
  'The retry timeout defaults to thirty seconds before the request is abandoned entirely.'

describe('decodeLiteralString', () => {
  test('resolves standard escapes', () => {
    assert.equal(decodeLiteralString('a\\nb\\tc'), 'a\nb\tc')
  })
  test('resolves escaped parentheses and backslashes', () => {
    assert.equal(decodeLiteralString('a\\(b\\)c\\\\d'), 'a(b)c\\d')
  })
  test('resolves octal character codes', () => {
    assert.equal(decodeLiteralString('\\101\\102\\103'), 'ABC')
  })
  test('honors line continuations', () => {
    assert.equal(decodeLiteralString('ab\\\ncd'), 'abcd')
  })
  test('passes unknown escapes through as the literal character', () => {
    assert.equal(decodeLiteralString('\\q'), 'q')
  })
})

describe('parseToUnicodeCMap', () => {
  test('parses bfchar mappings', () => {
    const map = parseToUnicodeCMap(`
      /CIDInit /ProcSet findresource begin
      2 beginbfchar
      <0003> <0041>
      <0004> <0042>
      endbfchar
    `)
    assert.equal(map.get(3), 'A')
    assert.equal(map.get(4), 'B')
  })

  test('parses bfrange with a destination start', () => {
    const map = parseToUnicodeCMap('1 beginbfrange\n<0010> <0012> <0041>\nendbfrange')
    assert.equal(map.get(0x10), 'A')
    assert.equal(map.get(0x11), 'B')
    assert.equal(map.get(0x12), 'C')
  })

  test('parses bfrange with an explicit array', () => {
    const map = parseToUnicodeCMap('1 beginbfrange\n<0020> <0022> [<0058> <0059> <005A>]\nendbfrange')
    assert.equal(map.get(0x20), 'X')
    assert.equal(map.get(0x21), 'Y')
    assert.equal(map.get(0x22), 'Z')
  })

  test('handles multi-unit destinations (ligatures)', () => {
    const map = parseToUnicodeCMap('1 beginbfchar\n<0005> <00660069>\nendbfchar')
    assert.equal(map.get(5), 'fi')
  })

  test('ignores an absurd range rather than allocating forever', () => {
    const map = parseToUnicodeCMap('1 beginbfrange\n<0000> <FFFFFF> <0041>\nendbfrange')
    assert.ok(map.size < 70000)
  })

  test('an empty CMap yields an empty map', () => {
    assert.equal(parseToUnicodeCMap('').size, 0)
  })
})

describe('isLikelyText', () => {
  test('accepts natural prose', () => {
    assert.equal(isLikelyText(PROSE), true)
  })
  test('rejects text that is too short to judge', () => {
    assert.equal(isLikelyText('hi'), false)
  })
  test('rejects binary noise', () => {
    assert.equal(isLikelyText(''.repeat(40)), false)
  })
  test('rejects mostly-symbol output from a bad encoding', () => {
    assert.equal(isLikelyText('@#$%^&*(){}[]<>/\\|~`'.repeat(10)), false)
  })
  test('rejects text with no spaces at all', () => {
    assert.equal(isLikelyText('a'.repeat(200)), false)
  })
  test('rejects text where letters are too sparse to be prose', () => {
    assert.equal(isLikelyText('a' + '   '.repeat(200)), false)
  })
  test('accepts prose at the space-ratio boundary', () => {
    // Short alternating words are legitimate text and must not be rejected.
    assert.equal(isLikelyText('a b '.repeat(50)), true)
  })
  test('rejects replacement characters', () => {
    assert.equal(isLikelyText('�'.repeat(50) + ' some words here now'), false)
  })
})

describe('extractPdfText — uncompressed content streams', () => {
  test('extracts a literal string', () => {
    const out = extractPdfText(makePdf(`BT /F1 12 Tf 72 720 Td (${PROSE}) Tj ET`))
    assert.ok(out.ok)
    assert.ok(out.ok && out.text.includes('retry timeout defaults'))
  })

  test('extracts a TJ array, concatenating the parts', () => {
    const out = extractPdfText(
      makePdf('BT /F1 12 Tf 72 720 Td [(The retry timeout ) -20 (defaults to thirty seconds now.)] TJ ET')
    )
    assert.ok(out.ok)
    assert.ok(out.ok && out.text.includes('The retry timeout defaults to thirty seconds now.'))
  })

  test('counts pages', () => {
    const out = extractPdfText(makePdf(`BT /F1 12 Tf 72 720 Td (${PROSE}) Tj ET`))
    assert.ok(out.ok && out.pages === 1)
  })

  test('reads the document title from the Info dictionary', () => {
    const out = extractPdfText(
      makePdf(
        `BT /F1 12 Tf 72 720 Td (${PROSE}) Tj ET`,
        '5 0 obj << /Title (Retry Semantics Paper) /Author (Someone) >> endobj'
      )
    )
    assert.ok(out.ok && out.title === 'Retry Semantics Paper')
  })

  test('a horizontal Td does not split a word', () => {
    // The failure this guards: treating every Td as a line break turns
    // "backoff" into "backof" + newline + "f".
    const out = extractPdfText(
      makePdf(
        'BT /F1 12 Tf 72 720 Td (Exponential backof) Tj 5 0 Td (f multiplies the delay by two now.) Tj ET'
      )
    )
    assert.ok(out.ok)
    assert.ok(out.ok && out.text.includes('backoff multiplies'))
  })

  test('a vertical Td does start a new line', () => {
    const out = extractPdfText(
      makePdf(
        `BT /F1 12 Tf 72 720 Td (${PROSE}) Tj 0 -14 Td (A second line of text appears here.) Tj ET`
      )
    )
    assert.ok(out.ok)
    assert.ok(out.ok && /abandoned entirely\.\nA second line/.test(out.text))
  })
})

describe('extractPdfText — FlateDecode', () => {
  test('inflates a compressed content stream', () => {
    const content = `BT /F1 12 Tf 72 720 Td (${PROSE}) Tj ET`
    const compressed = deflateSync(Buffer.from(content, 'latin1'))
    const head = Buffer.from(
      `%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n4 0 obj << /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`,
      'latin1'
    )
    const tail = Buffer.from('\nendstream\nendobj\ntrailer << >>\n%%EOF', 'latin1')
    const out = extractPdfText(new Uint8Array(Buffer.concat([head, compressed, tail])))
    assert.ok(out.ok)
    assert.ok(out.ok && out.text.includes('retry timeout defaults'))
  })
})

describe('extractPdfText — real Chromium-generated PDF', () => {
  // The hard case: subset fonts, glyph-indexed hex strings, and a ToUnicode
  // CMap — the path that silently produces mojibake when CMap handling is wrong.
  const bytes = new Uint8Array(readFileSync(join(__dirname, '..', '..', 'test/fixtures/chromium-sample.pdf')))
  const out = extractPdfText(bytes)

  test('extraction succeeds', () => {
    assert.ok(out.ok, out.ok ? '' : `failed: ${(out as { error: string }).error}`)
  })

  test('decodes the heading', () => {
    assert.ok(out.ok && out.text.includes('Retry Semantics'))
  })

  test('decodes body text exactly, with no split words', () => {
    assert.ok(out.ok && out.text.includes('Exponential backoff multiplies the delay by two after every failed attempt.'))
  })

  test('does not leave a stray break before terminal punctuation', () => {
    assert.ok(out.ok && out.text.includes('internal directory.'))
  })

  test('reads the title', () => {
    assert.ok(out.ok && out.title === 'Retry Semantics')
  })

  test('output passes the quality gate as real language', () => {
    assert.ok(out.ok && isLikelyText(out.text))
  })
})

describe('extractPdfText — refusals', () => {
  test('rejects a non-PDF payload', () => {
    const out = extractPdfText(new Uint8Array(Buffer.from('<html>not a pdf</html>')))
    assert.equal(out.ok, false)
    assert.match((out as { error: string }).error, /not a PDF/i)
  })

  test('rejects an empty payload', () => {
    const out = extractPdfText(new Uint8Array(0))
    assert.equal(out.ok, false)
  })

  test('reports encryption clearly rather than emitting nothing', () => {
    const out = extractPdfText(
      makePdf(`BT /F1 12 Tf 72 720 Td (${PROSE}) Tj ET`, '9 0 obj << /Encrypt 8 0 R >> endobj')
    )
    assert.equal(out.ok, false)
    assert.match((out as { error: string }).error, /encrypted/i)
  })

  test('explains a scanned document with no text layer', () => {
    // Page objects present, but no text-showing operators anywhere.
    const scanned = new Uint8Array(
      Buffer.from(
        '%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /XObject /Subtype /Image >> endobj\ntrailer << >>\n%%EOF',
        'latin1'
      )
    )
    const out = extractPdfText(scanned)
    assert.equal(out.ok, false)
    assert.match((out as { error: string }).error, /scan|OCR/i)
  })

  test('refuses garbled output instead of returning it', () => {
    // A content stream whose strings decode to symbol soup: the quality gate
    // must reject it, because nothing downstream could tell it from content.
    const noise = '\\001\\002\\003\\004\\005\\006\\007\\016\\017\\020\\021\\022'.repeat(20)
    const out = extractPdfText(makePdf(`BT /F1 12 Tf 72 720 Td (${noise}) Tj ET`))
    assert.equal(out.ok, false)
    assert.match((out as { error: string }).error, /could not be decoded|scan/i)
  })

  test('does not throw on a truncated PDF', () => {
    const truncated = new Uint8Array(
      Buffer.from('%PDF-1.4\n1 0 obj << /Length 999 >>\nstream\nBT /F1 12 Tf (abc', 'latin1')
    )
    assert.doesNotThrow(() => extractPdfText(truncated))
  })

  test('does not throw on corrupt flate data', () => {
    const head = Buffer.from(
      '%PDF-1.4\n4 0 obj << /Length 20 /Filter /FlateDecode >>\nstream\n',
      'latin1'
    )
    const garbage = Buffer.from([0x78, 0x9c, 0x00, 0xff, 0xfe, 0x01, 0x02, 0x03])
    const tail = Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1')
    assert.doesNotThrow(() =>
      extractPdfText(new Uint8Array(Buffer.concat([head, garbage, tail])))
    )
  })
})
