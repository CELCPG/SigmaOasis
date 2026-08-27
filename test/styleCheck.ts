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
/** The modifier the renderer sets on a block that may fold mid-token. */
const FOLD_STATE = pick(cssSrc, new RegExp(`\\.code-block\\.${WRAP_STATE}\\.([a-z-]+) pre \\{`))
/** The scroll container the renderer wraps every table in. */
const TABLE_SCROLL = pick(markdownSrc, /class="(md-table-scroll)"/)

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
 * The token from the round-8 critique, verbatim: hyphenated every few
 * characters, so every hyphen is a break opportunity the line-breaker will take
 * in preference to breaking inside a run. It is the shape that made round 8's
 * fix ambiguous — each folded row ended in a real `-`, which a reader has been
 * trained to delete when rejoining lines.
 */
const HYPHEN_TOKEN =
  'signme-oasis-head-to-head-layout-probe-a-single-unbroken-token-that-must-not-' +
  'block-out-the-chat-column-0001-0002-0003-0004-0005-0006-0007-0008-0009-0010-' +
  '0011-0012-0013-0014-0015-0016-0017-0018-0019-0020-0021'

/**
 * Three lines of ordinary JavaScript, each too long for the column — the true
 * negative for the rule above. A reader who pressed Wrap on this wants to read
 * the code, and filling every row to the edge would break identifiers that
 * would have fitted the next row: round 8's shredding, inside a code block.
 * Deliberately hyphen-free, so this measures identifier splitting and nothing
 * else; the hyphen case has its own control below.
 */
const ORDINARY_CODE = [
  'const resolvedConfiguration = mergeDefaults(userConfiguration, environmentOverrides)',
  'export async function synchroniseWorkspaceManifest(workspaceRoot, { dryRun } = {}) {',
  '  await writeFileAtomic(manifestPath, JSON.stringify(nextManifest, null, 2), rootDir)'
].join('\n')

/** The code-block header the renderer emits, so its controls are measured as they ship. */
const CODE_HEADER =
  '<div class="code-header"><span>plaintext</span><span class="code-actions">' +
  '<button type="button" class="code-wrap-btn" aria-pressed="true">Wrap</button>' +
  '<button type="button" class="code-copy-btn">Copy</button></span></div>'

/**
 * A citations table exactly like the one a reply builds from retrieved
 * passages: a 3-character marker column beside an English header, and a prose
 * column wide enough that the table cannot have every column at its preferred
 * width. That squeeze is the whole case — it is what made the layout engine
 * choose between widening the `Passage` column and breaking the word, and under
 * `overflow-wrap: anywhere` it broke the word.
 */
const citationsTable = (id: string): string => `<table>
          <thead><tr><th id="th-passage-${id}">Passage</th><th>Source</th><th>What it says</th></tr></thead>
          <tbody>
            <tr><td>[1]</td><td>burns.md</td><td>Cool the burn under cool running water for at least 20 minutes</td></tr>
            <tr><td>[2]</td><td>scalds.md</td><td>Do not apply ice, butter or any cream to a scald</td></tr>
          </tbody>
        </table>`

/** The same token, in a table cell — the case a table must scroll rather than pass on. */
const TOKEN_TABLE = `<table>
          <thead><tr><th>Token</th><th>Note</th></tr></thead>
          <tbody><tr><td>${BLOB}</td><td>log line</td></tr></tbody>
        </table>`

/** The reply, as MessageBubble.tsx builds it, at one chat-column width. */
function reply(id: string): string {
  return `<div class="${REPLY_BUBBLE}" id="${id}">
      <div class="markdown-body text-sm" id="md-${id}">
        <p>Saved to <span id="blob-${id}">${BLOB}</span> just now.</p>
        <div class="${TABLE_SCROLL}" id="cites-${id}">${citationsTable(id)}</div>
        <div class="${TABLE_SCROLL}" id="tokentable-${id}">${TOKEN_TABLE}</div>
      </div>
    </div>`
}

