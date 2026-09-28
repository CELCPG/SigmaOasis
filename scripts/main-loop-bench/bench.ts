/**
 * M4 (v3.1): how long the main process stops answering while it does its
 * heaviest synchronous work — with an agent task's stream running through it.
 *
 * Since 3.0 an agent task lives in the main process: its stream, its stall
 * timer, its approvals. So a main-thread stall is no longer only a frozen IPC
 * reply; it is a live stream that stops arriving. This runs inside Electron's
 * own main process (scripts/main-loop-bench.sh bundles it), holds a stream open
 * from a stand-in server in another process (stream-server.mjs: a token every
 * 25 ms, on its own clock), and in each phase records
 *
 *   - the event loop's delay (`perf_hooks.monitorEventLoopDelay`, 10 ms
 *     resolution): p50, p99, max;
 *   - the stream's longest gap between chunks, and its p99 — the stall a
 *     reader of the agent's timeline would see;
 *   - the phase's wall time.
 *
 * The phases are the app's own code paths at their caps, called as the app
 * calls them:
 *
 *   baseline  the stream alone
 *   pdf       a PDF attached three times — readTextDocument, the path both an
 *             attachment and a folder pack take: 400 FlateDecode content
 *             streams, 40 MB inflated (MAX_DECOMPRESSED_BYTES), text operators
 *   folder    a folder pack at MAX_PACK_CHARS — createPackFromFolder, then the
 *             first lookup, which builds the library's BM25 index
 *   render    five pages opened by render.ts, which makes a session and a
 *             window per page
 *
 * The inputs are generated from a fixed seed, so two runs measure one workload.
 */
import { app } from 'electron'
import { spawn } from 'child_process'
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { monitorEventLoopDelay, performance } from 'perf_hooks'
import { deflateSync } from 'zlib'
import { readTextDocument } from '../../src/main/ipc/attachments'
import { createPackFromFolder, lookupLibrary, setLibraryDirForTests } from '../../src/main/ipc/library'
import { renderPage } from '../../src/main/ipc/render'

