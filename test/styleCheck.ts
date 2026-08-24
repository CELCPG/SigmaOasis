/**
 * Visual craft, measured — the app's real stylesheet in a real offscreen window.
 *
 * Three properties that only exist once a browser has laid the page out, so a
 * node:test of them would be a test of the fixture:
 *
 *   - a 220-character unbreakable token stays inside the chat column;
 *   - every control that clears its outline with `outline-none` gets a visible
 *     ring back on :focus-visible — and only on :focus-visible;
 *   - the prose ink tiers clear 4.5:1 on both canvases, and stay a ramp.
 *
 * The CSS is compiled the way the app compiles it (postcss + the project's own
 * tailwind.config.js over assets/index.css), and the focus probes are the actual
 * class strings scraped out of the components, so this measures what ships.
 * :focus-visible cannot be reached by focusing an element in a window that has
 * no OS focus, so the state is forced through CDP instead.
 *
 * Run through scripts/test-render.sh (Electron proper, not ELECTRON_RUN_AS_NODE).
 */
import { app, BrowserWindow } from 'electron'
import { createServer } from 'http'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import type { AddressInfo } from 'net'

const ROOT = join(__dirname, '..', '..')
const COMPONENTS = join(ROOT, 'src', 'renderer', 'src', 'components')
const CSS_ENTRY = join(ROOT, 'src', 'renderer', 'src', 'assets', 'index.css')

const bubbleSrc = readFileSync(join(COMPONENTS, 'MessageBubble.tsx'), 'utf-8')
const markdownSrc = readFileSync(join(ROOT, 'src', 'renderer', 'src', 'lib', 'markdown.ts'), 'utf-8')
const cssSrc = readFileSync(CSS_ENTRY, 'utf-8')

/**
 * Class strings read out of the app, never restated here — a copy would keep
 * measuring markup the app has stopped rendering. `?? ''` rather than a throw
 * so a rewrite shows up as the extraction check failing, with the layout
 * checks failing beside it, instead of a stack trace with no measurements.
 */
function pick(source: string, re: RegExp): string {
  return (source.match(re)?.[1] ?? '').trim()
}

/** The assistant bubble, exactly as MessageBubble builds it. */
const REPLY_BUBBLE = pick(bubbleSrc, /className=\{`(glass-panel[^`$]*min-w-0 flex-1[^`$]*)/)
/** A reply surface that is not prose: the second-opinion / deliberation text. */
const REPLY_TEXT = pick(bubbleSrc, /className="(whitespace-pre-wrap [^"]*)"/)
/** The control the code-block header offers for unfolding a long line. */
const WRAP_BTN = pick(markdownSrc, /class="(code-wrap-btn)"/)
/** The state class that control turns on, read from the stylesheet that keys on it. */
const WRAP_STATE = pick(cssSrc, /\.code-block\.([a-z-]+) pre \{/)

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

/* ---- colour maths (WCAG 2.1 relative luminance) --------------------------- */

type Rgba = [number, number, number, number]

function parseColor(value: string): Rgba {
  const hex = value.trim().match(/^#([0-9a-f]{6})$/i)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]
  }
  const nums = value.match(/[\d.]+/g)
  if (!nums || nums.length < 3) throw new Error(`unparseable color: ${value}`)
  const [r, g, b] = nums.slice(0, 3).map(Number)
  return [r, g, b, nums.length > 3 ? Number(nums[3]) : 1]
}

/** Source-over composite of a translucent colour onto an opaque one. */
function over(fg: Rgba, bg: Rgba): Rgba {
  return [
    fg[3] * fg[0] + (1 - fg[3]) * bg[0],
    fg[3] * fg[1] + (1 - fg[3]) * bg[1],
    fg[3] * fg[2] + (1 - fg[3]) * bg[2],
    1
  ]
}

function luminance([r, g, b]: Rgba): number {
  const f = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrast(fg: Rgba, bg: Rgba): number {
  const a = luminance(over(fg, bg))
  const b = luminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/* ---- the class strings the app actually strips the outline from ----------- */

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return tsxFiles(path)
    return name.endsWith('.tsx') ? [path] : []
  })
}

/**
 * Every run of classes containing `outline-none`. The run ends at a quote or a
 * `${` boundary, which is exactly the slice that lands on one element.
 */
function outlineNoneClassLists(): string[] {
  const lists: string[] = []
  for (const file of tsxFiles(COMPONENTS)) {
    const src = readFileSync(file, 'utf-8')
    for (let i = src.indexOf('outline-none'); i !== -1; i = src.indexOf('outline-none', i + 1)) {
      const stop = /['"`{}\n]/
      let a = i
      let b = i + 'outline-none'.length
      while (a > 0 && !stop.test(src[a - 1])) a -= 1
      while (b < src.length && !stop.test(src[b])) b += 1
      const classes = src
        .slice(a, b)
        .split(/\s+/)
        .filter((c) => c !== '' && !c.includes('$'))
      lists.push(classes.join(' '))
    }
  }
  return lists
}

