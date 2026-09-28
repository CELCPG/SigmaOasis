import { existsSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import { extractPdfText, type PdfFailure, type PdfOutcome } from './pdf'

/**
 * v3.1 (M4): PDF extraction off the main thread.
 *
 * Since 3.0 an agent task runs in the main process — its stream, its stall
 * timer, its approvals — so a main-thread stall is a live stream that stops
 * arriving. Measured with scripts/main-loop-bench.sh on the bench machine
 * (Electron 44, Windows), a stream running throughout:
 *
 *   phase                 loop delay p99   max      the stream's longest gap
 *   stream alone          16.5 ms          16.7 ms  32 ms
 *   a PDF at the caps     320 ms           322 ms   355 ms
 *   a folder pack (8M)    23 ms            94 ms    102 ms
 *   five rendered pages   22 ms            25 ms    37 ms
 *
 * extractPdfText inflates up to 40 MB with zlib's synchronous calls and parses
 * the result in one go; nothing else the main process does at its caps comes
 * near the 100 ms the roadmap set, and window-per-page rendering, the other
 * candidate since v2.4, does not either — so it is left as it is. Extraction
 * runs in a worker, unchanged: pdf.ts is pure (zlib and nothing else), and the
 * worker is pdfWorker.ts around it.
 *
 * Where there is no worker file beside this module — the CLI's bundle — it
 * extracts in-thread exactly as before. A worker that throws rejects, as the
 * in-thread call would have thrown; the outcome it posts is the same object
 * extractPdfText returns.
 */

const WORKER_FILE = 'pdfWorker.js'

/** The built worker beside this module, or null when this build has none. */
export function pdfWorkerPath(dir: string = __dirname): string | null {
  const path = join(dir, WORKER_FILE)
  return existsSync(path) ? path : null
}

export function extractPdfTextOffThread(
  bytes: Uint8Array,
  workerPath: string | null = pdfWorkerPath()
): Promise<PdfOutcome | PdfFailure> {
  if (!workerPath) return Promise.resolve(extractPdfText(bytes))
  return new Promise((resolve, reject) => {
    // Copied, not transferred: the bytes may be a view on a pooled Buffer
    // whose other tenants a transfer would detach.
    const worker = new Worker(workerPath, { workerData: bytes })
    let settled = false
    worker.once('message', (outcome: PdfOutcome | PdfFailure) => {
      settled = true
      resolve(outcome)
      void worker.terminate()
    })
    worker.once('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
    worker.once('exit', (code) => {
      if (settled) return
      settled = true
      reject(new Error(`PDF extraction stopped before it finished (worker exit ${code}).`))
    })
  })
}
