/**
 * Form fields are legible in both themes — measured on the shipped build.
 *
 * Tailwind's preflight gives `input`, `select` and `textarea` `color: inherit`
 * and leaves their background alone, so a control written with layout classes
 * only (`mt-1 w-full`) drew the theme's ink on the browser's own field colour.
 * The app never declared a colour scheme, so that field colour was white in
 * both themes: rgba(255,255,255,0.95) on rgb(255,255,255) in the dark one, and
 * whatever was typed into Settings → MCP, Jobs or a model's Code Mode picker
 * was invisible. The same default was behind a second face of it — the list a
 * `<select>` opens is its own page, and Chromium paints it in the owner's
 * colour scheme (internal_popup_menu.cc writes `color-scheme: only light` or
 * `only dark` from the owner's style). With no scheme declared that page was
 * white, and every `bg-transparent` select in the dark theme opened a list of
 * white options on white — on Windows and Linux, which use that popup; macOS
 * hands the list to a native menu and never showed it.
 *
 * Why the app itself and not a fixture: which controls exist, which classes
 * they carry and which surfaces they sit on is the component tree, and a copy
 * of it would keep passing after the tree changed. So this boots `out/main` on
 * a throwaway profile seeded with one job and one (disabled) MCP server — so
 * the rows that only render when there is something to list do render — opens
 * Settings, walks every tab in its rail, opens every disclosure, and reads
 * every field. The Project modal is read the same way.
 *
 * Not reached: Jobs' watched-item picker, which renders once the kind is
 * "price" and the watchlist has an entry. In the built app the watchlist IPC
 * `require`s a module the single-file main bundle does not contain, so the
 * list always comes back empty and the picker never appears. It carries the
 * same class string as its neighbours, and the probe below covers it; seed a
 * watchlist.json and switch the kind here once that is fixed.
 *
 * What is measured, per control:
 *
 *   - the value text (`color`) composited over every background above it, root
 *     to control, opacity included — the same composite chromeContrastCheck
 *     takes for reply chrome;
 *   - for a `<select>`, each option over the list it opens: the select's own
 *     background over the Canvas of the scheme the list is drawn in. That list
 *     cannot be captured from here, so this is a model of it, read from the
 *     computed colour scheme rather than assumed;
 *   - and, per tab, a probe: an `<input>`, `<select>` and `<textarea>` with no
 *     classes at all, dropped into the tab. The instances above are what ships
 *     today; the probe is the class — a field someone adds tomorrow and forgets
 *     to dress.
 *
 * The bar is 3:1, not the 4.5:1 AA the ink tiers are held to (styleCheck and
 * chromeContrastCheck hold those): this check exists to find text that is not
 * there at all, and measured field text either clears AA with room or sits
 * near 1:1.
 *
 * Set FIELD_CONTRAST_SHOTS to a directory to also get a PNG of every tab, per
 * theme, page by page down its scroll.
 *
 * Run through scripts/test-render.sh (Electron proper, not ELECTRON_RUN_AS_NODE).
 */
import { app, BrowserWindow } from 'electron'
import { spawn } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/** Below this, the text in a field is not a legibility problem — it is missing. */
const FLOOR = 3

type Theme = 'light' | 'dark'

interface FieldReading {
  surface: string
  control: string
  fg: string
  bg: string
  ratio: number
  /** A `<select>` only: the worst option over the list it opens. */
  list?: { option: string; fg: string; bg: string; ratio: number; scheme: string }
  probe: boolean
}

interface Reading {
  theme: Theme
  /** The tab labels the rail offered, in order. */
  tabs: string[]
  /** Surfaces the driver opened and read, including the Project modal. */
  read: string[]
  fields: FieldReading[]
  /** Controls the seed exists to put on screen; see SEEDED. */
  seeded: Record<string, boolean>
}

/**
 * Rows that render only when there is something to list — a job, a server, a
 * model slot (the defaults bring five) — and were among the fields found white
 * on white. Each is named by the aria-label suffix the component gives it, so a
 * rename fails here loudly rather than quietly shrinking what is measured.
 */
const SEEDED: Record<string, string> = {
  'a job row’s interval': 'select[aria-label$=" interval"]',
  'an MCP server row’s approval': 'select[aria-label$=" approval"]',
  'a model slot’s Code Mode': 'select[aria-label$=" code mode"]'
}

// ---------------------------------------------------------------------------
// Child: boot the real app on a seeded throwaway profile and take the readings.
// ---------------------------------------------------------------------------