const WORK = process.env.MAIN_LOOP_BENCH_DIR!
const LABEL = process.env.MAIN_LOOP_BENCH_LABEL || 'unlabelled'
const SERVER = process.env.MAIN_LOOP_BENCH_SERVER!
app.setPath('userData', join(WORK, 'userData'))
// render.ts's windows are the only windows; closing the last must not quit.
app.on('window-all-closed', () => undefined)
// render.ts loads only https. The bench serves its pages with a throwaway
// self-signed certificate and trusts exactly that origin — here, in the bench
// process, never in the app.
const TLS_PORT = Number(process.env.MAIN_LOOP_BENCH_TLS_PORT || 0)
app.on('certificate-error', (event, _contents, url, _error, _cert, callback) => {
  if (TLS_PORT && url.startsWith(`https://127.0.0.1:${TLS_PORT}/`)) {
    event.preventDefault()
    callback(true)
  } else callback(false)
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function prng(seed: number): () => number {
  let x = seed
  return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648
}
const WORDS = (
  'the of and to in is that for it as was with be by on not he this are or his from at which but have an they ' +
  'you were her she there been one all we their has would when if so no will more what up out about who them ' +
  'river lantern orchard copper meadow harbor signal pencil garden violet thunder ledger canyon marble'
).split(' ')

/** A PDF at the extraction caps: `pages` FlateDecode content streams of `bytesPerPage` each. */
function syntheticPdf(pages: number, bytesPerPage: number): Buffer {
  const rand = prng(7)
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')]
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')
  parts.push(Buffer.from(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages} >>\nendobj\n`))
  for (let p = 0; p < pages; p++) {
    let content = 'BT /F1 10 Tf 72 720 Td 12 TL\n'
    while (content.length < bytesPerPage) {
      const line = Array.from({ length: 12 }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' ')
      content += `(${line}) Tj T*\n`
    }
    content += 'ET\n'
    const stream = deflateSync(Buffer.from(content, 'latin1'))
    const pageId = 3 + p * 2
    parts.push(Buffer.from(`${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /Contents ${pageId + 1} 0 R >>\nendobj\n`))
    parts.push(Buffer.from(`${pageId + 1} 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`))
    parts.push(stream, Buffer.from('\nendstream\nendobj\n'))
  }
  parts.push(Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n'))
  return Buffer.concat(parts)
}

/** A folder of markdown documents totalling `totalChars`, sectioned by headings. */
function syntheticFolder(dir: string, files: number, totalChars: number): void {
  const rand = prng(11)
  mkdirSync(dir, { recursive: true })
  const perFile = Math.floor(totalChars / files)
  for (let f = 0; f < files; f++) {
    let text = `# Document ${f}\n\n`
    let section = 0
    while (text.length < perFile) {
      if (text.length > (section + 1) * 1800) text += `\n## Section ${++section}\n\n`
      text += Array.from({ length: 14 }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' ') + '.\n'
    }
    writeFileSync(join(dir, `doc-${String(f).padStart(3, '0')}.md`), text.slice(0, perFile))
  }
}

interface PhaseResult {
  phase: string
  wallMs: number
  loopP50Ms: number
  loopP99Ms: number
  loopMaxMs: number
  streamMaxGapMs: number
  streamP99GapMs: number
}

async function phase(name: string, port: number, work: () => Promise<void>): Promise<PhaseResult> {
  const gaps: number[] = []
  let last = performance.now()
  const ac = new AbortController()
  const reading = (async () => {
    const res = await fetch(`http://127.0.0.1:${port}/stream`, { signal: ac.signal })
    const reader = res.body!.getReader()
    for (;;) {
      const { done } = await reader.read()
      if (done) break
      const now = performance.now()
      gaps.push(now - last)
      last = now
    }
  })().catch(() => undefined)
  await sleep(1000) // the stream settles into its rhythm
  const loop = monitorEventLoopDelay({ resolution: 10 })
  loop.enable()
  gaps.length = 0
  last = performance.now()
  const started = performance.now()
  await work()
  const wallMs = performance.now() - started
  await sleep(300)
  loop.disable()
  ac.abort()
  await reading
  const sorted = [...gaps].sort((a, b) => a - b)
  const round = (n: number): number => Math.round(n * 10) / 10
  return {
    phase: name,
    wallMs: round(wallMs),
    loopP50Ms: round(loop.percentile(50) / 1e6),
    loopP99Ms: round(loop.percentile(99) / 1e6),
    loopMaxMs: round(loop.max / 1e6),
    streamMaxGapMs: round(sorted[sorted.length - 1] ?? 0),
    streamP99GapMs: round(sorted[Math.floor(sorted.length * 0.99)] ?? 0)
  }
}

async function main(): Promise<void> {
  await app.whenReady()
  const port = Number(SERVER)
  const inputs = join(WORK, 'inputs')
  rmSync(join(WORK, 'library'), { recursive: true, force: true })
  mkdirSync(inputs, { recursive: true })
  setLibraryDirForTests(join(WORK, 'library'))

  const pdfPath = join(inputs, 'cap.pdf')
  const pdf = syntheticPdf(400, 100_000)
  writeFileSync(pdfPath, pdf)
  const folder = join(inputs, 'folder')
  rmSync(folder, { recursive: true, force: true })
  syntheticFolder(folder, 400, 8_000_000)
  console.log(`inputs: a ${(pdf.length / 1e6).toFixed(1)} MB PDF (400 streams, 40 MB inflated); a folder of 400 documents, 8.0M chars`)
  // Which way this tree extracts PDFs: a worker beside the bundle (v3.1), or in-thread.
  const pdfWorker = existsSync(join(__dirname, 'pdfWorker.js'))
  console.log(`pdf extraction: ${pdfWorker ? 'in a worker (pdfWorker.js beside the bundle)' : 'on the main thread'}`)

  const results: PhaseResult[] = []
  results.push(await phase('baseline', port, () => sleep(3000)))
  results.push(
    await phase('pdf', port, async () => {
      for (let i = 0; i < 3; i++) {
        const doc = await readTextDocument(pdfPath, 20_000)
        if (!doc.text) throw new Error('the synthetic PDF produced no text — the phase would measure nothing')
        await sleep(300)
      }
    })
  )
  results.push(
    await phase('folder', port, async () => {
      await createPackFromFolder(folder, { name: 'Bench folder' })
      const found = await lookupLibrary({ query: 'river lantern orchard' })
      if (!found.ok || found.passages.length === 0) throw new Error('the folder pack answered nothing — the phase would measure nothing')
    })
  )
  if (!TLS_PORT) console.log('render: skipped — no openssl for the throwaway certificate render.ts needs')
  else results.push(
    await phase('render', port, async () => {
      for (let i = 0; i < 5; i++) {
        const page = await renderPage(`https://127.0.0.1:${TLS_PORT}/page/${i}`)
        if (!page.ok || !page.text) throw new Error(`render of page ${i} produced no text${page.ok ? '' : `: ${page.error}`}`)
      }
    })
  )

  const cols: (keyof PhaseResult)[] = ['phase', 'wallMs', 'loopP50Ms', 'loopP99Ms', 'loopMaxMs', 'streamP99GapMs', 'streamMaxGapMs']
  console.log(`\n${LABEL}`)
  console.log(cols.map((c) => String(c).padStart(14)).join(''))
  for (const r of results) console.log(cols.map((c) => String(r[c]).padStart(14)).join(''))
  appendFileSync(
    join(WORK, 'results.jsonl'),
    JSON.stringify({ label: LABEL, at: new Date().toISOString(), platform: process.platform, electron: process.versions.electron, pdfWorker, results }) + '\n'
  )
}

main()
  .then(() => app.exit(0))
  .catch((err) => {
    console.error('main-loop bench failed:', err)
    app.exit(1)
  })