/* ---- fixture -------------------------------------------------------------- */

const BLOB = `/Users/x/Library/Caches/${'QUJDREVGR0hJSktMTU5PUFFSU1RVVld'.repeat(6)}.bin`
const CODE_LINE = `const payload = "${'y'.repeat(200)}"`

/**
 * The two bubbles as MessageBubble.tsx builds them — same wrappers, same utility
 * classes — inside a chat column squeezed to 420px.
 */
function fixture(css: string, probes: string[]): string {
  const inks = ['primary', 'secondary', 'tertiary', 'muted']
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    .column { display: flex; width: 420px; align-items: flex-start; gap: 12px; }
  </style><style>${css}</style></head>
<body>
  <div class="column">
    <div class="${REPLY_BUBBLE}" id="bubble">
      <div class="markdown-body text-sm" id="md">
        <p>Saved to <span id="blob">${BLOB}</span> just now.</p>
        <div class="code-block"><pre><code>${CODE_LINE}</code></pre></div>
        <div class="code-block ${WRAP_STATE}" id="wrapped-block"><pre><code>${CODE_LINE}</code></pre></div>
      </div>
      <p class="${REPLY_TEXT}"><span id="reply-text-token">${BLOB}</span></p>
    </div>
  </div>
  <div class="column" style="justify-content: flex-end">
    <div class="max-w-[80%] whitespace-pre-wrap break-words rounded-3xl px-4 py-2.5 text-sm" id="user-bubble"><span id="user-token">${BLOB}</span></div>
  </div>
  <div class="glass-panel" id="panel">
    ${inks.map((t) => `<p class="text-ink-${t}" id="ink-${t}">ink ${t}</p>`).join('\n    ')}
    <p class="text-accent-ink" id="ink-accent">accent ink</p>
    ${probes.map((c, i) => `<input data-probe="${i}" class="${c}">`).join('\n    ')}
  </div>
</body></html>`
}

/** Everything the checks read out of the page, in one round trip. */
const PROBE_SCRIPT = `(() => {
  const cs = (el) => getComputedStyle(el)
  const pre = document.querySelector('.code-block pre')
  const wrapped = document.querySelector('#wrapped-block pre')
  const panel = document.getElementById('panel')
  // Line boxes and edges, unclipped: a bubble that hides its overflow would
  // otherwise report a token that has silently run out of sight as "fitting".
  const spill = (tokenId, holderId) => {
    const token = document.getElementById(tokenId)
    const holder = document.getElementById(holderId)
    const rects = [...token.getClientRects()]
    const box = holder.getBoundingClientRect()
    const pad = parseFloat(cs(holder).paddingRight)
    return {
      lines: rects.length,
      widest: Math.max(...rects.map((r) => r.width)),
      holderWidth: box.width - pad * 2,
      overhang: Math.max(...rects.map((r) => r.right)) - (box.right - pad)
    }
  }
  const ring = (el) => {
    const s = cs(el)
    return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), color: s.outlineColor }
  }
  const ink = {}
  const vars = {}
  const rootStyle = cs(document.documentElement)
  for (const t of ['primary', 'secondary', 'tertiary', 'muted', 'accent']) {
    ink[t] = cs(document.getElementById('ink-' + t)).color
    vars[t] = rootStyle.getPropertyValue(t === 'accent' ? '--accent-ink' : '--text-' + t).trim()
  }
  return {
    vars,
    reply: spill('blob', 'bubble'),
    replyText: spill('reply-text-token', 'bubble'),
    userMessage: spill('user-token', 'user-bubble'),
    docScrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    codeScrollWidth: pre.scrollWidth,
    codeClientWidth: pre.clientWidth,
    wrappedScrollWidth: wrapped ? wrapped.scrollWidth : -1,
    wrappedClientWidth: wrapped ? wrapped.clientWidth : -1,
    wrappedLines: wrapped ? wrapped.querySelector('code').getClientRects().length : 0,
    canvas: cs(document.body).backgroundColor,
    panel: cs(panel).backgroundColor,
    ink,
    rings: [...document.querySelectorAll('[data-probe]')].map((el) => ring(el))
  }
})()`

interface Spill {
  lines: number
  widest: number
  holderWidth: number
  overhang: number
}

interface Probe {
  reply: Spill
  replyText: Spill
  userMessage: Spill
  docScrollWidth: number
  viewportWidth: number
  codeScrollWidth: number
  codeClientWidth: number
  wrappedScrollWidth: number
  wrappedClientWidth: number
  wrappedLines: number
  canvas: string
  panel: string
  ink: Record<string, string>
  vars: Record<string, string>
  rings: { style: string; width: number; color: string }[]
}

async function buildCss(): Promise<string> {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const postcss = require('postcss') as typeof import('postcss')
  const tailwind = require('tailwindcss')
  /* eslint-enable @typescript-eslint/no-var-requires */
  const config = require(join(ROOT, 'tailwind.config.js'))
  const entry = CSS_ENTRY
  // Same config the app builds with; the globs are anchored so the utility set
  // does not depend on the cwd the check happens to run from.
  const result = await postcss([
    tailwind({ ...config, content: config.content.map((glob: string) => join(ROOT, glob)) })
  ]).process(readFileSync(entry, 'utf-8'), { from: entry })
  return result.css
}

async function main(): Promise<void> {
  const css = await buildCss()
  const probes = outlineNoneClassLists()
  const page = fixture(css, probes)

  const server = createServer((req, res) => {
    // Any request that is not the fixture is the highlight.js theme @import,
    // which this check does not care about. An empty stylesheet keeps it quiet.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(req.url === '/' ? page : '')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 900,
    webPreferences: { offscreen: true, sandbox: true, nodeIntegration: false }
  })
  await win.loadURL(`http://127.0.0.1:${port}/`)
  await new Promise((r) => setTimeout(r, 300))

  const read = async (): Promise<Probe> =>
    (await win.webContents.executeJavaScript(PROBE_SCRIPT)) as Probe

  // :focus-visible never matches in a window the OS has not focused, so the
  // state is forced on the probes through the debugger instead.
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  await dbg.sendCommand('DOM.enable')
  await dbg.sendCommand('CSS.enable')
  const { root } = (await dbg.sendCommand('DOM.getDocument', { depth: -1 })) as {
    root: { nodeId: number }
  }
  const { nodeIds } = (await dbg.sendCommand('DOM.querySelectorAll', {
    nodeId: root.nodeId,
    selector: '[data-probe]'
  })) as { nodeIds: number[] }

  const unfocused = await read()

  for (const nodeId of nodeIds)
    await dbg.sendCommand('CSS.forcePseudoState', {
      nodeId,
      forcedPseudoClasses: ['focus', 'focus-visible']
    })

  const light = await read()
  await win.webContents.executeJavaScript(`document.documentElement.classList.add('dark')`)
  const dark = await read()

  /* -- (a) a long unbreakable token stays in its container ------------------ */

  console.log('\na 220-character unbreakable token in a 420px chat column')
  check(
    'the fixture is the app’s own reply markup',
    REPLY_BUBBLE !== '' && REPLY_TEXT !== '',
    `bubble ${REPLY_BUBBLE ? 'ok' : 'MISSING'}, non-prose surface ${REPLY_TEXT ? 'ok' : 'MISSING'}`
  )
  // `reply text` is the second-opinion / deliberation surface: model output
  // that never goes through the markdown renderer, and so never inherited the
  // break opportunity .markdown-body has. One base64 blob in it stretched the
  // bubble, and the flex column with it.
  for (const [where, s] of [
    ['reply', light.reply],
    ['reply text', light.replyText],
    ['user message', light.userMessage]
  ] as const) {
    check(`${where}: the token wraps instead of running on`, s.lines > 1, `${s.lines} line box(es)`)
    check(
      `${where}: no line of it is wider than the bubble`,
      s.widest <= s.holderWidth + 1,
      `widest line ${s.widest.toFixed(1)}px vs ${s.holderWidth.toFixed(1)}px of bubble`
    )
    check(
      `${where}: nothing hangs past the bubble's edge`,
      s.overhang <= 1,
      `overhangs by ${s.overhang.toFixed(1)}px`
    )
  }
  check(
    'the document does not scroll sideways',
    light.docScrollWidth <= light.viewportWidth,
    `scrollWidth ${light.docScrollWidth} vs viewport ${light.viewportWidth}`
  )
  check(
    'a code block still scrolls rather than wrapping',
    light.codeScrollWidth > light.codeClientWidth,
    `${light.codeScrollWidth} vs ${light.codeClientWidth}`
  )

  // Scrolling is the right default — a wrapped line is a lie about the source —
  // but it left no way to read a 300-character line at all. The header carries
  // a control that turns wrapping on for one block; these four checks are the
  // control, the state it sets, the wiring between them, and the layout that
  // state actually produces.
  console.log('\nand a way to see a long line anyway')
  check('the code-block header ships a wrap control', WRAP_BTN !== '', 'no .code-wrap-btn in markdown.ts')
  check(
    'the stylesheet defines the wrapped state that control turns on',
    WRAP_STATE !== '',
    'no `.code-block.<state> pre` rule in index.css'
  )
  check(
    'MessageBubble wires the control to that state',
    WRAP_BTN !== '' && WRAP_STATE !== '' && bubbleSrc.includes(WRAP_BTN) && bubbleSrc.includes(WRAP_STATE),
    `looked for ${WRAP_BTN || '?'} and ${WRAP_STATE || '?'}`
  )
  check(
    'in that state the same line wraps instead of scrolling',
    light.wrappedLines > 1 && light.wrappedScrollWidth <= light.wrappedClientWidth + 1,
    `${light.wrappedLines} line box(es), ${light.wrappedScrollWidth} vs ${light.wrappedClientWidth}`
  )

  /* -- (b) focus indicators ------------------------------------------------- */

  console.log(`\nfocus rings on the ${probes.length} controls that clear their outline`)
  check('found the outline-none controls to probe', probes.length >= 25, `${probes.length} found`)

  const canvas = parseColor(light.canvas)
  const panel = over(parseColor(light.panel), canvas)
  const darkCanvas = parseColor(dark.canvas)
  const darkPanel = over(parseColor(dark.panel), darkCanvas)

  const ringless = light.rings.filter(
    (r) => r.style === 'none' || r.width < 2 || parseColor(r.color)[3] === 0
  )
  check(
    'every one of them shows a ring at least 2px wide when focused',
    ringless.length === 0,
    `${ringless.length} without one`
  )
  const faint = light.rings.filter((r) => contrast(parseColor(r.color), panel) < 3)
  check(
    'the ring clears 3:1 against the surface it sits on (light)',
    faint.length === 0,
    `worst ${Math.min(...light.rings.map((r) => contrast(parseColor(r.color), panel))).toFixed(2)}:1`
  )
  const faintDark = dark.rings.filter((r) => contrast(parseColor(r.color), darkPanel) < 3)
  check(
    'the ring clears 3:1 against the surface it sits on (dark)',
    faintDark.length === 0,
    `worst ${Math.min(...dark.rings.map((r) => contrast(parseColor(r.color), darkPanel))).toFixed(2)}:1`
  )
  const painted = unfocused.rings.filter(
    (r) => r.style !== 'none' && r.width >= 2 && parseColor(r.color)[3] > 0
  )
  check(
    'and no ring at all when the control is not focused',
    painted.length === 0,
    `${painted.length} permanently ringed`
  )

  /* -- (c) prose ink clears AA on both canvases ----------------------------- */

  console.log('\nprose ink contrast (WCAG AA body text is 4.5:1)')
  const PROSE = ['primary', 'secondary', 'tertiary', 'accent']
  // Guards the measurement itself: an ink utility that stopped resolving to its
  // variable would fall back to inherited black and quietly "pass".
  const unwired = [...PROSE, 'muted'].filter(
    (t) => parseColor(light.ink[t]).join() !== parseColor(light.vars[t]).join()
  )
  check(
    'each text-ink-* utility resolves to its ink variable',
    unwired.length === 0,
    unwired.join(', ')
  )
  const measured: Record<string, Record<string, number>> = {}
  for (const [theme, probe, bases] of [
    ['light', light, { canvas, panel }],
    ['dark', dark, { canvas: darkCanvas, panel: darkPanel }]
  ] as const) {
    measured[theme] = {}
    for (const tier of [...PROSE, 'muted']) {
      const color = parseColor(probe.ink[tier])
      const worst = Math.min(...Object.values(bases).map((bg) => contrast(color, bg)))
      measured[theme][tier] = worst
      if (PROSE.includes(tier))
        check(
          `${theme}: ${tier === 'accent' ? '--accent-ink' : `--text-${tier}`} clears 4.5:1`,
          worst >= 4.5,
          `${worst.toFixed(2)}:1 (${probe.ink[tier]})`
        )
    }
  }

  console.log('\nthe ramp is still a ramp (not one flattened ink)')
  for (const theme of ['light', 'dark'] as const) {
    const m = measured[theme]
    console.log(
      `  ${theme.padEnd(5)} ${['primary', 'secondary', 'tertiary', 'muted']
        .map((t) => `${t} ${m[t].toFixed(2)}:1`)
        .join('   ')}`
    )
    check(
      `${theme}: primary → secondary → tertiary → muted each stay a distinct step`,
      m.primary > m.secondary * 1.3 && m.secondary > m.tertiary * 1.3 && m.tertiary > m.muted * 1.3,
      `${m.primary.toFixed(2)} / ${m.secondary.toFixed(2)} / ${m.tertiary.toFixed(2)} / ${m.muted.toFixed(2)}`
    )
  }

  // --text-muted is below AA by design; the contract is that nothing sets prose
  // in it. Anything but a decorative glyph is a misuse.
  const misuse: string[] = []
  for (const file of tsxFiles(COMPONENTS))
    for (const line of readFileSync(file, 'utf-8').split('\n'))
      if (line.includes('text-ink-muted') && !/[▼▶]/.test(line)) misuse.push(line.trim().slice(0, 60))
  check(
    `nothing sets prose in --text-muted (${measured.light.muted.toFixed(2)}:1 — decorative glyphs only)`,
    misuse.length === 0,
    `${misuse.length} site(s), e.g. ${misuse.slice(0, 3).join(' | ')}`
  )

  dbg.detach()
  server.close()
  win.destroy()

  console.log(`\n${'='.repeat(58)}`)
  if (failures.length === 0) {
    console.log(`ALL ${passed} STYLE CHECKS PASSED`)
    app.exit(0)
  } else {
    console.log(`${passed} passed, ${failures.length} FAILED:`)
    for (const f of failures) console.log(`  - ${f}`)
    app.exit(1)
  }
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('STYLE CHECK ERROR:', err)
    app.exit(1)
  })
)
