import { parentPort, workerData } from 'worker_threads'
import { extractPdfText } from './pdf'

/**
 * v3.1 (M4): the PDF worker's whole job — extract, post the outcome, exit.
 * Built as its own main-process entry (electron.vite.config.ts), so it lands
 * beside index.js as pdfWorker.js; pdfOffThread.ts starts it. Loaded on the
 * main thread (a test that imports it so the compiler emits it), there is no
 * parent port and it does nothing.
 */
if (parentPort) parentPort.postMessage(extractPdfText(workerData as Uint8Array))
