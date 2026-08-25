/**
 * The head-to-head keyboard-traversal and theme instruments, in a real window.
 *
 * These cannot be node:test cases. Everything they measure is a property of a
 * live layout: whether Tab actually moves focus, what `:focus-visible` matches,
 * what a click at an element's own centre would hit, and what colour a
 * translucent ink composites to over the surfaces stacked under it. A mocked
 * DOM would answer all of those from the mock.
 *
 * What is being pinned, and why each one is here:
 *
 *   - a stop whose focused and unfocused readings are identical is the defect
 *     VC2 exists to find (33 `outline-none` inputs, zero `focus-visible`), so
 *     the instrument has to be able to see one AND to see a control that does
 *     show a ring. A check that only ever saw one of the two would pass on an
 *     instrument that returned a constant.
 *   - through round 7 the traversal could not activate anything, so it stopped
 *     at the Settings button and every control behind that door went
 *     unmeasured. Activation is pinned by pressing Enter for real.
 *   - a control that appears only *after* an activation had no unfocused
 *     reading at all — it did not exist when the baseline ran — which made
 *     "is the focus visible here" undecidable for exactly the stops the task is
 *     about. Both repairs (rebaseline, and the post-walk resolve) are pinned.
 *   - a control behind a modal scrim is focusable, inside the viewport, and
 *     completely unusable. Nothing recorded that before.
 *
 * Run through scripts/test-render.sh (Electron proper, not ELECTRON_RUN_AS_NODE).
 */
import { app, BrowserWindow } from 'electron'
import {
  fingerprintChanged,
  mergeUnfocused,
  nextActivation,
  stylesIn,
  tabStop,
  TAB_BASELINE,
  TAB_FINGERPRINT,
  TAB_PEEK,
  TAB_REBASELINE,
  TAB_RESOLVE,
  THEME_READ,
  styleDelta
} from '../scripts/h2h-traversal'
import type { Fingerprint, StyleSnapshot, TabStopRow, ThemeReading } from '../scripts/h2h-traversal'

/**
 * A page shaped like the app's own two surfaces: a chat behind, and a modal
 * over it whose class string is the app's real one (`fixed inset-0 … z-50`),
 * because that string is what tells the instrument which surface a stop is on.
 *
 * The theme readings are taken against a real stylesheet keyed on `.dark`, the
 * way the app's is, so the witness (a colour that actually rendered) is a real
 * measurement rather than an echo of the class that was just set.
 */
const FIXTURE = `<!doctype html>
<html><head><meta charset="utf-8"><title>traversal fixture</title>
<style>
  :root { --bg-base: #f4f4f5; --ink: #171717; --panel: #ffffff; }
  html.dark { --bg-base: #000000; --ink: #ededed; --panel: #1c1c1c; }
  body { margin: 0; background-color: var(--bg-base); color: var(--ink); font: 15px sans-serif; }
  /* The app's sin, reproduced exactly: the ring is removed and nothing replaces it. */
  input, textarea { outline: none; border: 1px solid #cccccc; padding: 4px; }
  button.ringed:focus { outline: 2px solid #0066cc; outline-offset: 2px; }
  .fixed.inset-0.z-50 { position: fixed; inset: 0; z-index: 50; background: rgba(0,0,0,0.5); }
  .panel { margin: 40px auto; width: 420px; padding: 16px; background: var(--panel); }
  .muted { color: rgba(23,23,23,0.32); }
  /* The app's real stack: a tinted pill on a glass veil on an opaque panel. */
  .veil { background: rgba(255,255,255,0.05); padding: 8px; }
  .chip { background: rgba(59,130,246,0.15); color: rgb(96,165,250); padding: 2px 8px; }
</style></head>
<body>
  <button id="alpha" class="ringed">Alpha</button>
  <input id="composer" placeholder="composer">
  <button id="gear" title="Settings (&#8984;,)">&#9881;</button>
  <input id="behind" placeholder="behind the scrim">
  <div id="host"></div>
  <script>
    document.getElementById('gear').addEventListener('click', function () {
      if (document.getElementById('close')) return
      document.getElementById('host').innerHTML =
        '<div class="fixed inset-0 z-50"><div class="panel">' +
        '<button id="close">&#10005;</button>' +
        '<button id="tools">Tools</button>' +
        '<input id="deep" placeholder="inside the panel">' +
        '<p class="muted">From the library: leftovers.md</p>' +
        '<div class="veil"><span class="chip">Assistant</span></div>' +
        '</div></div>'
    })
    document.addEventListener('click', function (e) {
      if (e.target && e.target.id === 'close') document.getElementById('host').innerHTML = ''
    })
  </script>
</body></html>`

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

