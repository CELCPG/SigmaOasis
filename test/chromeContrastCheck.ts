/**
 * Measures the contrast of a real assistant reply — prose *and* chrome — in a
 * real window, in both themes.
 *
 * Why it cannot be a node:test file, and why it must not measure the CSS
 * variables on their own: the app dresses its chrome in Tailwind utilities and
 * every one of them sits on a *stack* of translucent surfaces — a glass panel
 * over the canvas, a tinted pill over the panel, a disclosure well over that.
 * What the eye gets is the composite. A check that reads `--text-secondary`
 * out of index.css and calls it a pass certifies a property the shipped app
 * does not have: the ink it measured is not the ink the app renders.
 *
 * So: compile the real stylesheet with the real Tailwind config, take every
 * chrome class string out of the components themselves (never a copy — see
 * PICK), lay the message out, and composite each text node's colour over every
 * background above it. WCAG 2.1 relative luminance, AA at 4.5:1.
 *
 * Run through scripts/test-render.sh (Electron proper, not ELECTRON_RUN_AS_NODE).
 */
import { app, BrowserWindow } from 'electron'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { ACCENT } from '../src/renderer/src/lib/colors'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const postcss = require('postcss')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tailwindcss = require('tailwindcss')

const REPO = join(__dirname, '..', '..')
const CSS_PATH = join(REPO, 'src/renderer/src/assets/index.css')
const COMPONENTS = join(REPO, 'src/renderer/src/components')
const RENDERER = join(REPO, 'src/renderer/src')

/** AA for body text. Nothing below this may carry information. */
const AA = 4.5

interface Measured {
  id: string
  fg: string
  bg: string
  ratio: number
}

const bubble = readFileSync(join(COMPONENTS, 'MessageBubble.tsx'), 'utf8')
const reasoning = readFileSync(join(COMPONENTS, 'ReasoningBlock.tsx'), 'utf8')
const sidebar = readFileSync(join(COMPONENTS, 'Sidebar.tsx'), 'utf8')
const appRoot = readFileSync(join(RENDERER, 'App.tsx'), 'utf8')

/** Every renderer source file, so the raw-neutral guard has nowhere to hide. */
function rendererSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return rendererSources(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

/** The section of MessageBubble that renders one piece of chrome. */
function section(from: string, to: string): string {
  const start = bubble.indexOf(from)
  if (start < 0) return ''
  const end = bubble.indexOf(to, start)
  return bubble.slice(start, end < 0 ? bubble.length : end)
}

/**
 * Every chrome class string is *read out of the component*, never restated
 * here. A colour swap therefore shows up in the measurement rather than in a
 * stale copy, and a structural rewrite fails the extraction outright instead
 * of leaving the fixture quietly testing something the app stopped rendering.
 */
const PICK: Record<string, { source: string; re: RegExp; wrap?: (s: string) => string }> = {
  // The canvas and its default ink. Restated here it drifted silently — and
  // worse, Tailwind only emits a utility some renderer source actually uses, so
  // a stale copy stops resolving at all and measures inherited black.
  appShell: { source: appRoot, re: /className="(relative flex h-screen bg-base-light[^"]*)"/ },
  bubble: { source: bubble, re: /className=\{`(glass-panel[^`$]*)/ },
  badge: { source: bubble, re: /className=\{`(inline-flex items-center gap-1\.5[^`$]*)/ },
  modelId: { source: bubble, re: /className="(font-mono text-xs [^"]*)">\{message\.modelId\}/ },
  actionRow: { source: bubble, re: /className="(mb-1 flex flex-wrap[^"]*)"/ },
  actionButton: { source: bubble, re: /onClick=\{copyMessage\}\s*\n\s*className="([^"]*)"/ },
  timestamp: { source: bubble, re: /className="(ml-auto px-1\.5 text-\[10px\][^"]*)"/ },
  branchButton: {
    source: readFileSync(join(COMPONENTS, 'BranchMenu.tsx'), 'utf8'),
    re: /className="(ml-2 rounded-md p-1 [^"]*)"/
  },
  reasoningShell: { source: reasoning, re: /className="(my-2 overflow-hidden[^"]*)"/ },
  reasoningButton: { source: reasoning, re: /className="(flex w-full items-center gap-2[^"]*)"/ },
  reasoningLabel: {
    source: reasoning,
    re: /className=\{`font-medium \$\{isStreaming \? 'shimmer-text' : '([^']*)'\}`\}/,
    wrap: (s) => `font-medium ${s}`
  },
  reasoningCaret: { source: reasoning, re: /className="(ml-auto [^"]*)">\{open/ },
  prose: { source: bubble, re: /className="(markdown-body[^"]*)"/ },
  provenanceRow: {
    source: section('function MemoryContextLine', 'function formatStats'),
    re: /className="(mt-2 text-\[11px\][^"]*)"/
  },
  provenanceButton: {
    source: section('function MemoryContextLine', 'function formatStats'),
    re: /className="(rounded px-1\.5[^"]*)"/
  },
  stats: {
    source: section('showStats && !isStreaming', '</div>\n      </div>'),
    re: /className="(mt-2 text-\[10px\][^"]*)"/
  },
  // The revision line, both tones. It is the only line on screen that reports
  // on the app's own correction of the answer above it, and after round 4 it
  // has two of them: cleared, and still-faulted. Measuring one would certify
  // half a control — the half that was never the problem.
  revisedResolved: {
    source: section('function RevisedLine', 'v1.5.1 think-harder'),
    re: /\?\s*'(mt-2 text-\[11px\] text-emerald[^']*)'/
  },
  revisedUnresolved: {
    source: section('function RevisedLine', 'v1.5.1 think-harder'),
    re: /:\s*'(mt-2 text-\[11px\] text-amber[^']*)'/
  },
  userTimestamp: {
    source: section("if (message.role === 'user')", 'const accent ='),
    re: /className="(text-\[10px\][^"]*)"/
  },
  // The sidebar is chrome too, and it is where the ink-token sweep stopped: a
  // reply can be perfect while the panel beside it carries the worst contrast
  // on the screen.
  sidebarShell: { source: sidebar, re: /<aside className="(relative z-10 m-3 mr-0 flex w-\[280px\][^"]*)"/ },
  sidebarSearch: {
    source: sidebar,
    re: /placeholder="Search conversations…"\s*\n\s*className="([^"]*)"/
  },
  versionChip: {
    source: sidebar,
    re: /className="(text-\[10px\][^"]*)" title="Sigma Oasis build version"/
  }
}