function seedProfile(theme: Theme): string {
  const profile = mkdtempSync(join(tmpdir(), 'sigma-field-contrast-'))
  const now = Date.now()
  const settings = {
    // A port nothing is listening on: nothing here needs a model.
    baseUrl: 'http://127.0.0.1:65533/v1',
    onboardingCompleted: true,
    theme,
    updates: { autoCheck: false },
    audit: { enabled: false, autoPurgeOnQuit: false },
    memory: { autoContext: false, topK: 3, embeddingModel: '' },
    claimCheck: { enabled: false, maxClaims: 5 },
    secondOpinion: { enabled: false, criticSlotId: null },
    grounding: { autoCorrect: false, playbooks: false, selfReview: false, workbenchChecks: false, ledger: false },
    // Saved off, as the tab itself saves one: listed, never started.
    mcp: {
      servers: [
        { id: 'fs', name: 'Filesystem', command: 'npx', args: [], env: {}, enabled: false, disabledTools: [], approval: 'ask' }
      ]
    },
    projects: [
      { id: 'proj-1', name: 'Field notes', color: 'blue', instructions: '', createdAt: now - 100_000, files: [], defaults: {} }
    ]
  }
  writeFileSync(join(profile, 'config.json'), JSON.stringify({ settings }, null, 2))
  // Off, and not due for a long time: the scheduler has nothing to run.
  writeFileSync(
    join(profile, 'jobs.json'),
    JSON.stringify({
      jobs: [
        {
          id: 'job-1',
          kind: 'research',
          title: 'Planning rules',
          interval: 'daily',
          args: { question: 'What changed in the local planning rules?', depth: 'standard' },
          enabled: false,
          nextAt: now + 30 * 24 * 3600_000,
          failures: 0,
          digestConversationId: 'digest-job-1',
          createdAt: now - 50_000
        }
      ]
    })
  )
  return profile
}

/**
 * Runs in the page. Reads every visible text-bearing field under `rootSel`,
 * plus three unstyled probes on each surface in `probeHosts` that exists, and
 * returns them as JSON.
 */