/**
 * The three wrapped code blocks, in a reply of their own at the same width.
 *
 * Separate from `reply()` on purpose. The shredded-word detector that runs over
 * a reply measures each word against the REPLY's width, which is right for a
 * table cell — the box whose width its own contents decide is the thing under
 * test — and a category error for a `<pre>`, whose width the column fixes and
 * which cannot collapse. Code is measured against its own content box, below.
 *
 *   fold     the copy-me token, under the rule this round adds
 *   control  the same token under round 8's rule, unchanged — the before
 *   ordinary real code a reader turned Wrap on by hand, which must not fold
 *            the way the token does
 */
function codeBlocks(id: string): string {
  const block = (key: string, classes: string, body: string): string =>
    `<div class="code-block ${classes}">${CODE_HEADER}` +
    `<pre id="${key}-${id}"><code>${body}</code></pre></div>`
  return (
    `<div class="${REPLY_BUBBLE}" id="codes-${id}"><div class="markdown-body text-sm">` +
    block('fold', `${WRAP_STATE} ${FOLD_STATE}`, HYPHEN_TOKEN) +
    block('ctl', WRAP_STATE, HYPHEN_TOKEN) +
    block('wrapcode', WRAP_STATE, ORDINARY_CODE) +
    `</div></div>`
  )
}

/**
 * The two bubbles as MessageBubble.tsx builds them — same wrappers, same utility
 * classes — inside a chat column squeezed to 420px, and again at the 232px a
 * bubble gets in split view.
 */
