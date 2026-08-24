/**
 * Head-to-head capture harness — one task, one arm, one run directory.
 *
 * Drives the *shipped* app the way a person does: boots it on a throwaway
 * userData dir with a CDP port, types the task into the composer, presses
 * Enter, and records what the screen actually showed — not what the internals
 * think happened. Nothing is read out of React state or the store; every text
 * artifact in the run directory comes from `innerText` on the live transcript,
 * so a collapsed disclosure is captured as collapsed, exactly as the user saw
 * it. (A second, expanded copy is captured afterwards for the reader who wants
 * to see inside the blocks.)
 *
 * Timing honesty. Every timestamp is taken *inside the page* by an injected
 * sampler, never by the driver. CDP round-trips, screenshot stalls and the
 * driver's own poll interval therefore cannot inflate the numbers. The three
 * moments recorded are:
 *   - send            t0, taken in the same evaluate that dispatches Enter
 *   - first visible   first non-empty assistant content on screen (prose, or a
 *                     tool/plan/reasoning block appearing), not the empty
 *                     bubble chrome that renders the instant the turn starts
 *   - turn end        the composer's streaming state clearing, i.e. the moment
 *                     Stop turns back into Send
 * Detection reads `textContent` (no forced layout) so the sampler does not
 * perturb the render loop it is measuring. Sampling resolution is 20 ms plus a
 * MutationObserver, and the resolution is restated in run.json rather than
 * being left for the reader to assume.
 *
 * Blind-readable output. The run directory carries no version, no arm name and
 * no product name: a critic is meant to read it without knowing which system
 * produced it. Everything identifying goes into sidecar files whose names start
 * with `_`, which the critic does not open. Screenshots are the unavoidable
 * exception — a picture of a UI shows whose UI it is.
 *
 * Run:  bash scripts/h2h-capture.sh --model <id> --task-id <id> --prompt "..."
 */

import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { get as httpGet } from 'http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

/* ------------------------------------------------------------------ types */

/** Minimal shape of the WHATWG WebSocket, which @types/node 20 does not declare. */
interface Sock {
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onclose: (() => void) | null
  onerror: ((e: unknown) => void) | null
  onmessage: ((e: { data: string }) => void) | null
}
declare const WebSocket: { new (url: string): Sock }

interface Args {
  model: string
  taskId: string
  prompt: string
  outRoot: string
  arm: string
  port: number
  timeoutMs: number
  bootTimeoutMs: number
  midEveryMs: number
  maxMidShots: number
  keepUserData: boolean
}

/** What the injected sampler reports back. All times are page `Date.now()`. */
interface PageState {
  t0: number | null
  tUserBubble: number | null
  tAssistantContainer: number | null
  tFirstVisible: number | null
  firstVisibleKind: string | null
  tStreamStart: number | null
  tEnd: number | null
  endReason: string | null
  sawStreaming: boolean
  live: boolean
  rootFound: boolean
  sampleMs: number
}

interface CapturedBlock {
  kind: string
  header: string
  text: string
}

interface CapturedMessage {
  index: number
  role: 'user' | 'assistant' | 'note'
  text: string
  prose: string[]
  blocks: CapturedBlock[]
  citations: string[]
  redText: string[]
}

interface Capture {
  rootFound: boolean
  transcript: string
  messages: CapturedMessage[]
  errors: string[]
  viewport: { w: number; h: number; dpr: number }
}

interface ShotRecord {
  file: string
  phase: 'mid' | 'turn-end' | 'turn-end-expanded'
  atMsFromSend: number | null
  bytes: number
}

/* ------------------------------------------------------------------- args */

const USAGE = `usage: bash scripts/h2h-capture.sh --model <id> --task-id <id> (--prompt <text> | --prompt-file <path>) [options]

  --model <id>          model id to run the turn on (must be loaded in LM Studio)
  --task-id <id>        short slug naming the task; names the run directory
  --prompt <text>       the task prompt, typed into the composer verbatim
  --prompt-file <path>  read the prompt from a file instead
  --arm <name>          arm label; written ONLY to the sidecar (default: unlabeled)
  --out <dir>           run-directory root (default: .h2h-runs)
  --port <n>            CDP port (default: 9333)
  --timeout <ms>        give up on the turn after this long (default: 300000)
  --boot-timeout <ms>   give up on app boot after this long (default: 60000)
  --mid-every <ms>      spacing between mid-turn screenshots (default: 8000)
  --max-mid <n>         cap on mid-turn screenshots (default: 3)
  --keep-userdata       do not delete the throwaway userData dir afterwards
`

