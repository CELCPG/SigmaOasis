/**
 * Focus containment for modal surfaces, measured against the app itself.
 *
 * Round 8's bench walked 70 Tab stops and reported `obscured: true` on 24 of 70
 * on one route and 30 of 70 on another — in both arms, in both themes. Those
 * stops are the page's own controls sitting behind an open overlay: focusable,
 * inside the viewport, drawing a focus ring, and impossible to click. A ring on
 * a control the user cannot activate is worse than no ring, because it says
 * they are somewhere they are not.
 *
 * Why this check boots the real app rather than a fixture. `tabTraverseCheck`
 * proves the *instrument* — that a Tab press moves focus, that `obscured` can
 * see a scrim — against a page written to have the defect. It cannot prove the
 * *product*, because its page is not the product. Whether the app's overlays
 * contain focus is a property of the app's real component tree, its real class
 * strings and its real layout, so this check runs the shipped `out/main` with a
 * throwaway profile and drives it with real key events.
 *
 * What is measured, and why each part is here:
 *
 *   - With an overlay open: every Tab stop must be on the overlay, and none may
 *     be obscured. Counting only `obscured` would pass a build that moved the
 *     background controls out from under the panel instead of out of the tab
 *     order — still reachable, still useless. Counting only the surface would
 *     pass a build whose overlay covers its own controls.
 *   - With no overlay open: nothing may be inert and every focusable control
 *     must still be reachable. This is the true negative the containment could
 *     otherwise buy its numbers with — a build that inerts the page and forgets
 *     to stop scores a perfect zero on the line above.
 *   - Escape must close, and focus must come back to the control that opened
 *     the overlay. A trap the user cannot leave is a worse bug than the one
 *     being fixed, and focus dumped on `<body>` after a close restarts the
 *     walk from the top of the document.
 *   - The overlay must name itself to a screen reader (`role="dialog"`,
 *     `aria-modal`, an accessible name) and focus must land inside it when it
 *     opens. Containment with no announcement moves a blind user's focus
 *     somewhere they were not told about.
 *
 * Every overlay is measured, not the one the bench happened to walk. The set is
 * taken from the same predicate the traversal instrument uses to decide what an
 * overlay *is* (`fixed inset-0` + `z-50`), so this check cannot be narrower
 * than the thing it guards — see `modalSurfaceCheck` in overlayInventory.
 *
 * Two themes, because the bench reported identical counts in both and a fix
 * that held in only one would be a coincidence. Two routes, because the number
 * of background controls depends on what is on screen behind the panel.
 *
 * Run through scripts/test-render.sh (Electron proper, not ELECTRON_RUN_AS_NODE).
 */
import { app, BrowserWindow } from 'electron'
import { spawn } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TAB_BASELINE, tabStop } from '../scripts/h2h-traversal'
import type { TabStopRow } from '../scripts/h2h-traversal'

/** The bench's walk length, kept so the counts are comparable with its report. */
const WALK = 70

type Theme = 'light' | 'dark'

interface ClosedReading {
  stops: number
  obscured: number
  inert: number
  /** Focusable controls the walk never reached. Empty is the requirement. */
  missed: string[]
  reachable: number
  focusable: number
}

interface OverlayReading {
  overlay: string
  opened: boolean
  /** Focus landed inside the overlay when it opened. */
  focusInside: boolean
  focusLanded: string
  /** role="dialog" + aria-modal="true" + a non-empty accessible name. */
  announced: boolean
  announcedDetail: string
  inert: number
  stops: number
  obscured: number
  pageStops: number
  overlayStops: number
  obscuredBy: string[]
  escapeClosed: boolean
  focusReturned: boolean
  openerLabel: string
  returnedTo: string
  inertAfterClose: number
}

interface RouteReading {
  theme: Theme
  route: string
  closed: ClosedReading
  overlays: OverlayReading[]
}

/**
 * The overlays, and how a person opens each one. Every entry is driven through
 * a control the app actually renders — a click on the gear, ⌘K, the palette's
 * own "Setup Checklist" row — so an overlay that became unreachable would fail
 * here rather than be measured through a back door into the store.
 */