function fixture(css: string, probes: string[]): string {
  const inks = ['primary', 'secondary', 'tertiary', 'muted']
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    .column { display: flex; width: 420px; align-items: flex-start; gap: 12px; }
    .column.split { width: 232px; }
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
  <div class="column">${reply('wide')}</div>
  <div class="column split">${reply('split')}</div>
  <div class="column">${codeBlocks('wide')}</div>
  <div class="column split">${codeBlocks('split')}</div>
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
  // Every word in a reply that got broken across lines although it would have
  // fitted on a line of the reply's own width. A word is measured on its own,
  // in its own font, against a ruler — not against the box it was squeezed
  // into, because that box's width is the thing under test: an overflow-wrap of
  // "anywhere" collapses a table column to one character, and then every word
  // in it "didn't fit". A 220-character token, genuinely wider than the reply, is
  // excluded — it has nowhere to fit and breaking it is the point.
  const shredded = (rootId) => {
    const root = document.getElementById(rootId)
    const ruler = document.createElement('span')
    ruler.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:pre;visibility:hidden'
    document.body.appendChild(ruler)
    const rs = cs(root)
    const reply = root.clientWidth - parseFloat(rs.paddingLeft) - parseFloat(rs.paddingRight)
    const out = []
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const parent = n.parentElement
      if (!parent) continue
      const ps = cs(parent)
      for (const p of ['fontStyle','fontVariant','fontWeight','fontStretch','fontSize','fontFamily','letterSpacing','wordSpacing','textTransform'])
        ruler.style[p] = ps[p]
      for (const m of n.nodeValue.matchAll(/\\S+/g)) {
        const range = document.createRange()
        range.setStart(n, m.index)
        range.setEnd(n, m.index + m[0].length)
        // Distinct line tops, not rect count: font fallback splits one line of
        // "🔎 name" into several rects without breaking anything.
        const tops = new Set([...range.getClientRects()].map((r) => Math.round(r.top)))
        if (tops.size < 2) continue
        ruler.textContent = m[0]
        const needs = ruler.getBoundingClientRect().width
        if (needs <= reply + 0.5)
          out.push({ word: m[0].slice(0, 20), needs: +needs.toFixed(1), reply: +reply.toFixed(1), lines: tops.size, where: parent.tagName.toLowerCase() })
      }
    }
    ruler.remove()
    return out
  }
  const flow = (id) => {
    const el = document.getElementById(id)
    return el ? { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth } : null
  }
  // Every visual row of a <pre>, reconstructed a character at a time from its
  // line boxes: what is ON each row, and where the row's right edge falls. This
  // is the only way to see a fold — the DOM holds one string either way, and
  // where the browser chose to break it exists only in the layout.
  const folded = (id) => {
    const pre = document.getElementById(id)
    const code = pre.querySelector('code')
    const node = code.firstChild
    const text = node.nodeValue
    const rows = []
    let cur = null
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\\n') { cur = null; continue }
      const r = document.createRange()
      r.setStart(node, i)
      r.setEnd(node, i + 1)
      const rect = r.getBoundingClientRect()
      const top = Math.round(rect.top)
      if (!cur || cur.top !== top) { cur = { top, text: '', right: 0 }; rows.push(cur) }
      cur.text += text[i]
      cur.right = Math.max(cur.right, rect.right)
    }
    const s = cs(pre)
    const box = pre.getBoundingClientRect()
    // One character's advance, measured not assumed. A row is "flush" — cut by
    // the edge rather than ended by the string — when not even one more
    // character would have fitted after it.
    const probe = document.createRange()
    probe.setStart(node, 0)
    probe.setEnd(node, 1)
    const charWidth = probe.getBoundingClientRect().width
    const contentWidth = pre.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight)
    // The shredded-word rule of round 8, measured against the box that is
    // actually fixed here: a <pre>'s own content width. A word broken across
    // rows that would have fitted a row of this block on its own was broken
    // when it did not have to be.
    const ruler = document.createElement('span')
    const ps = cs(code)
    ruler.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:pre;visibility:hidden'
    for (const p of ['fontStyle','fontVariant','fontWeight','fontStretch','fontSize','fontFamily','letterSpacing','wordSpacing'])
      ruler.style[p] = ps[p]
    document.body.appendChild(ruler)
    const shreddedWords = []
    for (const m of text.matchAll(/\\S+/g)) {
      const r = document.createRange()
      r.setStart(node, m.index)
      r.setEnd(node, m.index + m[0].length)
      const tops = new Set([...r.getClientRects()].map((x) => Math.round(x.top)))
      if (tops.size < 2) continue
      ruler.textContent = m[0]
      const needs = ruler.getBoundingClientRect().width
      if (needs <= contentWidth + 0.5)
        shreddedWords.push({ word: m[0].slice(0, 24), needs: +needs.toFixed(1), fits: +contentWidth.toFixed(1) })
    }
    ruler.remove()
    // What a reader copies, both ways in: the header button reads textContent;
    // a drag across the block yields Selection.toString().
    const sel = window.getSelection()
    sel.removeAllRanges()
    const range = document.createRange()
    range.selectNodeContents(code)
    sel.addRange(range)
    const selection = sel.toString()
    sel.removeAllRanges()
    const contentRight = box.right - parseFloat(s.paddingRight) - parseFloat(s.borderRightWidth)
    return {
      rows: rows.map((r) => ({
        len: r.text.length,
        last: r.text.slice(-1),
        // Trailing whitespace hangs past the content edge at a soft wrap, so a
        // row can measure wider than the box; clamp rather than let that read
        // as "flush by a mile".
        gap: +Math.max(0, contentRight - r.right).toFixed(1)
      })),
      charWidth: +charWidth.toFixed(2),
      shredded: shreddedWords,
      rejoined: rows.map((r) => r.text).join('') === text.replace(/\\n/g, ''),
      textContent: code.textContent,
      selection,
      scrollWidth: pre.scrollWidth,
      clientWidth: pre.clientWidth
    }
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
    bubbleFlow: flow('bubble'),
    userBubbleFlow: flow('user-bubble'),
    docScrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    codeScrollWidth: pre.scrollWidth,
    codeClientWidth: pre.clientWidth,
    wrappedScrollWidth: wrapped ? wrapped.scrollWidth : -1,
    wrappedClientWidth: wrapped ? wrapped.clientWidth : -1,
    wrappedLines: wrapped ? wrapped.querySelector('code').getClientRects().length : 0,
    replies: ['wide', 'split'].map((w) => ({
      width: w,
      shredded: shredded(w),
      bubble: flow(w),
      citations: flow('cites-' + w),
      tokenTable: flow('tokentable-' + w),
      passageLines: new Set(
        [...document.getElementById('th-passage-' + w).getClientRects()].map((r) => Math.round(r.top))
      ).size
    })),
    codes: ['wide', 'split'].map((w) => ({
      width: w,
      fold: folded('fold-' + w),
      control: folded('ctl-' + w),
      ordinary: folded('wrapcode-' + w)
    })),
    // Is the control that already solves this perfectly actually findable? It
    // is only an answer if it is legible without hovering.
    codeChrome: (() => {
      const btn = document.querySelector('.code-copy-btn')
      if (!btn) return null
      const r = btn.getBoundingClientRect()
      return {
        label: btn.textContent,
        color: cs(btn).color,
        headerBg: cs(btn.closest('.code-header')).backgroundColor,
        blockBg: cs(btn.closest('.code-block')).backgroundColor,
        width: +r.width.toFixed(1),
        height: +r.height.toFixed(1)
      }
    })(),
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