function parseArgs(argv: string[]): Args {
  const a: Record<string, string> = {}
  const flags = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (!t.startsWith('--')) continue
    const key = t.slice(2)
    if (key === 'keep-userdata' || key === 'help') {
      flags.add(key)
      continue
    }
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`--${key} needs a value`)
    a[key] = v
    i++
  }
  if (flags.has('help') || argv.length === 0) {
    process.stdout.write(USAGE)
    process.exit(0)
  }

  const prompt = a['prompt-file']
    ? readFileSync(resolve(a['prompt-file']), 'utf8').replace(/\s+$/, '')
    : (a.prompt ?? '')
  const missing: string[] = []
  if (!a.model) missing.push('--model')
  if (!a['task-id']) missing.push('--task-id')
  if (!prompt.trim()) missing.push('--prompt or --prompt-file')
  if (missing.length) {
    process.stderr.write(`error: missing ${missing.join(', ')}\n\n${USAGE}`)
    process.exit(2)
  }

  const num = (k: string, d: number): number => {
    const v = Number(a[k])
    return Number.isFinite(v) && v > 0 ? v : d
  }
  return {
    model: a.model,
    taskId: a['task-id'],
    prompt,
    outRoot: resolve(a.out ?? '.h2h-runs'),
    arm: a.arm ?? 'unlabeled',
    port: num('port', 9333),
    timeoutMs: num('timeout', 300_000),
    bootTimeoutMs: num('boot-timeout', 60_000),
    midEveryMs: num('mid-every', 8000),
    maxMidShots: num('max-mid', 3),
    keepUserData: flags.has('keep-userdata')
  }
}

/* --------------------------------------------------------- injected page code */

/**
 * The in-page sampler. Installed before the prompt is sent; it owns every
 * timestamp the run reports.
 *
 * Two things matter here. First, detection uses `textContent`, not `innerText`:
 * `innerText` forces a synchronous layout, and running that on every streamed
 * token would slow the very render we are timing. Second, the MutationObserver
 * is disconnected the moment first-visible-content is found, after which the
 * cheap 20 ms interval alone carries the run to turn end.
 */