const OVERLAYS: {
  name: string
  /** Clicked (or typed) to open it. `null` means the driver types instead. */
  openBy: { kind: 'click'; titlePrefix: string } | { kind: 'palette'; command: string } | { kind: 'key'; key: string }
}[] = [
  { name: 'SettingsModal', openBy: { kind: 'click', titlePrefix: 'Settings' } },
  // Through the palette, not the sidebar's ⚙: that button sits in a
  // `hidden … group-hover/project:flex` span, so it is `display: none` until
  // the mouse is over the row — it cannot take focus and Tab never reaches it.
  // Driving it by click would measure a route no keyboard user has, and record
  // "focus returned to nothing" as a containment failure. The mouse-only
  // control is a real defect; it is not this one, and it is reported as found.
  { name: 'ProjectModal', openBy: { kind: 'palette', command: 'Project Settings' } },
  { name: 'CommandPalette', openBy: { kind: 'key', key: 'k' } },
  { name: 'OnboardingModal', openBy: { kind: 'palette', command: 'Setup' } }
]

// ---------------------------------------------------------------------------
// Child: boot the real app on a seeded throwaway profile and take the readings.
// ---------------------------------------------------------------------------

/** A profile with one project and two conversations, seeded for one theme. */
function seedProfile(theme: Theme): string {
  const profile = mkdtempSync(join(tmpdir(), 'sigma-modal-focus-'))
  const settings = {
    // A port nothing is listening on: the app must come up offline rather than
    // reach a model. Nothing here depends on a reply.
    baseUrl: 'http://127.0.0.1:65533/v1',
    onboardingCompleted: true,
    theme,
    updates: { autoCheck: false },
    audit: { enabled: false, autoPurgeOnQuit: false },
    memory: { autoContext: false, topK: 3, embeddingModel: '' },
    claimCheck: { enabled: false, maxClaims: 5 },
    secondOpinion: { enabled: false, criticSlotId: null },
    grounding: { autoCorrect: false, playbooks: false, selfReview: false, workbenchChecks: false, ledger: false },
    projects: [
      {
        id: 'proj-1',
        name: 'Field notes',
        color: 'blue',
        instructions: '',
        createdAt: Date.now() - 100_000,
        files: [],
        defaults: {}
      }
    ]
  }
  writeFileSync(join(profile, 'config.json'), JSON.stringify({ settings }, null, 2))

  const dir = join(profile, 'conversations')
  mkdirSync(dir, { recursive: true })
  const now = Date.now()

  /** A reply that used a tool: the background grows a tool-call block. */
  const search = {
    id: 'route-search',
    title: 'Route · search',
    mode: 'independent',
    activeModelSlotId: 'model-1',
    projectId: 'proj-1',
    messages: [
      { id: 'u0', role: 'user', content: 'What is the tallest building in Europe?', createdAt: now - 120_000 },
      {
        id: 'a0',
        role: 'assistant',
        modelId: 'bench-model',
        roleName: 'Assistant',
        color: 'blue',
        toolCalls: [
          {
            id: 't0',
            name: 'web_search',
            args: { query: 'tallest building in Europe' },
            status: 'done',
            result: 'Lakhta Center, Saint Petersburg — 462 m.'
          }
        ],
        content: 'The tallest building in Europe is the Lakhta Center in Saint Petersburg, at 462 m [1].',
        createdAt: now - 90_000
      }
    ],
    createdAt: now - 150_000,
    updatedAt: now - 90_000
  }

  /** Two replies, so the background carries two action rows rather than one. */
  const roles = {
    id: 'route-roles',
    title: 'Route · roles',
    mode: 'independent',
    activeModelSlotId: 'model-1',
    messages: [
      { id: 'u0', role: 'user', content: 'Explain a write-ahead log.', createdAt: now - 60_000 },
      {
        id: 'a0',
        role: 'assistant',
        modelId: 'bench-model',
        roleName: 'Assistant',
        color: 'blue',
        toolCalls: [],
        content: 'A write-ahead log records an intended change before applying it.',
        createdAt: now - 50_000
      },
      { id: 'u1', role: 'user', content: 'And what does that buy?', createdAt: now - 40_000 },
      {
        id: 'a1',
        role: 'assistant',
        modelId: 'bench-model',
        roleName: 'Assistant',
        color: 'blue',
        toolCalls: [],
        content: 'Recovery: on restart the log says what was meant to happen, so a half-applied change can be finished or undone.',
        createdAt: now - 30_000
      }
    ],
    createdAt: now - 70_000,
    updatedAt: now - 30_000
  }

  writeFileSync(join(dir, 'route-search.json'), JSON.stringify(search))
  writeFileSync(join(dir, 'route-roles.json'), JSON.stringify(roles))
  return profile
}