const READ_FIELDS = (surface: string, rootSel: string, probeHosts: string[]): string => `(() => {
  const parse = (s) => {
    const n = (s.match(/[\\d.]+/g) || []).map(Number)
    return [n[0] || 0, n[1] || 0, n[2] || 0, n.length > 3 ? n[3] : 1]
  }
  const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1)
  const chan = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  const lum = (c) => 0.2126 * chan(c[0]) + 0.7152 * chan(c[1]) + 0.0722 * chan(c[2])
  const ratio = (a, b) => {
    const x = lum(a), y = lum(b)
    return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100
  }
  const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

  // The Canvas colour of a colour scheme, resolved by the engine rather than
  // restated here: a probe with that scheme and a system-colour background.
  const canvasOf = (scheme) => {
    const p = document.createElement('div')
    p.style.cssText = 'position:absolute;width:0;height:0;background-color:Canvas;color-scheme:' + scheme
    document.body.appendChild(p)
    const c = parse(getComputedStyle(p).backgroundColor)
    p.remove()
    return c
  }

  // Root → control, each layer dimmed by its own opacity and its ancestors'.
  const composite = (el) => {
    const nodes = []
    for (let n = el; n; n = n.parentElement) nodes.push(n)
    nodes.reverse()
    let bg = canvasOf(getComputedStyle(document.documentElement).colorScheme)
    let dim = 1
    let ink = null
    for (const n of nodes) {
      const s = getComputedStyle(n)
      const o = parseFloat(s.opacity)
      dim *= Number.isFinite(o) ? o : 1
      const c = parse(s.backgroundColor)
      bg = over([c[0], c[1], c[2], c[3] * dim], bg)
      if (n === el) ink = parse(s.color)
    }
    const fg = over([ink[0], ink[1], ink[2], ink[3] * dim], bg)
    return { fg, bg }
  }

  const name = (el) => {
    const own = el.getAttribute('aria-label') || el.getAttribute('placeholder') || ''
    const label = el.closest('label')
    const text = label ? (label.innerText || '').split('\\n')[0].trim() : ''
    const type = el.tagName === 'INPUT' ? '[' + (el.getAttribute('type') || 'text') + ']' : ''
    return el.tagName.toLowerCase() + type + ' · ' + (own || text || el.getAttribute('data-field-probe') || '?').slice(0, 60)
  }

  const read = (el, probe) => {
    const { fg, bg } = composite(el)
    const row = { surface: ${JSON.stringify(surface)}, control: name(el), fg: hex(fg), bg: hex(bg), ratio: ratio(fg, bg), probe }
    if (el.tagName === 'SELECT' && el.options.length > 0) {
      // The list is a page of its own, painted in the owner's used scheme, with
      // the owner's background over that page's Canvas.
      const scheme = getComputedStyle(el).colorScheme
      const own = parse(getComputedStyle(el).backgroundColor)
      const page = over(own, canvasOf(scheme))
      let worst = null
      for (const opt of el.options) {
        const s = getComputedStyle(opt)
        const obg = over(parse(s.backgroundColor), page)
        const ofg = over(parse(s.color), obg)
        const r = ratio(ofg, obg)
        if (!worst || r < worst.ratio) worst = { option: (opt.textContent || '').trim().slice(0, 40), fg: hex(ofg), bg: hex(obg), ratio: r, scheme }
      }
      row.list = worst
    }
    return row
  }

  const root = document.querySelector(${JSON.stringify(rootSel)})
  if (!root) return JSON.stringify({ error: 'no ' + ${JSON.stringify(rootSel)} })
  root.querySelectorAll('details').forEach((d) => { d.open = true })
  const TEXTLESS = /^(checkbox|radio|range|color|file|hidden|button|submit|reset|image)$/
  const fields = []
  for (const el of root.querySelectorAll('input, select, textarea')) {
    if (el.tagName === 'INPUT' && TEXTLESS.test(el.getAttribute('type') || 'text')) continue
    const box = el.getBoundingClientRect()
    if (box.width === 0 || box.height === 0 || getComputedStyle(el).visibility === 'hidden') continue
    fields.push(read(el, false))
  }

  // Placed and removed in one synchronous run, so React never sees them.
  const hosts = new Set(${JSON.stringify(probeHosts)}.map((sel) => document.querySelector(sel)).filter(Boolean))
  for (const host of hosts) {
    const where = host.classList.contains('glass-panel') ? 'unstyled probe on a glass panel' : 'unstyled probe'
    const probes = [document.createElement('input'), document.createElement('select'), document.createElement('textarea')]
    probes[1].appendChild(new Option('probe option'))
    for (const p of probes) {
      p.setAttribute('data-field-probe', where)
      host.appendChild(p)
      fields.push(read(p, true))
      p.remove()
    }
  }
  return JSON.stringify({ fields })
})()`