interface Flow {
  scrollWidth: number
  clientWidth: number
}

interface Shred {
  word: string
  needs: number
  reply: number
  lines: number
  where: string
}

interface Folded {
  rows: { len: number; last: string; gap: number }[]
  charWidth: number
  shredded: { word: string; needs: number; fits: number }[]
  rejoined: boolean
  textContent: string
  selection: string
  scrollWidth: number
  clientWidth: number
}

interface CodeProbe {
  width: string
  fold: Folded
  control: Folded
  ordinary: Folded
}

interface ReplyProbe {
  width: string
  shredded: Shred[]
  bubble: Flow
  citations: Flow
  tokenTable: Flow
  passageLines: number
}

interface CodeChrome {
  label: string
  color: string
  headerBg: string
  blockBg: string
  width: number
  height: number
}

interface Probe {
  reply: Spill
  replyText: Spill
  userMessage: Spill
  bubbleFlow: Flow
  userBubbleFlow: Flow
  docScrollWidth: number
  viewportWidth: number
  codeScrollWidth: number
  codeClientWidth: number
  wrappedScrollWidth: number
  wrappedClientWidth: number
  wrappedLines: number
  replies: ReplyProbe[]
  codes: CodeProbe[]
  codeChrome: CodeChrome | null
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
  // VC1's own mechanical check, which the harness had never carried: an
  // overhang of 0 says no line hangs past the edge, and says nothing about a
  // descendant that is wider than the box. scrollWidth does.
  for (const [where, f] of [
    ['reply', light.bubbleFlow],
    ['user message', light.userBubbleFlow]
  ] as const)
    check(
      `${where}: the bubble itself does not scroll sideways`,
      f.scrollWidth <= f.clientWidth + 1,
      `scrollWidth ${f.scrollWidth} vs clientWidth ${f.clientWidth}`
    )
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

  /* -- (a2) …without shredding the words around it -------------------------- */

  // The rule that stopped the blowout was `overflow-wrap: anywhere`, and
  // `anywhere` is `break-word` plus one extra effect: the break counts toward
  // min-content, so a box sized by its own contents can collapse to one
  // character. In a table column sized against a 3-character `[1]` cell that
  // turned the header `Passage` into "Pas / sag / e" — the reply's structured
  // evidence was the one part of it a reader could not read. Both properties
  // are asserted together here because they are the same property: the token
  // must still be contained, and no word that could have fitted may be broken.
  console.log('\nand the words around it are not shredded to make room')
  check(
    'the renderer wraps tables in a scroll container the stylesheet knows about',
    TABLE_SCROLL !== '' && cssSrc.includes(`.${TABLE_SCROLL}`),
    `renderer: ${TABLE_SCROLL || 'MISSING'}; stylesheet: ${TABLE_SCROLL && cssSrc.includes(`.${TABLE_SCROLL}`) ? 'ok' : 'no rule'}`
  )
  for (const r of light.replies) {
    const label = r.width === 'split' ? 'split view' : '420px column'
    check(
      `${label}: no word is broken across lines that would have fitted the reply`,
      r.shredded.length === 0,
      r.shredded
        .slice(0, 6)
        .map((s) => `"${s.word}" over ${s.lines} lines (needs ${s.needs}px of ${s.reply}px)`)
        .join(', ')
    )
    check(
      `${label}: the table header "Passage" is one word on one line`,
      r.passageLines === 1,
      `${r.passageLines} lines`
    )
    // The true negative for the rule above: a 220-character token in a table
    // cell has no break opportunity a word-preserving rule may take, so the
    // table genuinely cannot fit. It scrolls — inside its own container.
    check(
      `${label}: a table too wide to fit scrolls inside its own container`,
      r.tokenTable.scrollWidth > r.tokenTable.clientWidth + 1,
      `${r.tokenTable.scrollWidth} vs ${r.tokenTable.clientWidth}`
    )
    check(
      `${label}: and the bubble holding it does not scroll sideways`,
      r.bubble.scrollWidth <= r.bubble.clientWidth + 1,
      `bubble ${r.bubble.scrollWidth} vs ${r.bubble.clientWidth}, citations table ${r.citations.scrollWidth} vs ${r.citations.clientWidth}`
    )
  }

