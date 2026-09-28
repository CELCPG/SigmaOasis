/**
 * The shipped main bundle, loaded for real: every module it names exists, and
 * the job surfaces that reach for sibling modules work in the built app.
 *
 * Why this is a check against out/ rather than a node test. electron-vite
 * bundles the whole main process into ONE file, out/main/index.js. A runtime
 * `require('./watchlist')` in src/main survives that verbatim — the bundler
 * only follows `import` — and there is no out/main/watchlist.js for it to find,
 * so it throws "Cannot find module" the first time it runs. The node suite
 * cannot see this: scripts/test.sh compiles src/ to CommonJS one file per
 * module, where `./watchlist` sits right next to its caller and resolves fine.
 * v2.6 shipped ten of these in main/ipc/jobs.ts. Settings → Jobs said "Nothing
 * on the watchlist" whatever was on it (the renderer's `.catch(() => [])` ate
 * the rejection), so a price job could not be added, and every scheduled
 * runner — research, price, ledger, packs — failed before doing anything, all
 * with the whole suite green.
 *
 * What is measured, and why each part is here:
 *
 *   - Every relative `require(…)`/`import(…)` left in out/main and out/preload
 *     resolves to a file that exists beside it. This is the class, not the ten
 *     instances: a lazy require anywhere in src/main — on a path no reading
 *     below exercises — fails here. It admits a chunk the bundler emitted and
 *     requires, so code-splitting later is not mistaken for the defect.
 *   - `watchlist:list`, called from the renderer through the preload exactly as
 *     the Jobs tab calls it, returns the seeded watchlist.
 *   - Settings → Jobs, switched to a price job, offers the seeded item in its
 *     picker rather than the empty-watchlist notice. That notice is the
 *     symptom that was actually seen; the IPC reading alone would not show that
 *     the tab gets what the handler returns.
 *   - Each shipped runner, run through `jobs:runNow`, gets past loading its
 *     modules and does its job. Research reaches the model; price fetches a
 *     page, reads its price and records it on the watchlist; ledger and packs
 *     read the library. A runner that merely returned without the module error
 *     would not show the modules work, so each has an outcome to meet.
 *
 * Nothing leaves the machine. A loopback fixture in the parent plays LM Studio,
 * the SearXNG endpoint and a retailer's product page; the product page is
 * reached through SIGMA_RESEARCH_FIXTURE_ORIGIN, the one seam the fetch guards
 * recognize. The seeded "Kettle" at example.com is listed and picked, never
 * fetched.
 *
 * Run through scripts/test-render.sh (Electron proper, not ELECTRON_RUN_AS_NODE),
 * which builds out/ first.
 */
import { app, BrowserWindow } from 'electron'
import { spawn } from 'child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { dirname, join, relative, resolve } from 'path'

const OUT_DIR = join(__dirname, '..', '..', 'out')
const KETTLE_URL = 'https://example.com/kettle'
const FIXTURE_MODEL = 'fixture-model'

type JobKind = 'research' | 'price' | 'ledger' | 'packs'

interface RunReading {
  kind: JobKind
  added: boolean
  addError?: string
  /** The IPC call itself settled; false means runNow rejected or timed out. */
  ran: boolean
  outcome?: string
  note?: string
  error?: string
}

interface ChildReading {
  watchlist: { ok: boolean; value?: { url: string; name: string }[]; error?: string }
  jobsTab: { opened: boolean; kindSet: boolean; pickerOptions: string[] | null; emptyNotice: boolean; detail: string }
  runs: RunReading[]
  /** History length of the fixture item in watchlist.json after the price run. */
  fixtureHistory: number
}

// ---------------------------------------------------------------------------
// Static: every relative module the bundles name is a file that exists.
// ---------------------------------------------------------------------------

function bundleFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return bundleFiles(p)
    return /\.(c|m)?js$/.test(name) ? [p] : []
  })
}