const INSTRUMENT = String.raw`(() => {
  if (window.__h2h) return 'already-installed'
  var H = {
    t0: null, tUserBubble: null, tAssistantContainer: null,
    tFirstVisible: null, firstVisibleKind: null,
    tStreamStart: null, tEnd: null, endReason: null,
    sawStreaming: false, live: false, rootFound: false,
    sampleMs: 20, prompt: null
  }
  window.__h2h = H

  function clsOf(el) { return typeof el.className === 'string' ? el.className : '' }
  function hasCls(el, sub) { return clsOf(el).indexOf(sub) !== -1 }

  // A chat bubble is identified by its one asymmetric corner: the user's bubble
  // squares off bottom-right, the reply's squares off top-left. Those two class
  // fragments occur nowhere else in the app, which makes them a far safer
  // anchor than "the scrollable box containing the prompt" — the sidebar also
  // contains the prompt, as its conversation title.
  var USER_MARK = 'rounded-br-md'
  var REPLY_MARK = 'rounded-tl-md'

  // Bubbles sit two or three levels below a transcript row; a bounded search
  // keeps this cheap enough to run on every streamed token.
  function findMark(el, sub, maxDepth) {
    if (hasCls(el, sub)) return el
    var frontier = [el], depth = 0
    while (frontier.length && depth < maxDepth) {
      var next = []
      for (var i = 0; i < frontier.length; i++) {
        var kids = frontier[i].children
        for (var j = 0; j < kids.length; j++) {
          if (hasCls(kids[j], sub)) return kids[j]
          next.push(kids[j])
        }
      }
      frontier = next
      depth++
    }
    return null
  }

  var root = null
  function climbToScroller(el) {
    var n = el.parentElement
    while (n && n !== document.body) {
      var oy = getComputedStyle(n).overflowY
      if ((oy === 'auto' || oy === 'scroll') && n.clientHeight > 120) return n
      n = n.parentElement
    }
    return null
  }
  function resolveRoot() {
    if (root && root.isConnected) return root
    var needle = H.prompt ? H.prompt.slice(0, 40) : null
    var all = document.querySelectorAll('div'), anchor = null, fallback = null
    for (var i = 0; i < all.length; i++) {
      var el = all[i]
      if (hasCls(el, USER_MARK) && needle && (el.textContent || '').indexOf(needle) !== -1) { anchor = el; break }
      if (!fallback && hasCls(el, REPLY_MARK)) fallback = el
    }
    var a = anchor || fallback
    if (!a) return null
    var s = climbToScroller(a)
    if (s) { root = s; H.rootFound = true }
    return root
  }
  H.getRoot = resolveRoot

  function classify(el) {
    if (findMark(el, USER_MARK, 4)) return 'user'
    if (findMark(el, REPLY_MARK, 4)) return 'assistant'
    return 'note'
  }
  H.classify = classify

  function blockNodes(el) {
    var out = []
    var divs = el.querySelectorAll('div')
    for (var i = 0; i < divs.length; i++) {
      if (hasCls(divs[i], 'my-2') && hasCls(divs[i], 'rounded-2xl')) out.push(divs[i])
    }
    return out
  }
  H.blockNodes = blockNodes
  H.hasCls = hasCls

  var mo = null
  function tick() {
    if (H.t0 === null) return
    var now = Date.now()
    var r = resolveRoot()
    if (!r) return
    if (H.tUserBubble === null) H.tUserBubble = now

    var a = (H._a && H._a.isConnected) ? H._a : null
    if (!a) {
      var kids = r.children
      for (var i = kids.length - 1; i >= 0; i--) {
        if (classify(kids[i]) === 'assistant') { a = kids[i]; H._a = a; break }
      }
    }
    if (a) {
      if (H.tAssistantContainer === null) H.tAssistantContainer = now
      if (H.tFirstVisible === null) {
        // textContent, deliberately: no layout flush on the streaming path.
        var prose = '', pn = a.querySelectorAll('.markdown-body')
        for (var j = 0; j < pn.length; j++) prose += (pn[j].textContent || '')
        if (prose.trim().length > 0) { H.tFirstVisible = now; H.firstVisibleKind = 'prose' }
        else if (blockNodes(a).length > 0) { H.tFirstVisible = now; H.firstVisibleKind = 'block' }
      }
    }

    // The composer carries a 'composer-live' class for exactly as long as the
    // app considers itself streaming — the same state that renders Stop instead
    // of Send. That is the user-visible definition of "the turn is running".
    var live = !!document.querySelector('.composer-live')
    H.live = live
    if (live) { H.sawStreaming = true; if (H.tStreamStart === null) H.tStreamStart = now }
    if (H.tEnd === null && H.sawStreaming && !live) { H.tEnd = now; H.endReason = 'composer-idle' }

    if (H.tFirstVisible !== null && mo) { mo.disconnect(); mo = null }
  }

  mo = new MutationObserver(tick)
  mo.observe(document.body, { childList: true, subtree: true, characterData: true })
  var iv = setInterval(tick, H.sampleMs)
  H.stop = function () { if (mo) mo.disconnect(); clearInterval(iv) }
  return 'installed'
})()`

/** Reads the sampler's clock back. Cheap; safe to call on a poll. */
const READ_STATE = String.raw`(() => {
  var H = window.__h2h
  if (!H) return JSON.stringify({ missing: true })
  return JSON.stringify({
    t0: H.t0, tUserBubble: H.tUserBubble, tAssistantContainer: H.tAssistantContainer,
    tFirstVisible: H.tFirstVisible, firstVisibleKind: H.firstVisibleKind,
    tStreamStart: H.tStreamStart, tEnd: H.tEnd, endReason: H.endReason,
    sawStreaming: H.sawStreaming, live: H.live, rootFound: H.rootFound, sampleMs: H.sampleMs
  })
})()`

/**
 * Reads the transcript as the user sees it.
 *
 * `innerText` throughout, on purpose: it returns rendered, visible text, so a
 * collapsed tool block contributes its header and nothing else — which is what
 * was on screen. Class *substrings* are matched by hand rather than by CSS
 * selectors because the app's utility classes contain slashes and brackets that
 * would need escaping, and a mis-escaped selector fails silently.
 */