const classes: Record<string, string> = {}
const missing: string[] = []
for (const [name, { source, re, wrap }] of Object.entries(PICK)) {
  const m = source.match(re)
  if (!m) {
    missing.push(name)
    classes[name] = ''
  } else {
    classes[name] = (wrap ? wrap(m[1]) : m[1]).trim()
  }
}

function c(name: keyof typeof PICK): string {
  return classes[name]
}

/**
 * The ink a `placeholder:` utility paints, as a class that can be measured.
 * Chromium keeps the placeholder in a UA shadow root, so
 * `getComputedStyle(input, '::placeholder')` reports the input's own colour and
 * a check built on it certifies ink nobody sees. Both strings come out of the
 * same scraped class list, so the probe cannot drift from the control.
 */
function placeholderInk(classList: string): string {
  return classList
    .split(/\s+/)
    .filter((t) => t.startsWith('placeholder:'))
    .map((t) => t.slice('placeholder:'.length))
    .join(' ')
}

/**
 * Every text node here carries information the reply depends on: what was
 * consulted, how long it took, which model answered, what each control does,
 * whether a disclosure is open. A purely decorative glyph may sit lighter —
 * the 💭 does — but then it must not be the only thing saying something.
 */
const LOAD_BEARING = [
  'role badge',
  'model id',
  'action: copy',
  'action: branch',
  'timestamp',
  'reasoning label',
  'reasoning caret',
  'prose',
  'prose link',
  'prose quote',
  'library provenance',
  'revision cleared',
  'revision unresolved',
  'stats readout',
  'user timestamp',
  'sidebar search placeholder',
  'version chip'
]

/**
 * The real bubble: same nesting, same surfaces, same order as the DOM a
 * recorded turn produces — role badge, action row, collapsed reasoning
 * disclosure, prose, the library provenance line, the stats footer, and the
 * user's own timestamp out on the bare canvas.
 */