async function child(theme: Theme): Promise<void> {
  const profile = seedProfile(theme)
  app.setPath('userData', profile)
  const shots = process.env.FIELD_CONTRAST_SHOTS
  if (shots) mkdirSync(shots, { recursive: true })

  // Never on the user's screen; an unshown window still lays out.
  let win: BrowserWindow | null = null
  app.on('browser-window-created', (_e, created) => {
    win = created
    created.show = (): void => {}
    created.showInactive = (): void => {}
  })

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require(join(__dirname, '..', '..', 'out', 'main', 'index.js'))

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

  const evalIn = <T>(code: string): Promise<T> => wc.executeJavaScript(code) as Promise<T>
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /**
   * One real frame, then every finite animation finished. An unshown window
   * may get no frames at all, and the modal and each tab fade up from
   * opacity 0 — a reading taken mid-fade would composite ink that is still
   * arriving. `capturePage` forces the frame; `stayHidden` keeps the page's
   * visibility from changing under it.
   */
  const settle = async (): Promise<void> => {
    await wc.capturePage(undefined, { stayHidden: true })
    await evalIn<number>(
      `document.getAnimations().filter((a) => { const t = a.effect && a.effect.getTiming(); return t && t.iterations !== Infinity }).forEach((a) => a.finish()), 1`
    )
    await wc.capturePage(undefined, { stayHidden: true })
  }

  const waitFor = async (selector: string, ms = 4000): Promise<boolean> => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await evalIn<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`)) return true
      await wait(100)
    }
    return false
  }

  const shoot = async (name: string, scrollSel: string): Promise<void> => {
    if (!shots) return
    const pages = await evalIn<number>(`(() => {
      const s = document.querySelector(${JSON.stringify(scrollSel)})
      return s ? Math.min(6, Math.ceil(s.scrollHeight / Math.max(1, s.clientHeight))) : 1
    })()`)
    for (let i = 0; i < pages; i++) {
      await evalIn<number>(`(() => { const s = document.querySelector(${JSON.stringify(scrollSel)}); if (s) s.scrollTop = s.clientHeight * ${i}; return 1 })()`)
      await settle()
      const img = await wc.capturePage(undefined, { stayHidden: true })
      writeFileSync(join(shots, `${theme}-${name.toLowerCase().replace(/\W+/g, '-')}-${i + 1}.png`), img.toPNG())
    }
    await evalIn<number>(`(() => { const s = document.querySelector(${JSON.stringify(scrollSel)}); if (s) s.scrollTop = 0; return 1 })()`)
  }

  const readFields = async (surface: string, rootSel: string, probeHosts: string[]): Promise<FieldReading[]> => {
    const out = JSON.parse(await evalIn<string>(READ_FIELDS(surface, rootSel, probeHosts))) as {
      fields?: FieldReading[]
      error?: string
    }
    if (out.error) throw new Error(`${surface}: ${out.error}`)
    return out.fields ?? []
  }

  const fields: FieldReading[] = []
  const read: string[] = []
  const seeded: Record<string, boolean> = {}
  const note = async (): Promise<void> => {
    for (const [what, sel] of Object.entries(SEEDED)) {
      if (!seeded[what]) seeded[what] = await evalIn<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`)
    }
  }

  // --- Settings, every tab ---------------------------------------------------
  // The two surfaces a settings field sits on: the tab body, and a glass panel
  // inside it (Jobs' and MCP's "Add" forms, among others).
  const TAB_SURFACES = ['.tab-face', '.tab-face .glass-panel']
  await evalIn<boolean>(`(() => { const b = document.querySelector('[title^="Settings"]'); if (b) b.click(); return !!b })()`)
  if (!(await waitFor('.tab-face'))) throw new Error('Settings did not open')
  await settle()

  // The rail is whatever sits beside the keyed tab body — read, not listed here.
  const tabs = await evalIn<string[]>(`(() => {
    const face = document.querySelector('.tab-face')
    const rail = face && face.previousElementSibling
    return rail ? Array.from(rail.querySelectorAll('button')).map((b) => (b.innerText || '').trim()) : []
  })()`)

  for (const tab of tabs) {
    await evalIn<boolean>(`(() => {
      const rail = document.querySelector('.tab-face').previousElementSibling
      const b = Array.from(rail.querySelectorAll('button')).find((x) => (x.innerText || '').trim() === ${JSON.stringify(tab)})
      if (b) b.click()
      return !!b
    })()`)
    await wait(350)
    // The self-fetching tabs list their rows after an IPC round trip.
    if (tab === 'Jobs') await waitFor(SEEDED['a job row’s interval'])
    if (tab === 'MCP') await waitFor(SEEDED['an MCP server row’s approval'])
    await settle()
    const surface = `Settings → ${tab}`
    fields.push(...(await readFields(surface, '.tab-face', TAB_SURFACES)))
    await note()
    await shoot(tab, '.tab-face')
    read.push(surface)
  }

  // Leave without saving: Cancel, then the discard prompt if one appears.
  for (let i = 0; i < 4 && (await evalIn<boolean>(`!!document.querySelector('.tab-face')`)); i++) {
    await evalIn<number>(`(() => {
      const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((x) => /^(Cancel|Discard)/.test((x.innerText || '').trim()))
      if (b) b.click()
      return 1
    })()`)
    await wait(400)
  }

  // --- the Project modal -------------------------------------------------------
  // Through the palette, the route a keyboard user has (see modalFocusCheck).
  wc.focus()
  const press = async (key: string, modifiers: string[] = []): Promise<void> => {
    wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers } as never)
    if (key === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: '\r' } as never)
    wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers } as never)
    await wait(40)
  }
  await press('k', [process.platform === 'darwin' ? 'meta' : 'control'])
  await wait(400)
  for (const ch of 'Project Settings') {
    wc.sendInputEvent({ type: 'char', keyCode: ch } as never)
    await wait(12)
  }
  await wait(200)
  await press('Enter')
  if (await waitFor('[role="dialog"] textarea')) {
    await settle()
    fields.push(...(await readFields('Project modal', '[role="dialog"]', ['[role="dialog"]'])))
    await shoot('Project modal', '[role="dialog"]')
    read.push('Project modal')
  }

  const reading: Reading = { theme, tabs, read, fields, seeded }
  console.log(`FIELD_CONTRAST_RESULT ${JSON.stringify(reading)}`)
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* a leftover temp profile is not worth failing a run over */
  }
  app.exit(0)
}