async function child(theme: Theme): Promise<void> {
  const profile = seedProfile(theme)
  app.setPath('userData', profile)

  // The app shows its window on `ready-to-show`. A test suite must not throw a
  // window on the user's screen, and an offscreen window still lays out — which
  // is everything this check reads.
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
  // The renderer boots asynchronously: settings, then conversations.
  await new Promise((r) => setTimeout(r, 2500))
  wc.focus()

  const evalIn = <T>(code: string): Promise<T> => wc.executeJavaScript(code) as Promise<T>
  const json = async <T>(code: string): Promise<T> => JSON.parse(await evalIn<string>(code)) as T

  const press = async (key: string, modifiers: string[] = []): Promise<void> => {
    wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers } as never)
    if (key === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: '\r' } as never)
    wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers } as never)
    await new Promise((r) => setTimeout(r, 35))
  }

  const type = async (text: string): Promise<void> => {
    for (const ch of text) {
      wc.sendInputEvent({ type: 'char', keyCode: ch } as never)
      await new Promise((r) => setTimeout(r, 12))
    }
    await new Promise((r) => setTimeout(r, 150))
  }

  const walk = async (n: number): Promise<TabStopRow[]> => {
    await json<unknown>(TAB_BASELINE)
    const rows: TabStopRow[] = []
    for (let i = 0; i < n; i++) {
      await press('Tab')
      rows.push(await json<TabStopRow>(tabStop(rows.length + 1)))
    }
    // TAB_BASELINE borrows a tabindex on <body>; give it back.
    await evalIn<unknown>(
      `(() => { var T = window.__h2hTab; if (T && !T.hadTabIndex) document.body.removeAttribute('tabindex'); return 1 })()`
    )
    return rows
  }

  const inertCount = (): Promise<number> =>
    evalIn<number>(`document.querySelectorAll('[inert]').length`)

  const describeActive = (): Promise<string> =>
    evalIn<string>(`(() => {
      var el = document.activeElement
      if (!el || el === document.body) return 'body'
      var label = (el.getAttribute('aria-label') || el.getAttribute('title') || (el.innerText || '').trim()).slice(0, 60)
      return el.tagName.toLowerCase() + (label ? ' · ' + label : '')
    })()`)

  const overlayOpen = (): Promise<boolean> =>
    evalIn<boolean>(`!!document.querySelector('.fixed.inset-0.z-50')`)

  /** Whether the open overlay announces itself as a modal dialog with a name. */
  const announcement = (): Promise<{ ok: boolean; detail: string }> =>
    json<{ ok: boolean; detail: string }>(`(() => {
      var root = document.querySelector('.fixed.inset-0.z-50')
      if (!root) return JSON.stringify({ ok: false, detail: 'no overlay' })
      var d = root.querySelector('[role="dialog"]') || (root.getAttribute('role') === 'dialog' ? root : null)
      if (!d) return JSON.stringify({ ok: false, detail: 'no role="dialog"' })
      var modal = d.getAttribute('aria-modal') === 'true'
      var name = d.getAttribute('aria-label') || ''
      if (!name) {
        var by = d.getAttribute('aria-labelledby')
        var t = by ? document.getElementById(by) : null
        name = t ? (t.innerText || '').trim() : ''
      }
      return JSON.stringify({
        ok: modal && name.length > 0,
        detail: 'aria-modal=' + String(modal) + ' name=' + JSON.stringify(name)
      })
    })()`)

  const selectRoute = async (id: string): Promise<void> => {
    await evalIn<unknown>(`(() => {
      var rows = Array.prototype.slice.call(document.querySelectorAll('button, [role="button"]'))
      var hit = rows.filter(function (b) { return (b.innerText || '').indexOf(${JSON.stringify(id)}) !== -1 })[0]
      if (hit) hit.click()
      return !!hit
    })()`)
    await new Promise((r) => setTimeout(r, 500))
  }

  const closeAny = async (): Promise<void> => {
    for (let i = 0; i < 6 && (await overlayOpen()); i++) {
      await press('Escape')
      await new Promise((r) => setTimeout(r, 260))
      if (await overlayOpen()) {
        // Escape did not close it; fall back so the next reading is not taken
        // through a stale panel. The Escape failure is recorded by the caller.
        await evalIn<unknown>(`(() => {
          var r = document.querySelector('.fixed.inset-0.z-50')
          if (r) r.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          return 1
        })()`)
        await new Promise((r) => setTimeout(r, 300))
      }
    }
    await evalIn<unknown>(`(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return 1 })()`)
  }

  const readings: RouteReading[] = []

  for (const route of [
    { id: 'Route · search', name: 'search' },
    { id: 'Route · roles', name: 'roles' }
  ]) {
    await selectRoute(route.id)
    await closeAny()

    // --- closed: the true negative -----------------------------------------
    const closedRows = await walk(WALK)
    const closedInert = await inertCount()
    const reach = await json<{ focusable: number; missed: string[] }>(`(() => {
      var seen = ${JSON.stringify(closedRows.map((r) => `${r.tag}|${String(r.label)}`))}
      var all = Array.prototype.slice.call(
        document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')
      ).filter(function (el) {
        if (el.disabled) return false
        if (el.getAttribute('tabindex') === '-1') return false
        var r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      })
      var missed = []
      for (var i = 0; i < all.length; i++) {
        var el = all[i]
        var label = (el.getAttribute('aria-label') || el.getAttribute('title') || (el.innerText || '').trim()).slice(0, 80)
        if (seen.indexOf(el.tagName.toLowerCase() + '|' + label) === -1) {
          missed.push(el.tagName.toLowerCase() + ' · ' + label)
        }
      }
      return JSON.stringify({ focusable: all.length, missed: missed })
    })()`)

    const closed: ClosedReading = {
      stops: closedRows.filter((r) => r.tag !== null).length,
      obscured: closedRows.filter((r) => r.obscured === true).length,
      inert: closedInert,
      missed: reach.missed,
      reachable: reach.focusable - reach.missed.length,
      focusable: reach.focusable
    }

    // --- each overlay: the true positive ------------------------------------
    const overlays: OverlayReading[] = []
    for (const spec of OVERLAYS) {
      await closeAny()
      // Park focus somewhere real, so "focus came back" is a claim about a
      // control rather than about <body>.
      const openerLabel = await (async (): Promise<string> => {
        if (spec.openBy.kind === 'click') {
          const prefix = spec.openBy.titlePrefix
          await evalIn<unknown>(`(() => {
            var b = document.querySelector('[title^=' + ${JSON.stringify(JSON.stringify(prefix))} + ']')
            if (b) { b.focus(); b.click() }
            return !!b
          })()`)
          await new Promise((r) => setTimeout(r, 450))
          return prefix
        }
        if (spec.openBy.kind === 'key') {
          await evalIn<unknown>(`(() => {
            var b = document.querySelector('[title^="Settings"]')
            if (b) b.focus()
            return 1
          })()`)
          await press(spec.openBy.key, ['meta'])
          await new Promise((r) => setTimeout(r, 450))
          return 'Settings'
        }
        // Through the palette: open it, type, Enter. The palette closes itself.
        await evalIn<unknown>(`(() => {
          var b = document.querySelector('[title^="Settings"]')
          if (b) b.focus()
          return 1
        })()`)
        await press('k', ['meta'])
        await new Promise((r) => setTimeout(r, 400))
        await type(spec.openBy.command)
        await press('Enter')
        await new Promise((r) => setTimeout(r, 500))
        return 'Settings'
      })()

      const opened = await overlayOpen()
      const focusLanded = await describeActive()
      const focusInside = await evalIn<boolean>(`(() => {
        var r = document.querySelector('.fixed.inset-0.z-50')
        return !!(r && document.activeElement && r.contains(document.activeElement))
      })()`)
      const ann = await announcement()
      const openInert = await inertCount()

      const rows = opened ? await walk(WALK) : []
      const obscuredRows = rows.filter((r) => r.obscured === true)

      // Escape, and where focus goes.
      await press('Escape')
      await new Promise((r) => setTimeout(r, 320))
      const stillOpen = await overlayOpen()
      const returnedTo = await describeActive()
      const afterClose = await inertCount()

      overlays.push({
        overlay: spec.name,
        opened,
        focusInside,
        focusLanded,
        announced: ann.ok,
        announcedDetail: ann.detail,
        inert: openInert,
        stops: rows.filter((r) => r.tag !== null).length,
        obscured: obscuredRows.length,
        pageStops: rows.filter((r) => r.surface === 'page').length,
        overlayStops: rows.filter((r) => r.surface === 'overlay').length,
        obscuredBy: Array.from(new Set(obscuredRows.map((r) => String(r.obscuredBy)))).slice(0, 5),
        escapeClosed: opened && !stillOpen,
        focusReturned: returnedTo.includes(openerLabel),
        openerLabel,
        returnedTo,
        inertAfterClose: afterClose
      })
      await closeAny()
    }

    readings.push({ theme, route: route.name, closed, overlays })
  }

  console.log(`MODAL_FOCUS_RESULT ${JSON.stringify(readings)}`)
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* a leftover temp profile is not worth failing a run over */
  }
  app.exit(0)
}