function fixture(dark: boolean): string {
  return `<!doctype html>
<html lang="en" class="${dark ? 'dark' : ''}"><head><meta charset="utf-8"><style>__CSS__</style></head>
<body>
  <div class="${c('appShell')}">
    <div class="ambient-orbs" aria-hidden="true"></div>
    <aside class="${c('sidebarShell')}">
      <div class="px-4 pb-2">
        <div class="${c('sidebarSearch')}"><span class="${placeholderInk(c('sidebarSearch'))}" data-ink="sidebar search placeholder">Search conversations…</span></div>
      </div>
      <div class="mt-auto flex items-center gap-2 border-t border-black/10 dark:border-white/10 p-4">
        <span class="${c('versionChip')}" data-ink="version chip">v31.7.7</span>
      </div>
    </aside>
    <div class="min-h-0 flex-1 overflow-y-auto pb-8 pt-4">
      <div class="px-4 py-2">
        <div class="mx-auto flex max-w-3xl items-start gap-3">
          <div class="${c('bubble')}">
            <div class="mb-1.5 flex items-center gap-2">
              <span class="${c('badge')} ${ACCENT.blue.badge}" data-ink="role badge"><span class="h-1.5 w-1.5 rounded-full bg-blue-500"></span>Assistant</span>
              <span class="${c('modelId')}" data-ink="model id">qwen3.8-9b</span>
            </div>
            <div class="${c('actionRow')}">
              <button type="button" class="${c('actionButton')}" data-ink="action: copy">📋 Copy</button>
              <button type="button" class="${c('actionButton')}">🔊 Listen</button>
              <button type="button" class="${c('actionButton')}">↻ Regenerate</button>
              <button type="button" class="${c('actionButton')}">🧠 Think harder</button>
              <div class="relative inline-block"><button class="${c('branchButton')}" data-ink="action: branch">🌿</button></div>
              <span class="${c('timestamp')}" data-ink="timestamp">11:14 AM</span>
            </div>
            <div class="${c('reasoningShell')}">
              <button type="button" class="${c('reasoningButton')}">
                <span data-ink="reasoning glyph">💭</span>
                <span class="${c('reasoningLabel')}" data-ink="reasoning label">Thought for 9.6s</span>
                <span class="${c('reasoningCaret')}" data-ink="reasoning caret">▸</span>
              </button>
            </div>
            <div class="${c('prose')}">
              <p data-ink="prose">Poultry reaches a safe internal temperature at 74&nbsp;°C, measured in the thickest part.</p>
              <p><a href="#" data-ink="prose link">The source table</a> lists every cut.</p>
              <blockquote data-ink="prose quote">Rest the meat for three minutes before carving.</blockquote>
            </div>
            <div class="${c('provenanceRow')}">
              <button type="button" class="${c('provenanceButton')}" data-ink="library provenance">📖 From the library: Food safety › Safe minimum internal temperatures (0.72) ▸</button>
            </div>
            <div class="${c('revisedResolved')}" data-ink="revision cleared">✎ Revised: 1 unsupported item was sent back (165°F); the re-check faults none of them.</div>
            <div class="${c('revisedUnresolved')}" data-ink="revision unresolved">✎ Revised: 2 unsupported items were sent back; 1 is still unsupported in this answer: 165°F.</div>
            <div class="${c('stats')}" data-ink="stats readout">238 tok · 10.1 tok/s · 7.84s to first token · 23.6s total</div>
          </div>
        </div>
      </div>
      <div class="flex flex-col items-end gap-2 px-4 py-2">
        <span class="${c('userTimestamp')}" data-ink="user timestamp">11:14 AM</span>
      </div>
    </div>
  </div>
</body></html>`
}

/**
 * Runs in the page. Composites every measured node's colour over the whole
 * stack of backgrounds above it, then reports the WCAG 2.1 ratio.
 */
const MEASURE = `(() => {
  const parse = (s) => {
    const n = (s.match(/[\\d.]+/g) || []).map(Number)
    return [n[0] || 0, n[1] || 0, n[2] || 0, n.length > 3 ? n[3] : 1]
  }
  const over = (fg, bg) => (fg[3] >= 1 ? fg.slice(0, 3) : [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])))
  const chan = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  const lum = (c) => 0.2126 * chan(c[0]) + 0.7152 * chan(c[1]) + 0.0722 * chan(c[2])
  const ratio = (a, b) => {
    const x = lum(a), y = lum(b)
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
  }
  const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
  const bgOf = (el) => {
    const layers = []
    for (let n = el; n; n = n.parentElement) layers.push(parse(getComputedStyle(n).backgroundColor))
    let out = [255, 255, 255]
    for (let i = layers.length - 1; i >= 0; i--) out = over(layers[i], out)
    return out
  }
  return [...document.querySelectorAll('[data-ink]')].map((el) => {
    const bg = bgOf(el)
    const fg = over(parse(getComputedStyle(el).color), bg)
    return { id: el.getAttribute('data-ink'), fg: hex(fg), bg: hex(bg), ratio: Math.round(ratio(fg, bg) * 100) / 100 }
  })
})()`

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

async function buildCss(): Promise<string> {
  const source = readFileSync(CSS_PATH, 'utf8')
    // postcss-import is not a dependency, and an unresolvable @import inside a
    // data: document never settles. The highlight.js theme only paints code
    // blocks, which nothing here measures.
    .replace(/^@import .*$/m, '')
  const config = require(join(REPO, 'tailwind.config.js'))
  const out = await postcss([tailwindcss(config)]).process(source, { from: CSS_PATH })
  return out.css as string
}