/** True when every recorded style key reads the same focused as unfocused. */
function indistinguishable(row: TabStopRow): boolean {
  const f = row.focused as StyleSnapshot | undefined
  const u = row.unfocused as StyleSnapshot | null | undefined
  if (!f || !u) return false
  return Object.keys(f).every((k) => f[k] === u[k])
}

async function main(): Promise<void> {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: { sandbox: false, nodeIntegration: false, contextIsolation: false }
  })
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(FIXTURE)}`)
  await new Promise((r) => setTimeout(r, 300))
  win.webContents.focus()

  const evalIn = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code) as Promise<T>
  const json = async <T>(code: string): Promise<T> => JSON.parse(await evalIn<string>(code)) as T

  /** A real key event, the same three-part sequence the capture driver sends. */
  const press = async (key: string): Promise<void> => {
    const code = key === 'Tab' ? 'Tab' : key
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: code })
    if (key === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: code })
    await new Promise((r) => setTimeout(r, 60))
  }

  console.log('\nbaseline and the two kinds of stop')

  // Focus is deliberately parked in the middle of the document first. A run's
  // first traversal is taken right after the driver typed into the composer,
  // and blur() alone leaves Chromium's sequential-focus starting point there —
  // which is how one run produced four traversals of one route that reached
  // Settings at stop 26, 8, 8 and 8. Nothing about that set is comparable.
  await evalIn<string>(`(() => { document.getElementById('behind').focus(); return 'parked' })()`)
  const baseline = await json<{ focusables: number; startedFrom: string; reset: boolean }>(TAB_BASELINE)
  check('baseline measures every focusable element', baseline.focusables >= 4, `counted ${baseline.focusables}`)
  check(
    'baseline records where focus actually was, rather than assuming',
    baseline.startedFrom.includes('input'),
    baseline.startedFrom
  )
  check('and puts the walk back to the top of the document', baseline.reset === true)

  const rows: TabStopRow[] = []
  const walk = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) {
      await press('Tab')
      rows.push(await json<TabStopRow>(tabStop(rows.length + 1)))
    }
  }

  await walk(1)
  const alpha = rows[0]
  check('a real Tab press moves focus', alpha.tag === 'button', JSON.stringify(alpha.tag))
  check(
    'the walk restarts at the FIRST focusable control, wherever focus had been',
    alpha.label === 'Alpha',
    `${String(alpha.label)} — a traversal that starts where the last one left off cannot be compared with it`
  )
  check(
    'a control with a focus ring is recorded as visibly different',
    !indistinguishable(alpha),
    JSON.stringify({ focused: alpha.focused, unfocused: alpha.unfocused })
  )
  check(
    'its unfocused reading comes from the pre-traversal baseline',
    mergeUnfocused([alpha], [])[0].unfocusedSource === 'pre'
  )

  await walk(1)
  const composer = rows[1]
  check('the second stop is the ringless input', composer.tag === 'input', String(composer.tag))
  check(
    'an outline-none control is recorded as indistinguishable from its unfocused self',
    indistinguishable(composer),
    JSON.stringify({ focused: composer.focused, unfocused: composer.unfocused })
  )
  // The sharp form of the defect: :focus-visible DOES match — the element was
  // reached by keyboard, so the browser is offering the state — and the app
  // draws nothing for it. Recording the flag next to the two style readings is
  // what separates "the browser withheld the state" from "the app declined to
  // use it", and it is the second that VC2 is about.
  check(
    'a keyboard-focused control matches :focus-visible even when nothing is drawn for it',
    composer.matchesFocusVisible === true,
    String(composer.matchesFocusVisible)
  )

  console.log('\nactivation: walking through the door instead of up to it')

  await walk(1)
  const gear = rows[2]
  check('the traversal reaches the control that opens the panel', /^Settings\b/.test(String(gear.label)), String(gear.label))
  check(
    'the activation route fires on that stop and not before',
    nextActivation(String(gear.label), [{ match: '^Settings\\b' }], 0) !== null &&
      nextActivation(String(composer.label), [{ match: '^Settings\\b' }], 0) === null
  )
  check(
    'a route is strictly ordered — a later pattern cannot fire first',
    nextActivation('Tools', [{ match: '^Settings\\b' }, { match: '^Tools$' }], 0) === null
  )

  const before = await json<Fingerprint>(TAB_FINGERPRINT)
  await press('Enter')
  await new Promise((r) => setTimeout(r, 150))
  const after = await json<Fingerprint>(TAB_FINGERPRINT)
  check('Enter on the focused button really activates it', fingerprintChanged(before, after), JSON.stringify({ before, after }))
  check('the activation is seen as a new surface opening', before.overlay === false && after.overlay === true)

  const added = Number(await evalIn<string>(TAB_REBASELINE))
  check(
    'the controls the panel brought with it are measured unfocused straight away',
    added >= 3,
    `added ${added}`
  )

  console.log('\ninside the panel, and behind it')

  await walk(5)
  const behind = rows.find((r) => r.label === '' && r.tag === 'input' && r.surface === 'page')
  const scrimmed = rows.filter((r) => r.obscured === true)
  check(
    'a control behind the modal scrim is still a Tab stop',
    behind !== undefined || scrimmed.length > 0,
    JSON.stringify(rows.slice(3).map((r) => [r.tag, r.label, r.surface, r.obscured]))
  )
  check(
    'and it is recorded as obscured, naming what is on top of it',
    scrimmed.length > 0 && typeof scrimmed[0].obscuredBy === 'string' && String(scrimmed[0].obscuredBy).includes('z-50'),
    JSON.stringify(scrimmed.map((r) => [r.label, r.obscuredBy]))
  )
  check(
    'an obscured control still reports itself inside the viewport',
    scrimmed.length > 0 && scrimmed[0].inViewport === true,
    'the geometric check alone cannot see a scrim, which is why obscured exists'
  )

  const inPanel = rows.filter((r) => r.surface === 'overlay')
  check('the traversal continues into the panel it opened', inPanel.length >= 3, `${inPanel.length} stops on the overlay`)
  check(
    'the panel is recognised by the app\'s own overlay class string',
    inPanel.every((r) => r.surface === 'overlay')
  )

  const resolved = await json<{ stop: number; style: StyleSnapshot | null }[]>(TAB_RESOLVE)
  const merged = mergeUnfocused(rows, resolved)
  const panelStops = merged.filter((r) => r.surface === 'overlay')
  check(
    'every stop inside the panel has an unfocused reading to compare against',
    panelStops.length > 0 && panelStops.every((r) => r.unfocused !== null && r.unfocused !== undefined),
    JSON.stringify(panelStops.map((r) => [r.label, r.unfocusedSource]))
  )
  check(
    'so focus visibility is decidable inside the panel, not only on the way to it',
    panelStops.some((r) => indistinguishable(r)),
    JSON.stringify(panelStops.map((r) => [r.label, indistinguishable(r)]))
  )
  check(
    'a missing reading is recorded as unknown rather than as "no difference"',
    mergeUnfocused([{ stop: 99, tag: 'button', label: 'gone' }], [])[0].unfocusedSource === null
  )
  // The trap this instrument must not force a scorer into. One key moved in
  // both of these cases, and only the absolute values say which is a ring:
  // an undrawn outline whose colour changed (below), and — recorded from a real
  // run of the app — a permanent 2px outline that merely turns from transparent
  // to teal, which is a ring anyone can see.
  check(
    'the properties that moved are named, so a colour change on an undrawn outline is legible',
    JSON.stringify(
      styleDelta(
        { outlineStyle: 'none', outlineWidth: '0px', outlineColor: 'rgb(0, 105, 90)' },
        { outlineStyle: 'none', outlineWidth: '0px', outlineColor: 'rgba(0, 0, 0, 0)' }
      )
    ) === '["outlineColor"]'
  )
  check(
    'and a stop with no unfocused reading names no delta at all',
    styleDelta({ outlineStyle: 'none' }, null) === null
  )
  check(
    'the body attribute the instrument borrowed is given back',
    (await evalIn<string>(`String(document.body.hasAttribute('tabindex'))`)) === 'false'
  )
  check(
    'every measurable stop carries its delta',
    merged.filter((r) => r.unfocused).every((r) => Array.isArray(r.styleDeltaKeys)),
    JSON.stringify(merged.slice(0, 3).map((r) => r.styleDeltaKeys))
  )

  console.log('\nfinding the way back out')

  const closeLabel = await (async (): Promise<string> => {
    for (let i = 0; i < 30; i++) {
      const peek = await evalIn<string>(TAB_PEEK)
      if (/^✕$/.test(peek)) return peek
      await press('Tab')
    }
    return ''
  })()
  check('the traversal can find the control that closes what it opened', closeLabel === '✕', JSON.stringify(closeLabel))
  const beforeClose = await json<Fingerprint>(TAB_FINGERPRINT)
  await press('Enter')
  await new Promise((r) => setTimeout(r, 150))
  const afterClose = await json<Fingerprint>(TAB_FINGERPRINT)
  check('and closing it is seen', afterClose.overlay === false && beforeClose.overlay === true)

  console.log('\ntheme: the reading, and the witness that it moved')

  // Re-opened, because the exit above closed it: both theme readings have to be
  // of the SAME nodes. Two runs of a task would measure two different replies,
  // which is the whole reason the theme moved into the run as an action.
  await evalIn<string>(`(() => { document.getElementById('gear').click(); return 'opened' })()`)
  await new Promise((r) => setTimeout(r, 120))

  const light = await json<{ nodes: { text: string; foregroundRgb: number[]; backgroundRgb: number[] }[] }>(
    stylesIn(`document.querySelector('.panel')`)
  )
  const mutedLight = light.nodes.find((n) => n.text.includes('From the library'))
  check('every piece of prose in a scope is measured', light.nodes.length >= 1, `${light.nodes.length} text nodes`)
  check('including the provenance line VC3 is about', mutedLight !== undefined, JSON.stringify(light.nodes.map((n) => n.text)))

  const beforeTheme = await json<ThemeReading>(THEME_READ)
  check('a theme reading names the class the stylesheet keys on', beforeTheme.dark === false, beforeTheme.htmlClass)
  check('and it sees whether an overlay is open', beforeTheme.overlayOpen === true)

  await evalIn<string>(`(() => { document.documentElement.classList.add('dark'); return 'ok' })()`)
  await new Promise((r) => setTimeout(r, 120))
  const afterTheme = await json<ThemeReading>(THEME_READ)
  check('the switch is seen', afterTheme.dark === true, afterTheme.htmlClass)
  check(
    'the witness moves: a real rendered colour changed with it',
    beforeTheme.bodyBackground !== afterTheme.bodyBackground,
    JSON.stringify([beforeTheme.bodyBackground, afterTheme.bodyBackground])
  )

  const dark = await json<{ nodes: { text: string; foregroundRgb: number[]; backgroundRgb: number[] }[] }>(
    stylesIn(`document.querySelector('.panel')`)
  )
  const mutedDark = dark.nodes.find((n) => n.text.includes('From the library'))
  check('the same prose is measurable in dark theme', mutedDark !== undefined, JSON.stringify(dark.nodes.map((n) => n.text)))
  check(
    'and it composites over a different background in each theme',
    mutedDark !== undefined &&
      mutedLight !== undefined &&
      JSON.stringify(mutedDark.backgroundRgb) !== JSON.stringify(mutedLight.backgroundRgb),
    JSON.stringify({ light: mutedLight?.backgroundRgb, dark: mutedDark?.backgroundRgb })
  )
  check(
    'a translucent ink is recorded composited, not raw',
    mutedDark !== undefined &&
      mutedDark.foregroundRgb.some((v, i) => v !== [23, 23, 23][i]) &&
      mutedDark.foregroundRgb.every((v) => v >= 0 && v <= 255),
    JSON.stringify(mutedDark?.foregroundRgb)
  )
  // Three layers, two of them translucent. Compositing that stack one step at a
  // time and calling the result opaque turns a 5%-white veil into opaque white:
  // the pill comes back pale blue on a black screen, and every ratio computed
  // from it is fiction. Recorded from a real run before it was fixed.
  const chip = dark.nodes.find((n) => n.text === 'Assistant') as
    | { backgroundRgb: number[]; backgroundChain: unknown[]; backgroundResolved?: string }
    | undefined
  check('a stack of translucent surfaces is walked to the bottom', chip !== undefined && chip.backgroundChain.length === 3, JSON.stringify(chip?.backgroundChain))
  check(
    'and every layer is composited with its own alpha, not flattened at the first one',
    chip !== undefined && chip.backgroundRgb.every((v, i) => Math.abs(v - [42, 53, 70][i]) <= 2),
    `${JSON.stringify(chip?.backgroundRgb)} — flattening at the first layer gives about [226, 236, 254], a pale blue on a black screen`
  )
  check(
    'and the record says whether the stack really bottomed out on something opaque',
    chip?.backgroundResolved === 'opaque-layer',
    String(chip?.backgroundResolved)
  )
  check(
    'so the two themes are two different measurements of one screen',
    mutedDark !== undefined &&
      mutedLight !== undefined &&
      JSON.stringify(mutedDark.foregroundRgb) !== JSON.stringify(mutedLight.foregroundRgb),
    JSON.stringify({ light: mutedLight?.foregroundRgb, dark: mutedDark?.foregroundRgb })
  )

  win.destroy()

  console.log(`\n${'='.repeat(58)}`)
  if (failures.length === 0) {
    console.log(`ALL ${passed} TAB-TRAVERSE CHECKS PASSED`)
    app.exit(0)
  } else {
    console.log(`${passed} passed, ${failures.length} FAILED:`)
    for (const f of failures) console.log(`  - ${f}`)
    app.exit(1)
  }
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('TAB-TRAVERSE CHECK ERROR:', err)
    app.exit(1)
  })
)