/** Node's own candidates for a relative specifier: as written, with an extension, as a directory. */
function resolvesOnDisk(from: string, spec: string): boolean {
  const base = resolve(dirname(from), spec)
  return [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}.json`, join(base, 'index.js')].some(
    (p) => existsSync(p) && statSync(p).isFile()
  )
}

function unresolvedRelativeModules(): { scanned: number; missing: string[] } {
  const files = [...bundleFiles(join(OUT_DIR, 'main')), ...bundleFiles(join(OUT_DIR, 'preload'))]
  const missing: string[] = []
  const pattern = /\b(require|import)\(\s*(["'`])(\.{1,2}\/[^"'`]+)\2\s*\)/g
  for (const file of files) {
    const text = readFileSync(file, 'utf-8')
    for (const m of text.matchAll(pattern)) {
      if (resolvesOnDisk(file, m[3]!)) continue
      const line = text.slice(0, m.index).split('\n').length
      missing.push(`${relative(OUT_DIR, file).split('\\').join('/')}:${line} ${m[1]}("${m[3]}")`)
    }
  }
  return { scanned: files.length, missing }
}

// ---------------------------------------------------------------------------
// Child: boot the built app on a seeded throwaway profile and take the readings.
// ---------------------------------------------------------------------------

function seedProfile(origin: string): string {
  const profile = mkdtempSync(join(tmpdir(), 'sigma-main-bundle-'))
  const settings = {
    // The fixture plays LM Studio and SearXNG, so a research run stays on loopback.
    baseUrl: `${origin}/v1`,
    onboardingCompleted: true,
    updates: { autoCheck: false },
    audit: { enabled: false, autoPurgeOnQuit: false },
    memory: { autoContext: false, topK: 3, embeddingModel: '' },
    claimCheck: { enabled: false, maxClaims: 5 },
    secondOpinion: { enabled: false, criticSlotId: null },
    search: { provider: 'searxng', searxngUrl: origin, maxResults: 8, confirmBeforeSearch: false, useHeadlessRenderer: false },
    research: { depth: 'quick', confirmPlan: false },
    // No proxy in a test profile; the price runner would otherwise skip before fetching.
    shopping: { requireProxy: false, maxSellers: 4, excludeTierX: true }
  }
  writeFileSync(join(profile, 'config.json'), JSON.stringify({ settings }, null, 2))
  const now = Date.now()
  writeFileSync(
    join(profile, 'watchlist.json'),
    JSON.stringify([
      { url: KETTLE_URL, name: 'Kettle', addedAt: now, history: [] },
      { url: `${origin}/kettle`, name: 'Fixture kettle', addedAt: now, history: [] }
    ])
  )
  return profile
}

async function child(origin: string): Promise<void> {
  const profile = seedProfile(origin)
  app.setPath('userData', profile)

  // An offscreen window still lays out and runs the renderer; a check must not
  // throw a window on the user's screen.
  let win: BrowserWindow | null = null
  app.on('browser-window-created', (_e, created) => {
    win = created
    created.show = (): void => {}
    created.showInactive = (): void => {}
  })

  // Synchronously, before ready: the bundle registers a privileged scheme at load.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require(join(OUT_DIR, 'main', 'index.js'))

  await app.whenReady()
  const deadline = Date.now() + 20_000
  while (!win && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  if (!win) throw new Error('the app created no window')
  const wc = (win as BrowserWindow).webContents
  await new Promise<void>((r) => {
    if (!wc.isLoading()) return r()
    wc.once('did-finish-load', () => r())
  })
  await new Promise((r) => setTimeout(r, 2500))

  const evalIn = <T>(code: string, timeoutMs = 30_000): Promise<T> =>
    Promise.race([
      wc.executeJavaScript(code) as Promise<T>,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs))
    ])
  /** A renderer promise, settled either way so a rejection is a reading, not a crash. */
  const settled = <T>(expr: string): Promise<{ ok: boolean; value?: T; error?: string }> =>
    evalIn<{ ok: boolean; value?: T; error?: string }>(
      `Promise.resolve().then(() => ${expr}).then((value) => ({ ok: true, value }), (e) => ({ ok: false, error: String(e && e.message || e) }))`
    ).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))

  // --- the IPC reading: the preload's call, as the Jobs tab makes it ---------
  const watchlist = await settled<{ url: string; name: string }[]>('window.api.watchlistList()')

  // --- the tab: Settings → Jobs → Kind "price" -------------------------------
  const jobsTab = await evalIn<ChildReading['jobsTab']>(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const gear = document.querySelector('[title^="Settings"]')
    if (!gear) return { opened: false, kindSet: false, pickerOptions: null, emptyNotice: false, detail: 'no Settings control' }
    gear.click()
    await wait(500)
    const dialog = document.querySelector('[role="dialog"]')
    const tab = dialog && [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Jobs')
    if (!tab) return { opened: false, kindSet: false, pickerOptions: null, emptyNotice: false, detail: 'no Jobs tab in the settings dialog' }
    tab.click()
    await wait(800)
    const kind = [...dialog.querySelectorAll('select')].find((s) => s.querySelector('option[value="price"]'))
    if (!kind) return { opened: true, kindSet: false, pickerOptions: null, emptyNotice: false, detail: 'no Kind select offering "price"' }
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(kind, 'price')
    kind.dispatchEvent(new Event('change', { bubbles: true }))
    await wait(400)
    const label = [...dialog.querySelectorAll('label')].find((l) => l.textContent.includes('Watched item'))
    if (!label) return { opened: true, kindSet: false, pickerOptions: null, emptyNotice: false, detail: 'no "Watched item" field after choosing price' }
    const picker = label.querySelector('select')
    return {
      opened: true,
      kindSet: true,
      pickerOptions: picker ? [...picker.options].map((o) => o.textContent.trim()) : null,
      emptyNotice: label.textContent.includes('Nothing on the watchlist'),
      detail: label.textContent.trim().replace(/\\s+/g, ' ').slice(0, 160)
    }
  })()`)
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })

  // --- the runners: add, switch off (so the scheduler's own tick cannot race
  // the reading — runNow runs a job whether or not it is enabled), run now ----
  const specs: { kind: JobKind; args: Record<string, unknown> }[] = [
    { kind: 'packs', args: {} },
    { kind: 'ledger', args: {} },
    { kind: 'price', args: { url: `${origin}/kettle` } },
    { kind: 'research', args: { question: 'What does the fixture kettle cost?', depth: 'quick', modelId: FIXTURE_MODEL } }
  ]
  const runs: RunReading[] = []
  for (const spec of specs) {
    const input = JSON.stringify({ kind: spec.kind, interval: 'daily', args: spec.args })
    const added = await settled<{ ok: boolean; job?: { id: string }; error?: string }>(`window.api.jobsAdd(${input})`)
    const id = added.value?.job?.id
    if (!added.ok || !added.value?.ok || !id) {
      runs.push({ kind: spec.kind, added: false, addError: added.error ?? added.value?.error, ran: false })
      continue
    }
    await settled(`window.api.jobsUpdate(${JSON.stringify(id)}, { enabled: false })`)
    const r = await settled<{ ok: boolean; outcome?: string; note?: string; error?: string }>(`window.api.jobsRunNow(${JSON.stringify(id)})`)
    runs.push({
      kind: spec.kind,
      added: true,
      ran: r.ok && r.value?.ok === true,
      outcome: r.value?.outcome,
      note: r.value?.note,
      error: r.error ?? r.value?.error
    })
  }

  let fixtureHistory = -1
  try {
    const entries = JSON.parse(readFileSync(join(profile, 'watchlist.json'), 'utf-8')) as { url: string; history?: unknown[] }[]
    fixtureHistory = entries.find((e) => e.url === `${origin}/kettle`)?.history?.length ?? -1
  } catch {
    /* reported as -1 */
  }

  const reading: ChildReading = { watchlist, jobsTab, runs, fixtureHistory }
  console.log(`MAIN_BUNDLE_RESULT ${JSON.stringify(reading)}`)
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* a leftover temp profile is not worth failing a run over */
  }
  app.exit(0)
}

// ---------------------------------------------------------------------------
// Parent: serve the fixture, run the child, judge the readings.
// ---------------------------------------------------------------------------

const PRODUCT_PAGE = `<!doctype html><html><head><title>Fixture kettle</title>
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'Fixture kettle',
  offers: { '@type': 'Offer', price: '42.50', priceCurrency: 'GBP', availability: 'https://schema.org/InStock' }
})}</script></head><body><h1>Fixture kettle</h1><p>A kettle, for checking prices against.</p></body></html>`

/** Every request the fixture saw, as "METHOD /path". */
const seen: string[] = []

async function startFixture(): Promise<{ origin: string; close: () => void }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://fixture').pathname
    seen.push(`${req.method} ${path}`)
    req.resume()
    if (path === '/kettle') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PRODUCT_PAGE)
    } else if (path === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: FIXTURE_MODEL, object: 'model' }] }))
    } else if (path === '/search') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ results: [] }))
    } else if (path === '/v1/chat/completions') {
      // Reaching this is the reading; answering it well is deepResearch.test.ts's job.
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'fixture model is not serving' } }))
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const { port } = server.address() as AddressInfo
  return { origin: `http://127.0.0.1:${port}`, close: () => server.close() }
}