// ---------------------------------------------------------------------------
// Parent: one child per theme, then judge.
// ---------------------------------------------------------------------------

function runChild(theme: Theme): Promise<Reading> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--no-sandbox', __filename], {
      env: { ...process.env, FIELD_CONTRAST_THEME: theme },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()))
    proc.stderr.on('data', (d: Buffer) => (err += d.toString()))
    proc.on('exit', (code) => {
      const line = out.split(/\r?\n/).find((l) => l.startsWith('FIELD_CONTRAST_RESULT '))
      if (!line) {
        reject(new Error(`${theme} child produced no reading (exit ${String(code)})\n${out}\n${err}`))
        return
      }
      resolve(JSON.parse(line.slice('FIELD_CONTRAST_RESULT '.length)) as Reading)
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

async function parent(): Promise<void> {
  const readings = [await runChild('light'), await runChild('dark')]

  for (const r of readings) {
    console.log(`\n${r.theme}: ${r.fields.filter((f) => !f.probe).length} fields on ${r.read.length} surfaces`)
    for (const f of r.fields) {
      const list = f.list ? `  · list ${f.list.ratio}:1 (${f.list.fg} on ${f.list.bg}, ${f.list.scheme})` : ''
      console.log(`  ${String(f.ratio).padStart(6)}:1  ${f.fg} on ${f.bg}  ${f.surface} · ${f.control}${list}`)
    }
  }
  console.log('')

  for (const r of readings) {
    check(`${r.theme}: the Settings rail offered tabs`, r.tabs.length >= 10, `${r.tabs.length}: ${r.tabs.join(', ')}`)
    const unread = r.tabs.filter((t) => !r.read.includes(`Settings → ${t}`))
    check(`${r.theme}: every tab was opened and read`, unread.length === 0, `unread: ${unread.join(', ')}`)
    check(`${r.theme}: the Project modal was opened and read`, r.read.includes('Project modal'))
    for (const [what, seen] of Object.entries(r.seeded)) {
      check(`${r.theme}: ${what} was on screen to be measured`, seen)
    }

    const shipped = r.fields.filter((f) => !f.probe)
    const low = shipped.filter((f) => f.ratio < FLOOR)
    check(
      `${r.theme}: every field's text clears ${FLOOR}:1 on the surface it sits on`,
      low.length === 0,
      low.map((f) => `${f.surface} · ${f.control} ${f.ratio}:1 (${f.fg} on ${f.bg})`).join('; ')
    )
    const lowList = shipped.filter((f) => f.list && f.list.ratio < FLOOR)
    check(
      `${r.theme}: every select's options clear ${FLOOR}:1 in the list it opens`,
      lowList.length === 0,
      lowList.map((f) => `${f.surface} · ${f.control} "${f.list?.option}" ${f.list?.ratio}:1 (${f.list?.fg} on ${f.list?.bg}, ${f.list?.scheme})`).join('; ')
    )

    const probes = r.fields.filter((f) => f.probe)
    const lowProbe = probes.filter((f) => f.ratio < FLOOR || (f.list && f.list.ratio < FLOOR))
    check(
      `${r.theme}: a field with no classes at all is legible on every surface`,
      probes.length > 0 && lowProbe.length === 0,
      probes.length === 0
        ? 'no probe was read'
        : lowProbe.map((f) => `${f.surface} · ${f.control} ${f.ratio}:1 (${f.fg} on ${f.bg})${f.list ? ` list ${f.list.ratio}:1` : ''}`).join('; ')
    )
  }

  console.log(`\n${'='.repeat(58)}`)
  if (failures.length === 0) {
    console.log(`ALL ${passed} FIELD-CONTRAST CHECKS PASSED`)
    app.exit(0)
  } else {
    console.log(`${passed} passed, ${failures.length} FAILED:`)
    for (const f of failures) console.log(`  - ${f}`)
    app.exit(1)
  }
}

const THEME = process.env.FIELD_CONTRAST_THEME as Theme | undefined
if (THEME) {
  child(THEME).catch((err) => {
    console.error('FIELD-CONTRAST CHILD ERROR:', err)
    app.exit(1)
  })
} else {
  app.whenReady().then(() =>
    parent().catch((err) => {
      console.error('FIELD-CONTRAST CHECK ERROR:', err)
      app.exit(1)
    })
  )
}