const CAPTURE = String.raw`(() => {
  var H = window.__h2h
  var out = { rootFound: false, transcript: '', messages: [], errors: [],
              viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio } }
  if (!H) return JSON.stringify(out)
  var root = H.getRoot()
  if (!root) return JSON.stringify(out)
  out.rootFound = true
  out.transcript = root.innerText || ''

  function descBy(el, sub) {
    var all = el.querySelectorAll('*'), hit = []
    for (var i = 0; i < all.length; i++) if (H.hasCls(all[i], sub)) hit.push(all[i])
    // Keep only outermost matches, so a nested wrapper is not reported twice.
    return hit.filter(function (n) { return !hit.some(function (m) { return m !== n && m.contains(n) }) })
  }
  function kindOf(header) {
    var h = (header || '').trim()
    if (h.indexOf('\u{1F4AD}') !== -1) return 'reasoning'
    if (h.indexOf('\u{1F9EA}') !== -1) return 'claim-check'
    if (h.indexOf('\u{1F50D}') !== -1) return 'second-opinion'
    if (h.indexOf('⚡') !== -1) return 'ran-code'
    if (/awaiting approval|^Plan\b|step/i.test(h)) return 'plan'
    return 'tool-call'
  }

  var kids = root.children
  for (var i = 0; i < kids.length; i++) {
    var child = kids[i]
    var text = (child.innerText || '').trim()
    var role = H.classify(child)
    if (!text && role === 'note') continue

    var blocks = H.blockNodes(child).map(function (n) {
      var head = n.firstElementChild ? (n.firstElementChild.innerText || '').trim() : ''
      return { kind: kindOf(head), header: head, text: (n.innerText || '').trim() }
    })
    var proseNodes = child.querySelectorAll('.markdown-body')
    var prose = []
    for (var p = 0; p < proseNodes.length; p++) {
      var t = (proseNodes[p].innerText || '').trim()
      if (t) prose.push(t)
    }
    var citations = descBy(child, 'border-amber-500/30').map(function (n) { return (n.innerText || '').trim() }).filter(Boolean)
    var reds = descBy(child, 'text-red-').map(function (n) { return (n.innerText || '').trim() }).filter(Boolean)

    out.messages.push({ index: i, role: role, text: text, prose: prose, blocks: blocks, citations: citations, redText: reds })
    for (var e = 0; e < reds.length; e++) out.errors.push(reds[e])
  }
  return JSON.stringify(out)
})()`

/**
 * Opens every collapsed disclosure. Only buttons carrying the app's collapsed
 * caret (▸) are clicked — Approve/Reject, Regenerate and Branch never carry it,
 * so nothing with a side effect can be triggered by this sweep.
 */
const EXPAND = String.raw`(async () => {
  // Each button is clicked at most once, ever. React repaints the caret one
  // frame later, so a same-tick second pass would still see ▸ and toggle the
  // section shut again — an even number of clicks leaves everything closed.
  var seen = new Set(), clicked = 0
  for (var pass = 0; pass < 8; pass++) {
    var btns = document.querySelectorAll('button'), any = false
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i]
      if (seen.has(b) || (b.textContent || '').indexOf('▸') === -1) continue
      seen.add(b); b.click(); clicked++; any = true
    }
    if (!any) break
    await new Promise(function (r) { setTimeout(r, 250) })
  }
  return String(clicked)
})()`

/* ------------------------------------------------------------- cdp client */

interface CdpEvent {
  method: string
  params: unknown
}

class Cdp {
  private ws: Sock | null = null
  private nextId = 0
  private pending = new Map<number, (r: unknown) => void>()
  readonly events: CdpEvent[] = []

  async connect(wsUrl: string): Promise<void> {
    const ws = new WebSocket(wsUrl)
    this.ws = ws
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res()
      ws.onerror = (e) => rej(new Error(`CDP websocket failed: ${String(e)}`))
    })
    ws.onmessage = (ev): void => {
      const msg = JSON.parse(ev.data) as { id?: number; result?: unknown; error?: unknown } & CdpEvent
      if (typeof msg.id === 'number') {
        const done = this.pending.get(msg.id)
        if (done) {
          this.pending.delete(msg.id)
          done(msg.error ? { __cdpError: msg.error } : msg.result)
        }
        return
      }
      if (msg.method) this.events.push({ method: msg.method, params: msg.params })
    }
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const ws = this.ws
    if (!ws) throw new Error('CDP not connected')
    const id = ++this.nextId
    return new Promise<T>((res) => {
      this.pending.set(id, (r) => res(r as T))
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Evaluates an expression and returns its (string) value, or throws on a page exception. */
  async evalString(expression: string): Promise<string> {
    const r = await this.send<{
      result?: { value?: unknown }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
      __cdpError?: { message?: string }
    }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.__cdpError) throw new Error(`CDP error: ${r.__cdpError.message ?? 'unknown'}`)
    if (r.exceptionDetails) {
      throw new Error(
        `page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'unknown'}`
      )
    }
    return String(r.result?.value ?? '')
  }

  close(): void {
    try {
      this.ws?.close()
    } catch {
      /* already gone */
    }
  }
}

/* ---------------------------------------------------------------- helpers */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function fetchJson(url: string, timeoutMs = 2000): Promise<unknown> {
  return new Promise((res, rej) => {
    const req = httpGet(url, (r) => {
      let body = ''
      r.on('data', (c) => (body += c))
      r.on('end', () => {
        try {
          res(JSON.parse(body))
        } catch (e) {
          rej(e)
        }
      })
    })
    req.on('error', rej)
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'))
    })
  })
}