function runChild(origin: string): Promise<ChildReading> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(process.execPath, ['--no-sandbox', __filename], {
      env: { ...process.env, MAIN_BUNDLE_FIXTURE: origin, SIGMA_RESEARCH_FIXTURE_ORIGIN: origin },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()))
    proc.stderr.on('data', (d: Buffer) => (err += d.toString()))
    proc.on('exit', (code) => {
      const line = out.split(/\r?\n/).find((l) => l.startsWith('MAIN_BUNDLE_RESULT '))
      if (!line) {
        reject(new Error(`the child produced no reading (exit ${String(code)})\n${out}\n${err}`))
        return
      }
      resolvePromise(JSON.parse(line.slice('MAIN_BUNDLE_RESULT '.length)) as ChildReading)
    })
    proc.on('error', reject)
  })
}

let passed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ''))
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const MODULE_ERROR = /Cannot find module/i

async function parent(): Promise<void> {
  console.log('the bundles name only modules that exist')
  const { scanned, missing } = unresolvedRelativeModules()
  check('out/main and out/preload were built', scanned >= 2, `${scanned} bundle file(s) under ${OUT_DIR}`)
  check(
    'every relative require/import in the bundles resolves to a file',
    missing.length === 0,
    `${missing.length} unresolved:\n      ${missing.join('\n      ')}`
  )

  const fixture = await startFixture()
  let r: ChildReading
  try {
    r = await runChild(fixture.origin)
  } finally {
    fixture.close()
  }

  console.log('\nthe watchlist reaches the Jobs tab')
  const kettle = r.watchlist.value?.find((w) => w.url === KETTLE_URL)
  check('watchlist:list resolves', r.watchlist.ok, r.watchlist.error ?? '')
  check('watchlist:list returns the seeded Kettle', kettle?.name === 'Kettle', JSON.stringify(r.watchlist.value ?? null))
  check('Settings → Jobs opens and takes Kind "price"', r.jobsTab.opened && r.jobsTab.kindSet, r.jobsTab.detail)
  check(
    'the watched-item picker offers the Kettle',
    (r.jobsTab.pickerOptions ?? []).includes('Kettle') && !r.jobsTab.emptyNotice,
    r.jobsTab.detail
  )

  console.log('\nreadings: what each runner said, and what the fixture was asked')
  for (const x of r.runs) console.log(`  ${x.kind}: ${x.outcome ?? '-'}: ${x.note ?? x.error ?? x.addError ?? ''}`)
  console.log(`  fixture: ${[...new Set(seen)].join(', ')}`)

  console.log('\neach shipped runner loads its modules and does its job')
  const run = (kind: JobKind): RunReading | undefined => r.runs.find((x) => x.kind === kind)
  for (const x of r.runs) {
    const said = `${x.outcome ?? '-'}: ${x.note ?? x.error ?? x.addError ?? ''}`
    check(`${x.kind}: added and run through jobs:runNow`, x.added && x.ran, said)
    check(`${x.kind}: no module failed to load`, !MODULE_ERROR.test(`${x.note ?? ''} ${x.error ?? ''}`), said)
  }
  const packs = run('packs')
  check('packs: read the library', packs?.outcome === 'ok' && /no tracked folders/.test(packs.note ?? ''), `${packs?.outcome}: ${packs?.note}`)
  const ledger = run('ledger')
  check('ledger: read the ledger pack', ledger?.outcome === 'ok' && /nothing past its freshness/.test(ledger.note ?? ''), `${ledger?.outcome}: ${ledger?.note}`)
  const price = run('price')
  check('price: fetched the product page', seen.includes('GET /kettle'), `fixture saw ${JSON.stringify(seen)}`)
  check('price: read the price', price?.outcome === 'ok' && /first check: \D*42\.5/.test(price.note ?? ''), `${price?.outcome}: ${price?.note}`)
  check('price: recorded it on the watchlist', r.fixtureHistory === 1, `${r.fixtureHistory} history point(s)`)
  const research = run('research')
  check(
    'research: reached the model through deep research',
    seen.includes('POST /v1/chat/completions'),
    `${research?.outcome}: ${research?.note}; fixture saw ${JSON.stringify(seen)}`
  )

  console.log(`\n${'='.repeat(58)}`)
  if (failures.length === 0) {
    console.log(`ALL ${passed} MAIN-BUNDLE CHECKS PASSED`)
    app.exit(0)
  } else {
    console.log(`${passed} passed, ${failures.length} FAILED:`)
    for (const f of failures) console.log(`  - ${f}`)
    app.exit(1)
  }
}

const FIXTURE = process.env.MAIN_BUNDLE_FIXTURE
if (FIXTURE) {
  child(FIXTURE).catch((err) => {
    console.error('MAIN-BUNDLE CHILD ERROR:', err)
    app.exit(1)
  })
} else {
  app.whenReady().then(() =>
    parent().catch((err) => {
      console.error('MAIN-BUNDLE CHECK ERROR:', err)
      app.exit(1)
    })
  )
}
