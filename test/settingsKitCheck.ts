/**
 * Every Settings control is the kit's — measured on the shipped build (v4.0).
 *
 * Fourteen tabs held five kinds of checkbox, four label sizes, four button
 * paddings and three status palettes, because each tab wrote its own
 * controls. The kit (components/settings/kit/) is one control per job, and
 * this check is what keeps it that way: it boots `out/main` on a throwaway
 * profile, opens Settings, walks every tab in the rail, opens every fold, and
 * refuses
 *
 *   - a bare `<input type=checkbox>` or `<input type=radio>` — a boolean is a
 *     Switch, a choice is a Segmented;
 *   - a button, field, select, textarea or range with no `data-kit` — every
 *     kit control carries one, so a control without it was written by hand;
 *   - a button with no text and no `aria-label`;
 *   - a control outside a Row (`[data-row]`), or a Row with no help
 *     (`[data-help]`) — every setting says what it does, in the row, not in a
 *     tooltip;
 *   - a label at any size but the kit's one (text-sm, read against the root
 *     size the font-size setting scales), and a status dot in any palette but
 *     the kit's (a raw `bg-green-500` and its kin);
 *   - a control in a row that the Tab key, pressed for real from the tab's
 *     first control, never reaches (S6.2).
 *
 * Why the app and not a fixture: which controls each tab draws is the
 * component tree, and a copy of it would keep passing after the tree changed.
 * The same driver fieldContrastCheck uses: seeded rows so the list tabs have
 * something to draw, the rail read rather than listed.
 *
 * Run through scripts/test-render.sh (Electron proper, not ELECTRON_RUN_AS_NODE).
 */
import { app, BrowserWindow } from 'electron'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

interface Offence {
  tab: string
  rule: string
  what: string
}

interface Reading {
  tabs: string[]
  read: string[]
  offences: Offence[]
  /** Controls counted per tab, so a tab that drew nothing cannot pass by being empty. */
  counted: Record<string, number>
}

const RAW_DOT = /\b(bg|text)-(green|emerald|red|amber|neutral|gray|sky|blue)-\d{3}\b/

function seedProfile(): string {
  const profile = mkdtempSync(join(tmpdir(), 'sigma-settings-kit-'))
  const now = Date.now()
  const settings = {
    baseUrl: 'http://127.0.0.1:65533/v1',
    // 4.6 (J1): the agent connection on, so its card draws every control it has (switch, address, model, Test); nothing listens there.
    agentConnection: { enabled: true, baseUrl: 'http://127.0.0.1:65532/v1', model: 'qwen3.8-35b-a3b' },
    onboardingCompleted: true,
    theme: 'dark',
    updates: { autoCheck: false },
    audit: { enabled: false, autoPurgeOnQuit: false },
    mcp: {
      servers: [{ id: 'fs', name: 'Filesystem', command: 'npx', args: [], env: {}, enabled: false, disabledTools: [], approval: 'ask' }]
    },
    projects: [{ id: 'proj-1', name: 'Field notes', color: 'blue', instructions: '', createdAt: now - 100_000, files: [], defaults: {} }]
  }
  writeFileSync(join(profile, 'config.json'), JSON.stringify({ settings }, null, 2))
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
  writeFileSync(join(profile, 'watchlist.json'), JSON.stringify([{ url: 'https://example.com/kettle', name: 'Kettle', addedAt: now - 40_000, history: [] }]))
  return profile
}