  /* -- (a3) …and the fold is not mistakable for the token's own punctuation -- */

  // Round 8 got the token inside the column. WHERE it broke it was the cost: a
  // hyphen is a break opportunity, so every folded row ended in a real `-`, and
  // print has trained every reader that an end-of-line hyphen was inserted by
  // the renderer and comes out when the lines are rejoined. On a task whose
  // whole request is "repeat it back so I can copy it", that is the string
  // losing characters between the screen and the reader's hand.
  console.log('\nand a fold in that token cannot be read as one of its own characters')
  check(
    'the stylesheet defines a fold state and the renderer sets it',
    FOLD_STATE !== '' && markdownSrc.includes(FOLD_STATE),
    `stylesheet: ${FOLD_STATE || 'MISSING'}; renderer: ${FOLD_STATE && markdownSrc.includes(FOLD_STATE) ? 'ok' : 'never emitted'}`
  )
  check(
    'the fixture token is the hyphenated shape that made the fold ambiguous',
    HYPHEN_TOKEN.length >= 200 && HYPHEN_TOKEN.split('-').length > 30,
    `${HYPHEN_TOKEN.length} chars, ${HYPHEN_TOKEN.split('-').length - 1} hyphens`
  )
  // A row is CUT if not even one more character could have followed it — its
  // text runs into the block's right padding. A row that ENDS stops short. That
  // difference is the only thing in the rendering that tells a reader whether a
  // row ended because the string did, and it is what makes the last character
  // of the row readable rather than a guess.
  const ends = (f: Folded): { last: string; gap: number }[] =>
    f.rows.slice(0, -1).filter((r) => r.gap >= f.charWidth)
  // The defect itself, counted: a fold that ends in a hyphen AND stops short of
  // the edge is indistinguishable from a hyphenated line break, and a reader
  // rejoining the lines by eye deletes the hyphen. Either half alone is
  // harmless — a hyphen on a row visibly cut by the edge is plainly content,
  // and a row that stops short on any other character claims nothing.
  const ambiguous = (f: Folded): { last: string; gap: number }[] =>
    ends(f).filter((r) => r.last === '-')