interface Target {
  type: string
  url: string
  webSocketDebuggerUrl?: string
}

/** Picks the page target that actually has the app's composer in it. */
async function findAppTarget(port: number, deadline: number): Promise<Target> {
  let lastErr = 'no page target'
  while (Date.now() < deadline) {
    try {
      const list = (await fetchJson(`http://127.0.0.1:${port}/json/list`)) as Target[]
      const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      for (const p of pages) {
        const probe = new Cdp()
        try {
          await probe.connect(p.webSocketDebuggerUrl as string)
          const ok = await probe.evalString(
            `String(!!document.querySelector('textarea') && document.readyState === 'complete')`
          )
          if (ok === 'true') {
            probe.close()
            return p
          }
          lastErr = 'app window found but composer not ready'
        } catch (e) {
          lastErr = e instanceof Error ? e.message : String(e)
        } finally {
          probe.close()
        }
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
    await sleep(250)
  }
  throw new Error(`app never became drivable on port ${port}: ${lastErr}`)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function stamp(d: Date): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

/* ------------------------------------------------------------------- main */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const repoRoot = resolve(__dirname, '..', '..')
  const mainEntry = join(repoRoot, 'out', 'main', 'index.js')
  if (!existsSync(mainEntry)) {
    throw new Error(`no build at ${mainEntry} — run: node node_modules/electron-vite/bin/electron-vite.js build`)
  }
  const electron = ['node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', 'node_modules/electron/dist/electron']
    .map((p) => join(repoRoot, p))
    .find((p) => existsSync(p))
  if (!electron) throw new Error("no bundled Electron runtime found — run 'npm install'")

  const startedAt = new Date()
  const runDir = join(args.outRoot, `${args.taskId}-${stamp(startedAt)}`)
  mkdirSync(runDir, { recursive: true })
  const shotsDir = join(runDir, 'screenshots')
  mkdirSync(shotsDir, { recursive: true })

  // Throwaway userData. Never the real profile: the harness must not read the
  // user's conversations and must not leave anything behind in them.
  const userData = join(runDir, '_userdata')
  mkdirSync(userData, { recursive: true })
  const seededConfig = {
    settings: {
      baseUrl: 'http://127.0.0.1:1234/v1',
      onboardingCompleted: true,
      models: [
        { id: 'model-1', modelId: args.model, roleName: 'Assistant', color: 'blue', enabled: true }
      ]
    }
  }
  writeFileSync(join(userData, 'config.json'), JSON.stringify(seededConfig, null, 2))

  // Launcher shim: redirect userData before the real main process reads it, and
  // keep the window on top so the compositor keeps painting it (an occluded
  // window returns a stale or empty frame to Page.captureScreenshot).
  const shim = join(runDir, '_launcher.js')
  writeFileSync(
    shim,
    [
      "const { app } = require('electron')",
      "app.setPath('userData', process.env.OASIS_H2H_USERDATA)",
      "app.on('browser-window-created', (_e, w) => { try { w.setAlwaysOnTop(true) } catch {} })",
      'require(process.env.OASIS_H2H_MAIN)',
      ''
    ].join('\n')
  )

  const notes: string[] = []
  const shots: ShotRecord[] = []
  let child: ChildProcess | null = null
  let cdp: Cdp | null = null
  const appLog: string[] = []

  const shutdown = async (): Promise<void> => {
    cdp?.close()
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100)
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  }

  try {
    const argv = [shim, `--remote-debugging-port=${args.port}`, '--remote-allow-origins=*']
    const env = { ...process.env, OASIS_H2H_USERDATA: userData, OASIS_H2H_MAIN: mainEntry }
    delete (env as Record<string, string | undefined>).ELECTRON_RUN_AS_NODE
    child = spawn(electron, argv, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout?.on('data', (d) => appLog.push(`[out] ${String(d)}`))
    child.stderr?.on('data', (d) => appLog.push(`[err] ${String(d)}`))
    child.on('exit', (code, sig) => appLog.push(`[exit] code=${code} signal=${sig}`))

    const target = await findAppTarget(args.port, Date.now() + args.bootTimeoutMs)
    cdp = new Cdp()
    await cdp.connect(target.webSocketDebuggerUrl as string)
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')
    await cdp.send('Page.enable')

    // A modal over the composer would mean we are not measuring a normal turn.
    const modal = await cdp.evalString(String.raw`(() => {
      var all = document.querySelectorAll('div'), hit = []
      for (var i = 0; i < all.length; i++) {
        var c = typeof all[i].className === 'string' ? all[i].className : ''
        if (c.indexOf('fixed inset-0') !== -1 && c.indexOf('z-50') !== -1) hit.push((all[i].innerText||'').slice(0,120))
      }
      return JSON.stringify(hit)
    })()`)
    const modals = JSON.parse(modal) as string[]
    if (modals.length > 0) {
      throw new Error(`a modal is covering the composer; refusing to capture: ${modals[0]}`)
    }

    const installed = await cdp.evalString(INSTRUMENT)
    if (installed !== 'installed') notes.push(`sampler install returned "${installed}"`)

    // Type and send in ONE evaluate: no CDP round-trip may sit between the t0
    // stamp and the keydown that starts the turn.
    const p = JSON.stringify(args.prompt)
    const sendRes = await cdp.evalString(String.raw`(() => {
      var ta = document.querySelector('textarea')
      if (!ta) return JSON.stringify({ ok: false, error: 'no composer textarea' })
      var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, ${p})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      window.__h2h.prompt = ${p}
      var t0 = Date.now()
      window.__h2h.t0 = t0
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }))
      return JSON.stringify({ ok: true, t0: t0 })
    })()`)
    const sent = JSON.parse(sendRes) as { ok: boolean; t0?: number; error?: string }
    if (!sent.ok) throw new Error(sent.error ?? 'send failed')
    let sendMethod = 'enter'

    // Did Enter actually submit? If the composer still holds the text, fall back
    // to the Send button and re-stamp t0 so the reported latency stays true.
    let cleared = false
    for (let i = 0; i < 20 && !cleared; i++) {
      await sleep(50)
      cleared = (await cdp.evalString(`String(document.querySelector('textarea').value === '')`)) === 'true'
    }
    if (!cleared) {
      const clickRes = await cdp.evalString(String.raw`(() => {
        var btns = document.querySelectorAll('button')
        for (var i = 0; i < btns.length; i++) {
          if ((btns[i].textContent || '').trim() === 'Send') {
            window.__h2h.t0 = Date.now()
            btns[i].click()
            return 'clicked'
          }
        }
        return 'no-send-button'
      })()`)
      if (clickRes !== 'clicked') throw new Error(`Enter did not submit and no Send button was found (${clickRes})`)
      sendMethod = 'send-button'
      notes.push('Enter did not submit; the Send button was clicked instead and t0 was re-stamped')
      for (let i = 0; i < 20 && !cleared; i++) {
        await sleep(50)
        cleared = (await cdp.evalString(`String(document.querySelector('textarea').value === '')`)) === 'true'
      }
      if (!cleared) throw new Error('composer never cleared; the turn did not start')
    }

    const screenshot = async (phase: ShotRecord['phase'], atMs: number | null): Promise<void> => {
      const r = await cdp!.send<{ data?: string }>('Page.captureScreenshot', { format: 'png', fromSurface: true })
      if (!r.data) {
        notes.push(`screenshot (${phase}) returned no data`)
        return
      }
      const buf = Buffer.from(r.data, 'base64')
      const name = `${String(shots.length + 1).padStart(2, '0')}-${phase}.png`
      writeFileSync(join(shotsDir, name), buf)
      shots.push({ file: `screenshots/${name}`, phase, atMsFromSend: atMs, bytes: buf.length })
    }

    // Poll the in-page clock. Poll cadence affects only when the driver *learns*
    // a thing happened, never the recorded time of it.
    const deadline = Date.now() + args.timeoutMs
    let state: PageState | null = null
    let midShots = 0
    let lastMidAt = 0
    let timedOut = false
    for (;;) {
      const raw = await cdp.evalString(READ_STATE)
      const s = JSON.parse(raw) as PageState & { missing?: boolean }
      if (s.missing) throw new Error('the page reloaded mid-turn; the sampler is gone')
      state = s
      if (s.tEnd !== null) break
      if (Date.now() > deadline) {
        timedOut = true
        break
      }
      const t0 = s.t0 ?? Date.now()
      const elapsed = Date.now() - t0
      const readyForMid = s.live && (s.tFirstVisible !== null || elapsed > 3000)
      if (readyForMid && midShots < args.maxMidShots && Date.now() - lastMidAt > args.midEveryMs) {
        lastMidAt = Date.now()
        midShots++
        await screenshot('mid', elapsed)
      }
      await sleep(120)
    }

    const t0 = state?.t0 ?? null
    const rel = (t: number | null | undefined): number | null =>
      t == null || t0 == null ? null : t - t0

    // Turn-end capture, in the state the app left it: collapsed blocks stay
    // collapsed, because that is what the user was looking at.
    const capRaw = await cdp.evalString(CAPTURE)
    const cap = JSON.parse(capRaw) as Capture
    await screenshot('turn-end', rel(state?.tEnd ?? null) ?? null)

    // Then open everything and capture again, for the reader who wants inside.
    const expanded = await cdp.evalString(EXPAND)
    await sleep(300)
    const capExpRaw = await cdp.evalString(CAPTURE)
    const capExp = JSON.parse(capExpRaw) as Capture
    await screenshot('turn-end-expanded', rel(state?.tEnd ?? null) ?? null)

    if (!cap.rootFound) notes.push('the transcript container could not be resolved; text artifacts may be empty')
    if (timedOut) notes.push(`the turn had not finished after ${args.timeoutMs} ms; capture is of an unfinished turn`)
    if (shots.filter((s) => s.phase === 'mid').length === 0) {
      notes.push('no mid-turn screenshot: the turn ended before one could be taken')
    }

    const assistants = cap.messages.filter((m) => m.role === 'assistant')
    const finalMsg = assistants[assistants.length - 1]
    const replyText = finalMsg ? (finalMsg.prose.join('\n\n').trim() || finalMsg.text) : ''
    if (!finalMsg) notes.push('no assistant message was found in the transcript')

    /* ------------------------------------------------------- write artifacts */

    writeFileSync(join(runDir, 'prompt.txt'), `${args.prompt}\n`)
    writeFileSync(join(runDir, 'reply.txt'), replyText ? `${replyText}\n` : '')
    writeFileSync(join(runDir, 'transcript.txt'), cap.transcript)
    writeFileSync(join(runDir, 'transcript-expanded.txt'), capExp.transcript)
    writeFileSync(join(runDir, 'transcript.json'), JSON.stringify(capExp.messages, null, 2))

    const blockCount = capExp.messages.reduce((n, m) => n + m.blocks.length, 0)
    const citationCount = capExp.messages.reduce((n, m) => n + m.citations.length, 0)

    const run = {
      schema: 'h2h-capture/1',
      taskId: args.taskId,
      prompt: args.prompt,
      startedAtIso: startedAt.toISOString(),
      finishedAtIso: new Date().toISOString(),
      send: { method: sendMethod, composerCleared: cleared },
      timings: {
        sendToFirstVisibleMs: rel(state?.tFirstVisible ?? null),
        sendToTurnEndMs: rel(state?.tEnd ?? null),
        sendToUserBubbleMs: rel(state?.tUserBubble ?? null),
        sendToAssistantContainerMs: rel(state?.tAssistantContainer ?? null),
        sendToStreamingStartMs: rel(state?.tStreamStart ?? null),
        firstVisibleKind: state?.firstVisibleKind ?? null,
        endReason: timedOut ? 'timeout' : (state?.endReason ?? null),
        timedOut,
        clock:
          'page Date.now(); t0 is stamped in the same evaluate that dispatches the Enter keydown, ' +
          'so CDP round-trips and screenshot stalls are excluded from every figure here',
        samplingIntervalMs: state?.sampleMs ?? null,
        samplingNote:
          'a MutationObserver plus a ' +
          `${state?.sampleMs ?? 20} ms interval; first-visible and turn-end are therefore accurate to about ` +
          `${state?.sampleMs ?? 20} ms, not better`,
        definitions: {
          firstVisible:
            'first non-empty assistant content on screen — rendered prose, or a tool/plan/reasoning ' +
            'block appearing. The empty reply container that renders the instant the turn starts does ' +
            'not count. This is a screen measurement, not a wire measurement: if the transcript shows ' +
            'a "time to first token" of its own, that figure is about the network stream and will ' +
            'usually be smaller.',
          turnEnd:
            'the composer leaving its streaming state — the moment Stop turns back into Send. This is ' +
            'the whole turn as the user experiences it, so it includes any post-stream work done before ' +
            'the composer is released, and may therefore exceed a raw token-stream duration reported ' +
            'elsewhere on screen.'
        }
      },
      reply: { file: 'reply.txt', chars: replyText.length, words: replyText.split(/\s+/).filter(Boolean).length },
      transcript: {
        visibleFile: 'transcript.txt',
        expandedFile: 'transcript-expanded.txt',
        structuredFile: 'transcript.json',
        messageCount: cap.messages.length,
        assistantMessageCount: assistants.length,
        blockCount,
        citationCount,
        errorCount: cap.errors.length,
        errors: cap.errors,
        disclosuresExpanded: Number(expanded),
        note:
          'transcript.txt is innerText of the live transcript, so a collapsed block shows only its ' +
          'header — exactly what was on screen. transcript-expanded.txt is the same transcript after ' +
          'every collapsed disclosure was opened.'
      },
      screenshots: shots,
      viewport: cap.viewport,
      notes
    }
    writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`)
    writeFileSync(join(runDir, 'README.txt'), README)

    /* ----------------------------------------------------------- sidecars */

    const consoleLines = cdp.events
      .filter((e) => e.method === 'Runtime.consoleAPICalled' || e.method === 'Log.entryAdded' || e.method === 'Runtime.exceptionThrown')
      .map((e) => JSON.stringify(e))
    writeFileSync(join(runDir, '_console.jsonl'), consoleLines.length ? `${consoleLines.join('\n')}\n` : '')
    writeFileSync(join(runDir, '_app.log'), appLog.join(''))

    let pkgVersion = 'unknown'
    try {
      pkgVersion = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown'
    } catch {
      /* leave unknown */
    }
    writeFileSync(
      join(runDir, '_arm.json'),
      `${JSON.stringify(
        {
          note: 'Identifying metadata. A blind critic must not open this file, nor any file whose name starts with "_".',
          arm: args.arm,
          appVersion: pkgVersion,
          model: args.model,
          baseUrl: seededConfig.settings.baseUrl,
          electronBinary: electron,
          mainEntry,
          cdpPort: args.port,
          userDataDir: args.keepUserData ? userData : `${userData} (deleted after the run)`,
          seededConfig,
          platform: `${process.platform} ${process.arch}`,
          startedAtIso: startedAt.toISOString(),
          screenshotCaveat:
            'Screenshots in screenshots/ show the application UI and therefore identify the arm visually. ' +
            'They cannot be de-identified without destroying what they are for.'
        },
        null,
        2
      )}\n`
    )

    await shutdown()
    if (!args.keepUserData) rmSync(userData, { recursive: true, force: true })

    process.stdout.write(
      [
        `run dir            ${runDir}`,
        `first visible      ${fmt(run.timings.sendToFirstVisibleMs)} (${run.timings.firstVisibleKind ?? 'n/a'})`,
        `turn end           ${fmt(run.timings.sendToTurnEndMs)} (${run.timings.endReason ?? 'n/a'})`,
        `reply              ${run.reply.chars} chars / ${run.reply.words} words`,
        `messages / blocks  ${run.transcript.messageCount} / ${run.transcript.blockCount}`,
        `screenshots        ${shots.map((s) => `${s.phase}:${s.bytes}B`).join('  ')}`,
        notes.length ? `notes              ${notes.join(' | ')}` : 'notes              none',
        ''
      ].join('\n')
    )
  } catch (err) {
    await shutdown()
    // Leave the run directory in place on failure; the partial artifacts and
    // _app.log are usually what explains it.
    try {
      writeFileSync(join(runDir, '_app.log'), appLog.join(''))
      writeFileSync(
        join(runDir, '_failure.txt'),
        `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
      )
    } catch {
      /* nothing more to do */
    }
    process.stderr.write(`h2h-capture FAILED: ${err instanceof Error ? err.message : String(err)}\n`)
    process.stderr.write(`partial run dir: ${runDir}\n`)
    process.exitCode = 1
    return
  }
}