/** Runs in the page: every offence on the open tab, as JSON. */
const READ_TAB = (tab: string): string => `(() => {
  const face = document.querySelector('.tab-face')
  if (!face) return JSON.stringify({ error: 'no .tab-face' })
  face.querySelectorAll('details').forEach((d) => { d.open = true })
  const offences = []
  const say = (rule, el, extra) => {
    const text = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.className || el.tagName).replace(/\\s+/g, ' ').trim().slice(0, 70)
    offences.push({ tab: ${JSON.stringify(tab)}, rule, what: (extra ? extra + ' · ' : '') + text })
  }
  const visible = (el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 }
  let counted = 0

  for (const el of face.querySelectorAll('input[type="checkbox"], input[type="radio"]')) say('a bare checkbox or radio', el)

  for (const el of face.querySelectorAll('button')) {
    if (!visible(el)) continue
    counted += 1
    if (!el.hasAttribute('data-kit')) say('a button not from the kit', el)
    const by = el.getAttribute('aria-labelledby')
    const named = (el.getAttribute('aria-label') || '').trim() || (el.innerText || '').trim() || (by && document.getElementById(by) && (document.getElementById(by).innerText || '').trim())
    if (!named) say('a button with no name', el, el.outerHTML.slice(0, 60))
  }
  for (const el of face.querySelectorAll('input, select, textarea')) {
    if (!visible(el)) continue
    const type = el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text') : el.tagName.toLowerCase()
    if (type === 'checkbox' || type === 'radio') continue
    counted += 1
    if (!el.hasAttribute('data-kit')) say('a control not from the kit', el, type)
    // A Row, or a list row (a Card, a DangerRow) whose controls are named by the row itself.
    if (!el.closest('[data-row], [data-list-row]')) say('a control outside a Row', el, type)
  }
  for (const el of face.querySelectorAll('[role="switch"], [role="radiogroup"]')) {
    if (!el.closest('[data-row], [data-list-row]')) say('a control outside a Row', el, el.getAttribute('role'))
  }
  // The kit's one label size is text-sm, 0.875rem: read against the root, which the font-size setting scales.
  const labelPx = parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.875
  for (const row of face.querySelectorAll('[data-row]')) {
    // A bare row holds cards its section already describes; a labelled row must say what it does.
    if (!row.hasAttribute('data-bare') && !row.querySelector('[data-help]')) say('a Row with no help', row, row.getAttribute('data-row'))
    const label = row.querySelector('[id$="-label"]')
    if (label) {
      const size = parseFloat(getComputedStyle(label).fontSize)
      if (Math.abs(size - labelPx) > 0.5) say('a label at the wrong size', label, size + 'px, expected ' + labelPx.toFixed(2) + 'px')
    }
  }
  for (const el of face.querySelectorAll('*')) {
    if (el.hasAttribute('data-accent-dot')) continue // a role's colour is a label, not a status
    const cls = typeof el.className === 'string' ? el.className : ''
    if (cls.includes('rounded-full') && ${RAW_DOT.toString()}.test(cls)) say('a status dot outside the kit palette', el, cls.match(${RAW_DOT.toString()})[0])
  }
  return JSON.stringify({ offences, counted })
})()`

async function child(): Promise<void> {
  const profile = seedProfile()
  app.setPath('userData', profile)
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
  const settle = async (): Promise<void> => {
    await wc.capturePage(undefined, { stayHidden: true })
    await evalIn<number>(`document.getAnimations().filter((a) => { const t = a.effect && a.effect.getTiming(); return t && t.iterations !== Infinity }).forEach((a) => a.finish()), 1`)
  }
  const waitUntil = async (expression: string, ms = 4000): Promise<boolean> => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await evalIn<boolean>(expression)) return true
      await wait(100)
    }
    return false
  }

  await evalIn<boolean>(`(() => { const b = document.querySelector('[title^="Settings"]'); if (b) b.click(); return !!b })()`)
  if (!(await waitUntil(`!!document.querySelector('.tab-face')`))) throw new Error('Settings did not open')
  await settle()

  const tabs = await evalIn<string[]>(`(() => {
    const rail = document.querySelector('[data-settings-rail]') || (document.querySelector('.tab-face') && document.querySelector('.tab-face').previousElementSibling)
    return rail ? Array.from(rail.querySelectorAll('button[data-tab]')).concat(Array.from(rail.querySelectorAll('button'))).filter((b, i, all) => all.indexOf(b) === i).map((b) => (b.innerText || '').trim()).filter(Boolean) : []
  })()`)

  const offences: Offence[] = []
  const counted: Record<string, number> = {}
  const read: string[] = []
  for (const tab of tabs) {
    await evalIn<boolean>(`(() => {
      const rail = document.querySelector('[data-settings-rail]') || document.querySelector('.tab-face').previousElementSibling
      const b = Array.from(rail.querySelectorAll('button')).find((x) => (x.innerText || '').trim() === ${JSON.stringify(tab)})
      if (b) b.click()
      return !!b
    })()`)
    await wait(350)
    if (tab === 'Jobs') await waitUntil(`!!document.querySelector('.tab-face select[aria-label$=" interval"], .tab-face [data-row]')`)
    if (tab === 'MCP') await waitUntil(`!!document.querySelector('.tab-face select[aria-label$=" approval"], .tab-face [data-row]')`)
    // Every fold open, so what is inside one is read too.
    await evalIn<number>(`(() => { document.querySelectorAll('.tab-face [data-kit="fold"][aria-expanded="false"]').forEach((b) => b.click()); return 1 })()`)
    await wait(300)
    await settle()
    const out = JSON.parse(await evalIn<string>(READ_TAB(tab))) as { offences?: Offence[]; counted?: number; error?: string }
    if (out.error) throw new Error(`${tab}: ${out.error}`)
    offences.push(...(out.offences ?? []))
    counted[tab] = out.counted ?? 0

    // The keyboard: from the tab body's first control, Tab must reach every
    // enabled control in every row — a control the key skips is one a
    // keyboard user cannot change. Real key events, so what is measured is
    // the tab order the page has, not the one the markup implies.
    const targets = await evalIn<number>(`(() => {
      const face = document.querySelector('.tab-face')
      const all = [...face.querySelectorAll('[data-row] button, [data-row] input, [data-row] select, [data-row] textarea, [data-row] [tabindex="0"], [data-list-row] button, [data-list-row] input, [data-list-row] select, [data-list-row] [tabindex="0"]')]
        .filter((el) => !el.disabled && el.getBoundingClientRect().width > 0 && el.tabIndex >= 0)
      all.forEach((el, i) => el.setAttribute('data-kbd', String(i)))
      const first = all[0]
      if (first) first.focus()
      return all.length
    })()`)
    const reached = new Set<number>()
    for (let i = 0; i < targets + 40 && reached.size < targets; i++) {
      const at = await evalIn<number>(`(() => { const a = document.activeElement; return a && a.hasAttribute('data-kbd') ? Number(a.getAttribute('data-kbd')) : -1 })()`)
      if (at >= 0) reached.add(at)
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' } as never)
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' } as never)
      await wait(15)
    }
    if (reached.size < targets) {
      const missed = await evalIn<string[]>(`[...document.querySelectorAll('[data-kbd]')].filter((el) => !${JSON.stringify([...reached])}.includes(Number(el.getAttribute('data-kbd')))).slice(0, 5).map((el) => (el.getAttribute('aria-label') || el.innerText || el.tagName).slice(0, 40))`)
      offences.push({ tab, rule: 'a control the Tab key does not reach', what: `${targets - reached.size} of ${targets}: ${missed.join(' · ')}` })
    }
    read.push(tab)
  }

  const reading: Reading = { tabs, read, offences, counted }
  console.log(`SETTINGS_KIT_RESULT ${JSON.stringify(reading)}`)
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* a leftover temp profile is not worth failing a run over */
  }
  app.exit(0)
}