// ---------------------------------------------------------------------------
// Parent: run one child per theme, then judge the readings.
// ---------------------------------------------------------------------------

function runChild(theme: Theme): Promise<RouteReading[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--no-sandbox', __filename], {
      env: { ...process.env, MODAL_FOCUS_THEME: theme },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()))
    proc.stderr.on('data', (d: Buffer) => (err += d.toString()))
    proc.on('exit', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('MODAL_FOCUS_RESULT '))
      if (!line) {
        reject(new Error(`${theme} child produced no reading (exit ${String(code)})\n${out}\n${err}`))
        return
      }
      resolve(JSON.parse(line.slice('MODAL_FOCUS_RESULT '.length)) as RouteReading[])
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
  const readings = [...(await runChild('light')), ...(await runChild('dark'))]
  check('both themes and both routes produced readings', readings.length === 4, `${readings.length} readings`)

  console.log('\nobscured stops, per route and per theme')
  for (const r of readings) {
    const worst = r.overlays.map((o) => `${o.overlay}:${o.obscured}`).join(' ')
    console.log(
      `  ${r.theme}/${r.route}: closed ${r.closed.obscured}/${r.closed.stops} obscured · open → ${worst}`
    )
  }

  console.log('\nwith no overlay open — nothing is contained, nothing is lost')
  for (const r of readings) {
    const where = `${r.theme}/${r.route}`
    check(`${where}: no element is inert`, r.closed.inert === 0, `${r.closed.inert} inert`)
    check(`${where}: no stop is obscured`, r.closed.obscured === 0, `${r.closed.obscured} of ${r.closed.stops}`)
    check(
      `${where}: every focusable control is still reached`,
      r.closed.missed.length === 0,
      `missed ${JSON.stringify(r.closed.missed)}`
    )
    check(`${where}: the walk found controls at all`, r.closed.stops >= 20, `${r.closed.stops} stops`)
  }

  console.log('\nwith an overlay open — the walk stays on it')
  for (const r of readings) {
    for (const o of r.overlays) {
      const where = `${r.theme}/${r.route}/${o.overlay}`
      check(`${where}: opened`, o.opened, 'the driver could not open it')
      if (!o.opened) continue
      check(`${where}: the background is inert`, o.inert > 0, `${o.inert} inert elements`)
      check(
        `${where}: no stop is obscured`,
        o.obscured === 0,
        `${o.obscured} of ${o.stops} — behind ${JSON.stringify(o.obscuredBy)}`
      )
      check(
        `${where}: no stop is on the page behind it`,
        o.pageStops === 0,
        `${o.pageStops} of ${o.stops} stops were on the page`
      )
      check(`${where}: the walk stays on the overlay`, o.overlayStops >= 2, `${o.overlayStops} overlay stops`)
      check(`${where}: focus moved into it when it opened`, o.focusInside, `focus landed on ${o.focusLanded}`)
      check(`${where}: it announces itself as a named modal dialog`, o.announced, o.announcedDetail)
      check(`${where}: Escape closes it`, o.escapeClosed, 'Escape left it open')
      check(
        `${where}: closing gives focus back to what opened it`,
        o.focusReturned,
        `focus went to ${JSON.stringify(o.returnedTo)}, expected ${JSON.stringify(o.openerLabel)}`
      )
      check(`${where}: nothing stays inert after it closes`, o.inertAfterClose === 0, `${o.inertAfterClose} left inert`)
    }
  }

  console.log(`\n${'='.repeat(58)}`)
  if (failures.length === 0) {
    console.log(`ALL ${passed} MODAL-FOCUS CHECKS PASSED`)
    app.exit(0)
  } else {
    console.log(`${passed} passed, ${failures.length} FAILED:`)
    for (const f of failures) console.log(`  - ${f}`)
    app.exit(1)
  }
}

const THEME = process.env.MODAL_FOCUS_THEME as Theme | undefined
if (THEME) {
  child(THEME).catch((err) => {
    console.error('MODAL-FOCUS CHILD ERROR:', err)
    app.exit(1)
  })
} else {
  app.whenReady().then(() =>
    parent().catch((err) => {
      console.error('MODAL-FOCUS CHECK ERROR:', err)
      app.exit(1)
    })
  )
}