function fmt(ms: number | null): string {
  return ms == null ? 'n/a' : `${ms} ms`
}

const README = `WHAT THIS DIRECTORY IS
======================

One task, sent once to one chat application by a script that drove the real UI:
it typed the prompt into the composer and pressed Enter, then recorded what
appeared on screen. Nothing here was read out of the application's internals.

FILES
  prompt.txt               the task, verbatim, as it was typed
  reply.txt                the final answer's rendered text
  transcript.txt           everything visible in the transcript at turn end.
                           Collapsed sections appear as their headers only,
                           because that is all the user could see.
  transcript-expanded.txt  the same transcript after every collapsed section
                           was opened, so their contents are readable
  transcript.json          the expanded transcript, structured per message:
                           role, full text, prose, inline blocks (tool calls,
                           plans, reasoning, code runs), citation strips and
                           any red/error text
  run.json                 timings, counts, and the definitions behind them
  screenshots/             mid-turn frames and the frame at turn end, plus one
                           with every section expanded

TIMINGS
  Every timestamp was taken inside the page, not by the driving script, so the
  numbers exclude the driver's own overhead. run.json states the sampling
  resolution and defines precisely what "first visible" and "turn end" mean.
  Read those definitions before comparing the numbers with anything else.

FILES BEGINNING WITH "_"
  Harness bookkeeping and identifying metadata. If you are reading this
  directory blind, do not open them.
`

main().catch((err) => {
  process.stderr.write(`h2h-capture crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  process.exit(1)
})