  for (const c of light.codes) {
    const label = c.width === 'split' ? 'split view' : '420px column'
    const f = c.fold
    const folds = f.rows.length - 1
    check(`${label}: the token folds at all`, folds >= 1, `${f.rows.length} row(s)`)
    check(
      `${label}: no fold reads as a hyphenation a reader would undo`,
      ambiguous(f).length === 0,
      `${ambiguous(f).length} of ${folds}: ${ambiguous(f).map((r) => `"-" +${r.gap}px`).join(', ')}`
    )
    check(
      `${label}: every fold is cut at the edge, which is what makes that true`,
      ends(f).length === 0,
      `${ends(f).length} of ${folds} folds stop short: ${ends(f).map((r) => `"${r.last}" +${r.gap}px`).join(', ')}`
    )
    // The control, in the same fixture, at the same width: the same token under
    // round 8's rule alone. Every fold lands on a hyphen there — the token's
    // only break opportunities are its hyphens — and the ones that also stop
    // short of the edge are the defect, in the count the fix has to move.
    const ctl = c.control
    const ctlFolds = ctl.rows.length - 1
    const ctlHyphen = ctl.rows.slice(0, -1).filter((r) => r.last === '-')
    check(
      `${label}: (control) under the wrap rule alone every fold lands on a hyphen`,
      ctlFolds >= 1 && ctlHyphen.length === ctlFolds,
      `${ctlHyphen.length} of ${ctlFolds}`
    )
    check(
      `${label}: (control) …and some of them read as hyphenation — there is a defect to move`,
      ambiguous(ctl).length > 0,
      `${ambiguous(ctl).length} of ${ctlFolds} — nothing for the fix to move`
    )
    console.log(
      `       folds ${folds}, reading as hyphenation ${ambiguous(f).length}` +
        `   —   control ${ctlFolds} folds, ${ambiguous(ctl).length} reading as hyphenation`
    )
    check(
      `${label}: the folded token still fits its block`,
      f.scrollWidth <= f.clientWidth + 1,
      `scrollWidth ${f.scrollWidth} vs clientWidth ${f.clientWidth}`
    )
    // The whole point: whatever the rendering does, neither copy path may
    // contain the fold. The header button reads textContent; a drag reads the
    // selection. Both must be the string the model emitted.
    check(
      `${label}: the Copy button's source is the token, unfolded and unaltered`,
      f.textContent === HYPHEN_TOKEN,
      `${f.textContent.length} chars vs ${HYPHEN_TOKEN.length}`
    )
    check(
      `${label}: selecting the block and copying yields exactly the same string`,
      f.selection === HYPHEN_TOKEN,
      `${f.selection.length} chars, ${f.selection === f.textContent ? 'equal to textContent' : 'DIFFERS from textContent'}`
    )
    check(
      `${label}: and the rows on screen rejoin to it with nothing added or lost`,
      f.rejoined,
      'visual rows do not rejoin to the DOM text'
    )
    // The true negative that keeps this rule off ordinary code. Cutting at the
    // edge breaks an identifier that would have fitted a row of its own —
    // round 8's shredding, inside a code block. A reader who pressed Wrap on
    // real code wants to read it, so that block keeps the word-preserving rule.
    const o = c.ordinary
    check(
      `${label}: ordinary wrapped code has no word broken that would have fitted a row`,
      o.shredded.length === 0,
      o.shredded.map((s) => `"${s.word}" needs ${s.needs}px of ${s.fits}px`).join(', ')
    )
    check(
      `${label}: …and the fold rule did not reach it`,
      o.rows.length > 1 && ends(o).length > 0,
      `${ends(o).length} of ${o.rows.length - 1} rows stop short`
    )
    check(
      `${label}: …and it too fits its block and copies back verbatim`,
      o.scrollWidth <= o.clientWidth + 1 &&
        o.textContent === ORDINARY_CODE &&
        o.selection === ORDINARY_CODE,
      `${o.scrollWidth} vs ${o.clientWidth}; textContent ${o.textContent === ORDINARY_CODE ? 'ok' : 'DIFFERS'}; selection ${o.selection === ORDINARY_CODE ? 'ok' : 'DIFFERS'}`
    )
  }

  // …and the control that answers this perfectly, if the reader can find it.
  console.log('\nthe Copy control, which is the exact answer if it is findable')
  const chrome = light.codeChrome
  check('the code header carries a Copy control', chrome !== null && chrome.label === 'Copy', chrome?.label ?? 'absent')
  if (chrome) {
    const headerOverBlock = over(parseColor(chrome.headerBg), parseColor(chrome.blockBg))
    const ratio = contrast(parseColor(chrome.color), headerOverBlock)
    check(
      'its label clears 4.5:1 on the header it sits on, with no hover needed',
      ratio >= 4.5,
      `${ratio.toFixed(2)}:1 (${chrome.color} on ${chrome.headerBg} over ${chrome.blockBg})`
    )
    console.log(`       Copy: ${chrome.width}×${chrome.height}px, ${ratio.toFixed(2)}:1, always rendered`)
  }

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
