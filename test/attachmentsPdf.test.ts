import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { load } from './harness'

const { readTextDocument } = load<typeof import('../src/main/ipc/attachments')>('attachments')

/**
 * Local PDF ingestion. `extractPdfText` itself is covered by pdf.test.ts; what
 * matters here is that the attachment path uses it and — the part worth
 * pinning — that its refusals reach the user intact.
 *
 * The failure this guards against is a PDF whose text cannot be decoded being
 * flattened into a generic "could not read the file", or worse, mojibake being
 * handed to a model that cannot tell it from content.
 */

const dir = mkdtempSync(join(tmpdir(), 'sigma-pdf-'))

function write(name: string, bytes: Buffer | string): string {
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return path
}

/** Minimal PDF with an uncompressed content stream, mirroring pdf.test.ts. */
function makePdf(content: string): Buffer {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n2 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    'latin1'
  )
}

const PROSE =
  'The quarterly report shows revenue increased across all regions during the period under review.'

describe('readTextDocument — PDFs', () => {
  test('extracts text from a PDF instead of refusing it', async () => {
    const path = write('report.pdf', makePdf(`BT /F1 12 Tf 72 720 Td (${PROSE}) Tj ET`))
    const doc = await readTextDocument(path, 20_000)
    assert.equal(doc.name, 'report.pdf')
    assert.match(doc.text, /revenue increased/)
    assert.equal(doc.truncated, false)
  })

  test('truncation is reported rather than silent', async () => {
    // Real prose, not a repeated character: the extractor refuses text that
    // fails its "is this actually readable" check, and rightly so.
    const long = `${PROSE} `.repeat(20)
    const path = write('long.pdf', makePdf(`BT /F1 12 Tf 72 720 Td (${long}) Tj ET`))
    const doc = await readTextDocument(path, 100)
    assert.equal(doc.text.length, 100)
    assert.equal(doc.truncated, true)
  })

  test('an encrypted PDF surfaces its specific reason, not a generic failure', async () => {
    const path = write(
      'locked.pdf',
      Buffer.concat([makePdf('BT (x) Tj ET'), Buffer.from('\ntrailer\n<< /Encrypt 9 0 R >>\n')])
    )
    await assert.rejects(
      () => readTextDocument(path, 20_000),
      (err: Error) => {
        assert.match(err.message, /encrypted/i)
        return true
      }
    )
  })

  test('a PDF with no text layer says so rather than returning nothing', async () => {
    // A page object with no content stream is what a pure scan looks like.
    const path = write('scan.pdf', Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n'))
    await assert.rejects(
      () => readTextDocument(path, 20_000),
      (err: Error) => {
        assert.match(err.message, /text layer|OCR/i)
        return true
      }
    )
  })

  test('a file that is not a PDF at all is refused on its header', async () => {
    const path = write('fake.pdf', '<html>definitely not a pdf</html>')
    await assert.rejects(() => readTextDocument(path, 20_000), /not a PDF/i)
  })

  test('a real Chromium-generated PDF round-trips', async () => {
    const bytes = readFileSync(join(__dirname, '..', '..', 'test/fixtures/chromium-sample.pdf'))
    const path = write('chromium.pdf', bytes)
    const doc = await readTextDocument(path, 20_000)
    assert.ok(doc.text.length > 0)
  })
})

describe('readTextDocument — non-PDF paths still work', () => {
  test('a text file is read as before', async () => {
    const path = write('notes.md', '# Heading\n\nSome content.')
    const doc = await readTextDocument(path, 20_000)
    assert.match(doc.text, /Some content/)
  })

  test('an unsupported extension names PDFs as supported', async () => {
    const path = write('archive.zip', 'PK')
    await assert.rejects(() => readTextDocument(path, 20_000), /PDF/)
  })
})
