import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { deflateSync } from 'zlib'
import { extractPdfText } from '../src/main/ipc/pdf'
import { extractPdfTextOffThread, pdfWorkerPath } from '../src/main/ipc/pdfOffThread'
// Imported for its side effect on the build: the compiler emits the worker
// beside pdfOffThread, so these tests — and every attachment test after them —
// run the real worker. On the main thread the module does nothing.
import '../src/main/ipc/pdfWorker'

/**
 * v3.1 (M4): PDF extraction in a worker. Same outcome, the main thread free
 * while it runs, a throwing worker still a failure, and no path left calling
 * the synchronous extractor on the main thread.
 */

const SRC = join(__dirname, '..', '..', 'src')
const WORKER = pdfWorkerPath(join(__dirname, '..', 'src', 'main', 'ipc'))

/** A PDF of `pages` FlateDecode content streams, about `bytesPerPage` each inflated. */
function flatePdf(pages: number, bytesPerPage: number): Uint8Array {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')]
  for (let p = 0; p < pages; p++) {
    let content = 'BT /F1 10 Tf 72 720 Td 12 TL\n'
    for (let n = 0; content.length < bytesPerPage; n++) content += `(Line ${n} of page ${p}: the quick brown fox jumps over the lazy dog.) Tj T*\n`
    content += 'ET\n'
    const stream = deflateSync(Buffer.from(content, 'latin1'))
    parts.push(Buffer.from(`${p + 1} 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`), stream, Buffer.from('\nendstream\nendobj\n'))
  }
  return new Uint8Array(Buffer.concat(parts))
}

describe('extractPdfTextOffThread', () => {
  test('the test build carries the worker, so what follows runs it', () => {
    assert.ok(WORKER, 'pdfWorker.js was not emitted beside pdfOffThread.js')
  })

  test('a build without the worker file extracts in-thread, as before', () => {
    assert.equal(pdfWorkerPath(mkdtempSync(join(tmpdir(), 'sigma-noworker-'))), null)
  })

  test('the worker returns exactly what the in-thread extractor returns', async () => {
    const sample = new Uint8Array(readFileSync(join(__dirname, '..', '..', 'test/fixtures/chromium-sample.pdf')))
    for (const bytes of [sample, flatePdf(3, 4_000)]) {
      assert.deepEqual(await extractPdfTextOffThread(bytes, WORKER), extractPdfText(bytes))
    }
  })

  test('a refusal comes back as the same refusal', async () => {
    const junk = new Uint8Array(Buffer.from('not a pdf at all'))
    const out = await extractPdfTextOffThread(junk, WORKER)
    assert.equal(out.ok, false)
    assert.deepEqual(out, extractPdfText(junk))
  })

  test('the main thread keeps running while a large PDF is read — and cannot in-thread', async () => {
    const big = flatePdf(160, 100_000) // ~16 MB inflated: well past one timer tick anywhere
    const ticksDuring = async (workerPath: string | null): Promise<number> => {
      let ticks = 0
      const timer = setInterval(() => ticks++, 5)
      const pending = extractPdfTextOffThread(big, workerPath)
      const atReturn = ticks
      const out = await pending
      clearInterval(timer)
      assert.equal(out.ok, true)
      return ticks - atReturn
    }
    assert.ok((await ticksDuring(WORKER)) > 0, 'the timer never ran: extraction held the main thread')
    // The control: in-thread, the whole extraction happens before the call returns.
    let ranBeforeReturn = 0
    const timer = setInterval(() => ranBeforeReturn++, 5)
    const started = ranBeforeReturn
    extractPdfText(big)
    assert.equal(ranBeforeReturn, started, 'in-thread extraction let a timer run — the control is wrong')
    clearInterval(timer)
  })

  test('a worker that throws rejects, as the in-thread call would have thrown', async () => {
    const throwing = join(mkdtempSync(join(tmpdir(), 'sigma-throw-')), 'throws.js')
    writeFileSync(throwing, "throw new Error('the worker broke')\n")
    await assert.rejects(extractPdfTextOffThread(new Uint8Array([1, 2, 3]), throwing), /the worker broke/)
  })
})

describe('no main-thread PDF extraction is left', () => {
  const read = (...p: string[]): string => readFileSync(join(SRC, ...p), 'utf-8')

  test('attachments and fetched pages both extract off the main thread', () => {
    for (const file of ['attachments.ts', 'search.ts']) {
      const source = read('main', 'ipc', file)
      assert.match(source, /await extractPdfTextOffThread\(/, `${file} extracts off-thread`)
      assert.doesNotMatch(source, /[^.\w]extractPdfText\(/, `${file} still calls the synchronous extractor`)
    }
  })

  test('the build emits the worker beside index.js', () => {
    assert.match(read('..', 'electron.vite.config.ts'), /pdfWorker: resolve\(__dirname, 'src\/main\/ipc\/pdfWorker\.ts'\)/)
  })
})