// ---------------------------------------------------------------------------

function runChild(): Promise<Reading> {
  const { spawn } = require('child_process') as typeof import('child_process')
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--no-sandbox', __filename], {
      env: { ...process.env, SETTINGS_KIT_CHILD: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()))
    proc.stderr.on('data', (d: Buffer) => (err += d.toString()))
    proc.on('exit', (code) => {
      const line = out.split(/\r?\n/).find((l) => l.startsWith('SETTINGS_KIT_RESULT '))
      if (!line) {
        reject(new Error(`child produced no reading (exit ${String(code)})\n${out}\n${err}`))
        return
      }
      resolve(JSON.parse(line.slice('SETTINGS_KIT_RESULT '.length)) as Reading)
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
  const r = await runChild()
  console.log(`\n${r.read.length} tabs read: ${r.read.join(', ')}`)
  for (const o of r.offences) console.log(`  ${o.tab} · ${o.rule} · ${o.what}`)
  console.log('')

  check('the Settings rail offered tabs', r.tabs.length >= 10, `${r.tabs.length}: ${r.tabs.join(', ')}`)
  const unread = r.tabs.filter((t) => !r.read.includes(t))
  check('every tab was opened and read', unread.length === 0, `unread: ${unread.join(', ')}`)
  const empty = r.read.filter((t) => (r.counted[t] ?? 0) === 0)
  check('every tab drew at least one control to be measured', empty.length === 0, `empty: ${empty.join(', ')}`)
  const rules = Array.from(new Set(r.offences.map((o) => o.rule)))
  for (const rule of [
    'a bare checkbox or radio',
    'a button not from the kit',
    'a button with no name',
    'a control not from the kit',
    'a control outside a Row',
    'a Row with no help',
    'a label at the wrong size',
    'a status dot outside the kit palette',
    'a control the Tab key does not reach'
  ]) {
    const hits = r.offences.filter((o) => o.rule === rule)
    const tabsHit = Array.from(new Set(hits.map((o) => o.tab)))
    check(`no tab draws ${rule}`, hits.length === 0, `${hits.length} on ${tabsHit.join(', ')}`)
  }
  for (const rule of rules) {
    if (!failures.some((f) => f.includes(rule))) check(`no tab draws ${rule}`, false, 'an unlisted rule fired')
  }

  console.log(`\n${'='.repeat(58)}`)
  if (failures.length === 0) {
    console.log(`ALL ${passed} SETTINGS-KIT CHECKS PASSED`)
    app.exit(0)
  } else {
    console.log(`${failures.length} SETTINGS-KIT CHECK(S) FAILED:`)
    for (const f of failures) console.log(`  - ${f}`)
    app.exit(1)
  }
}

if (process.env.SETTINGS_KIT_CHILD) {
  child().catch((err) => {
    console.error(err)
    app.exit(1)
  })
} else {
  app.whenReady().then(() =>
    parent().catch((err) => {
      console.error(err)
      app.exit(1)
    })
  )
}