async function measure(win: BrowserWindow, css: string, dark: boolean): Promise<Measured[]> {
  const html = fixture(dark).replace('__CSS__', css)
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 200))
  return (await win.webContents.executeJavaScript(MEASURE)) as Measured[]
}

async function main(): Promise<void> {
  const css = await buildCss()

  console.log('\nthe fixture is the app’s own chrome')
  check('every chrome class string was found in its component', missing.length === 0, missing.join(', '))

  // Raw neutral utilities cannot be theme-aware: the grey that clears AA on the
  // black canvas fails on the white one, and vice versa. Chrome ink has to go
  // through the semantic ramp (--text-*), which is defined once per theme.
  console.log('\nchrome ink is theme-aware')
  const RAW_INK = /(?:^|[\s"'`{:])text-(?:neutral|gray|zinc|slate|stone)-\d{3}\b/g
  for (const [file, src] of [
    ['MessageBubble.tsx', bubble],
    ['ReasoningBlock.tsx', reasoning]
  ] as const) {
    const raw = src.match(RAW_INK) ?? []
    check(`${file} sets no chrome ink in a raw neutral`, raw.length === 0, `${raw.length} site(s)`)
  }

  // Two components are not a palette. Retinting the files a critic happens to
  // look at leaves the default for every component written afterwards at
  // neutral-400 — 2.2:1 on the light sidebar — so the guard is the whole
  // renderer or it is nothing.
  const sources = rendererSources(RENDERER)
  check(`the guard scans the whole renderer, not a hand-picked file or two`, sources.length >= 40, `${sources.length} file(s)`)
  const offenders: string[] = []
  let rawSites = 0
  for (const path of sources) {
    const hits = (readFileSync(path, 'utf8').match(RAW_INK) ?? []).length
    if (hits > 0) {
      rawSites += hits
      offenders.push(`${path.slice(RENDERER.length + 1)} (${hits})`)
    }
  }
  check(
    'no renderer source sets ink in a raw neutral',
    offenders.length === 0,
    `${rawSites} site(s) in ${offenders.length} file(s): ${offenders.slice(0, 6).join(', ')}${offenders.length > 6 ? ' …' : ''}`
  )

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 1000,
    webPreferences: { offscreen: true, sandbox: true, nodeIntegration: false }
  })

  const themes = [
    { name: 'light', rows: await measure(win, css, false) },
    { name: 'dark', rows: await measure(win, css, true) }
  ]

  for (const theme of themes) {
    console.log(`\n${theme.name} theme — composited contrast of a real reply`)
    for (const row of theme.rows) {
      console.log(`       ${row.ratio.toFixed(2).padStart(6)}:1  ${row.fg} on ${row.bg}  ${row.id}`)
    }
    for (const id of LOAD_BEARING) {
      const row = theme.rows.find((r) => r.id === id)
      check(
        `${theme.name}: “${id}” clears AA`,
        !!row && row.ratio >= AA,
        row ? `${row.ratio.toFixed(2)}:1 (${row.fg} on ${row.bg})` : 'node missing from fixture'
      )
    }
  }

  // One legible ink everywhere would pass the loop above and flatten the
  // reading order. The reply must still separate prose from chrome and keep
  // more than one rank of chrome.
  console.log('\nhierarchy survives')
  for (const theme of themes) {
    const by = (id: string): Measured =>
      theme.rows.find((r) => r.id === id) ?? { id, fg: '', bg: '', ratio: 0 }
    const prose = by('prose')
    const primary = by('reasoning label')
    const secondary = by('stats readout')
    check(
      `${theme.name}: prose outranks chrome`,
      prose.ratio > primary.ratio + 1,
      `prose ${prose.ratio}:1 vs chrome ${primary.ratio}:1`
    )
    check(
      `${theme.name}: chrome keeps two ranks`,
      primary.fg !== secondary.fg && primary.ratio > secondary.ratio,
      `${primary.fg} (${primary.ratio}:1) vs ${secondary.fg} (${secondary.ratio}:1)`
    )
    // The revision line reports on the app's own correction, and through v1.14
    // it painted both outcomes the same green — including the measured V1 turn
    // where the finding was still standing in the answer above it. Colour is
    // the fastest thing a reader reads; a finding that survived must not wear
    // the colour of one that did not.
    const cleared = by('revision cleared')
    const unresolved = by('revision unresolved')
    check(
      `${theme.name}: a surviving finding is not painted as a resolved one`,
      cleared.fg !== unresolved.fg,
      `both ${cleared.fg}`
    )
  }

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
