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
 * Two builds, one harness. `--app <dir>` points the driver at any build's
 * `out/` (a git worktree's, say), which is what makes an A/B possible; with no
 * `--app` it runs this repo's own build exactly as before.
 *
 * Task setup — packs, settings, fixtures, driver actions — is declarative and
 * comes in from outside: `--settings` deep-merges into the seeded config,
 * `--packs` installs reference packs through the app's own install path,
 * `--search-fixture` / `--lm-fixture` stand up loopback servers (h2h-fixtures)
 * and substitute their URLs into the settings, and `--actions` is a list of
 * things to do to the running app. Everything the driver did lands in run.json.
 *
 * Three guards keep a half-run task from being scored as if it ran. A seeded
 * setting is read back out of the running app through its own settings API and
 * compared leaf by leaf; a fixture that was configured but never received a
 * request marks the run INVALID; and a precondition the task's setup declares —
 * the local Python runtime, say — marks the run INVALID when it did not
 * actually hold (h2h-preconditions.ts). All three fail the run loudly rather
 * than quietly. The first two cover what the harness put in place; the third
 * covers what the machine had to supply, which is the one a run with no
 * fixtures used to slip past.
 *
 * Run:  bash scripts/h2h-capture.sh --model <id> --task-id <id> --prompt "..."
 */

import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { get as httpGet } from 'http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { startLmShim, startSearchFixture } from './h2h-fixtures'
import type { FixtureHandle, LmShimConfig, SearchFixtureConfig } from './h2h-fixtures'
import { checkPreconditions, requiredCapabilities } from './h2h-preconditions'
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
  THEME_SETTING
} from './h2h-traversal'
import type {
  ActivationSpec,
  Fingerprint,
  StyleSnapshot,
  TabStopRow,
  ThemeReading
} from './h2h-traversal'

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
  /** Root of the build to drive. Default: this repo. */
  appDir: string | null
  /** Extra settings, deep-merged into the seeded config and then verified in-app. */
  settings: Record<string, unknown> | null
  /** Reference packs to install before the turn, through the app's own installer. */
  packs: string[]
  /**
   * Capabilities the task's setup declares it needs from the machine, beyond
   * what --settings can seed. Unioned with the ones the settings already imply.
   */
  requires: string[]
  /** Driver actions, run BEFORE the task prompt is sent (composer toggles, prior turns). */
  preActions: Action[]
  /** Driver actions, run after the prompt is sent. */
  actions: Action[]
  searchFixture: SearchFixtureConfig | null
  lmFixture: LmShimConfig | null
  /** Initial window size, applied before the app paints. */
  windowSize: { w: number; h: number } | null
}

/**
 * One thing the driver does to the running app. Every action is recorded in
 * run.json with what it did and when, so a critic can see the driving.
 */
interface Action {
  type:
    | 'waitMs'
    | 'waitForText'
    | 'waitForSelector'
    | 'clickText'
    | 'pressStop'
    | 'key'
    | 'viewport'
    | 'snapshot'
    | 'styles'
    | 'screenshot'
    | 'theme'
    | 'tabTraverse'
    | 'prompt'
    | 'waitTurnEnd'
  /** waitMs */
  ms?: number
  /** waitForText / clickText: a case-insensitive regular expression source. */
  text?: string
  /** waitForSelector */
  selector?: string
  /** waitForText / waitForSelector / clickText: how long to keep trying (default 60000). */
  timeoutMs?: number
  /** clickText: which match to click when several have the same label (default 0). */
  nth?: number
  /** key: e.g. 'Tab', 'Enter', 'Escape'; modifiers is a bitmask (1 alt, 2 ctrl, 4 meta, 8 shift). */
  key?: string
  modifiers?: number
  /** viewport */
  width?: number
  height?: number
  /** snapshot / styles / screenshot / tabTraverse: a name for the artifact file. */
  label?: string
  /** snapshot / styles: which subtree — 'document' (default), 'transcript', 'plan', 'lastMessage'. */
  within?: string
  /** tabTraverse: how many Tab presses to record (default 25). */
  stops?: number
  /**
   * tabTraverse: stops to activate on the way through, in order. Each fires at
   * most once, and only after the one before it has. This is what lets a
   * traversal follow the app's own answer *into* what the answer names instead
   * of stopping at the control that opens it.
   */
  activate?: ActivationSpec[]
  /**
   * tabTraverse: a label pattern for the control that closes whatever the
   * traversal opened. Required whenever a traversal opens a surface, because
   * the run's later artifacts — including screenshots, which nothing can
   * de-identify — must show the app in the state the task describes.
   */
  exit?: string
  /** tabTraverse: how many further Tab presses may be spent finding `exit` (default 80). */
  exitStops?: number
  /** theme: which theme to switch the running app to. */
  theme?: 'light' | 'dark'
  /** prompt: the follow-up message to send in the same conversation. */
  prompt?: string
  /** Do not fail the run if this action cannot complete; record it and go on. */
  optional?: boolean
}

interface ActionRecord {
  index: number
  type: string
  detail: Record<string, unknown>
  atMsFromSend: number | null
  durationMs: number
  ok: boolean
  result: string
}

/** One turn's in-page clock, as read back from the sampler. */
interface TurnRecord {
  index: number
  prompt: string
  sendMethod: string
  sendToFirstVisibleMs: number | null
  sendToTurnEndMs: number | null
  sendToUserBubbleMs: number | null
  sendToAssistantContainerMs: number | null
  sendToStreamingStartMs: number | null
  firstVisibleKind: string | null
  endReason: string | null
  timedOut: boolean
  /**
   * v2.2. How long after turn-end the reply's rendered text was still changing,
   * and by how much. Non-zero means the build reported the turn finished while
   * it was still painting — which is a defect in the build, and, until this
   * round, a false-positive generator in the reply.md/reply.txt comparison.
   * `null` when the turn timed out (nothing had ended, so nothing settled).
   */
  textSettledMs: number | null
  textGrewAfterTurnEndChars: number | null
  streamEdgeAtTurnEnd: boolean | null
  streamEdgeClearedMs: number | null
}

/** What SETTLE_TEXT reports back. */
interface SettleResult {
  settledMs: number
  charsAtTurnEnd: number
  charsWhenSettled: number
  streamEdgeAtTurnEnd: boolean
  streamEdgeClearedMs: number | null
  quiet: boolean
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

/**
 * One message as the renderer was GIVEN it — the model's own markdown, before
 * any rendering. The counterpart to CapturedMessage, which is what the reader
 * saw after rendering.
 */
interface RawMessage {
  index: number
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
}

interface ShotRecord {
  file: string
  phase: 'mid' | 'turn-end' | 'turn-end-expanded' | 'action'
  atMsFromSend: number | null
  bytes: number
  /** 'os' is the real window surface; 'renderer' is the compositor fallback. */
  surface?: 'os' | 'renderer'
  /** For phase 'action': the driver's name for the moment, e.g. the theme it is in. */
  label?: string
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
  --no-shots            take no mid-turn screenshots at all (use for timed tasks:
                        a screenshot stalls the CDP channel it shares with the sampler)
  --keep-userdata       do not delete the throwaway userData dir afterwards

  --app <dir>           drive the build rooted at <dir> instead of this repo. The
                        main entry is resolved from <dir>/out/main/index.js,
                        <dir>/main/index.js or <dir>/index.js, and that root's own
                        packs/ and node_modules/electron are preferred when present.
  --settings <file>     JSON deep-merged into the seeded settings before launch.
                        Every leaf is read back out of the running app afterwards
                        and the run FAILS if the app did not take it.
  --packs <ids>         comma-separated reference packs to install before the turn
                        (installed through the app's own library:installBundled).
  --requires <ids>      comma-separated capabilities the task's setup says the
                        machine must supply (e.g. python-runtime). A required
                        capability that was not actually there marks the run
                        INVALID. Capabilities the settings already imply — a
                        tools.run_python of true — are added automatically.
  --search-fixture <f>  JSON (file path or inline) configuring the loopback SearXNG
                        fixture. Its URL replaces {{searchFixtureUrl}} in --settings.
  --lm-fixture <f>      JSON (file path or inline) configuring the loopback LM Studio
                        shim. Its URL replaces {{lmShimUrl}} in --settings.
  --pre-actions <f>     JSON array of driver actions to run BEFORE the prompt is
                        sent — flipping the 📋 or 🧠 composer toggle, or sending
                        earlier turns so the task prompt lands in a conversation
                        that already has history.
  --actions <f>         JSON array (file path or inline) of driver actions to run
                        after the prompt is sent. See the Action type.
  --window <WxH>        initial window size, e.g. 1280x800
`

function parseArgs(argv: string[]): Args {
  const a: Record<string, string> = {}
  const flags = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (!t.startsWith('--')) continue
    const key = t.slice(2)
    if (key === 'keep-userdata' || key === 'help' || key === 'no-shots') {
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

  /** A JSON argument may be a path to a file or the JSON itself. */
  const json = <T>(k: string): T | null => {
    const raw = a[k]
    if (raw === undefined) return null
    const text = existsSync(resolve(raw)) ? readFileSync(resolve(raw), 'utf8') : raw
    try {
      return JSON.parse(text) as T
    } catch (e) {
      process.stderr.write(`error: --${k} is not valid JSON: ${e instanceof Error ? e.message : String(e)}\n`)
      process.exit(2)
    }
    return null
  }

  const win = a.window?.match(/^(\d+)x(\d+)$/)

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
    maxMidShots: flags.has('no-shots') ? 0 : num('max-mid', 3),
    keepUserData: flags.has('keep-userdata'),
    appDir: a.app ? resolve(a.app) : null,
    settings: json<Record<string, unknown>>('settings'),
    packs: (a.packs ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    requires: (a.requires ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    preActions: json<Action[]>('pre-actions') ?? [],
    actions: json<Action[]>('actions') ?? [],
    searchFixture: json<SearchFixtureConfig>('search-fixture'),
    lmFixture: json<LmShimConfig>('lm-fixture'),
    windowSize: win ? { w: Number(win[1]), h: Number(win[2]) } : null
  }
}

/* ------------------------------------------------------- settings plumbing */

type Json = Record<string, unknown>

/** Deep merge, right wins. Arrays are replaced whole — settings.models is an array. */
function deepMerge(base: Json, extra: Json): Json {
  const out: Json = { ...base }
  for (const [k, v] of Object.entries(extra)) {
    const cur = out[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      out[k] = deepMerge(cur as Json, v as Json)
    } else {
      out[k] = v
    }
  }
  return out
}

/** Replaces {{searchFixtureUrl}} / {{lmShimUrl}} anywhere in a settings tree. */
function substitute(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+)\}\}/g, (m, name: string) => vars[name] ?? m)
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars))
  if (value && typeof value === 'object') {
    const out: Json = {}
    for (const [k, v] of Object.entries(value as Json)) out[k] = substitute(v, vars)
    return out
  }
  return value
}

/** Every leaf of an object as dotted paths, so a seed can be checked against reality. */
function leaves(value: unknown, prefix = ''): { path: string; value: unknown }[] {
  if (value === null || typeof value !== 'object') return [{ path: prefix, value }]
  const out: { path: string; value: unknown }[] = []
  if (Array.isArray(value)) {
    value.forEach((v, i) => out.push(...leaves(v, `${prefix}[${i}]`)))
    return out
  }
  for (const [k, v] of Object.entries(value as Json)) {
    out.push(...leaves(v, prefix ? `${prefix}.${k}` : k))
  }
  return out
}

function atPath(root: unknown, path: string): unknown {
  let node: unknown = root
  for (const part of path.split('.')) {
    const m = part.match(/^([^[]*)((?:\[\d+\])*)$/)
    if (!m) return undefined
    if (m[1]) {
      if (node === null || typeof node !== 'object') return undefined
      node = (node as Json)[m[1]]
    }
    for (const idx of m[2].match(/\d+/g) ?? []) {
      if (!Array.isArray(node)) return undefined
      node = node[Number(idx)]
    }
  }
  return node
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
      // Only rows added since this turn began are candidates. On a second turn
      // in the same conversation the previous reply is still the last child for
      // a frame or two, and accepting it would stamp first-visible on text that
      // was already on screen before Enter.
      var kids = r.children, floor = H._minIndex || 0
      for (var i = kids.length - 1; i >= floor; i--) {
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

  // Re-arm for a second turn in the same conversation (the "prompt" driver
  // action). Everything the sampler owns is cleared, including the cached
  // assistant container and the transcript root — the next turn appends new
  // rows, and a stale _a would freeze first-visible on the previous reply.
  H.reset = function (p) {
    var r0 = resolveRoot()
    H._minIndex = r0 ? r0.children.length : 0
    H.t0 = null; H.tUserBubble = null; H.tAssistantContainer = null
    H.tFirstVisible = null; H.firstVisibleKind = null
    H.tStreamStart = null; H.tEnd = null; H.endReason = null
    H.sawStreaming = false; H._a = null
    if (p) H.prompt = p
    root = null
    if (!mo) {
      mo = new MutationObserver(tick)
      mo.observe(document.body, { childList: true, subtree: true, characterData: true })
    }
    return 'reset'
  }
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
 * Waits for the reply's rendered text to stop changing, then for a paint.
 *
 * Turn-end is `composer-idle` — the frame the composer stops rendering Stop —
 * and through v2.1 that was the *stream* ending, not the last paint. The tail
 * pacer could still be publishing for hundreds of milliseconds afterwards, so
 * `reply.txt` (innerText, post-render) was read short while `reply.md` (the raw
 * markdown out of the store) was already complete.
 *
 * That is a fault in the instrument, not only in the product. Round 7 added
 * reply.md precisely so a blind critic could catch the renderer deleting
 * characters, and it found two real defects that way; a paint lag counterfeits
 * exactly that signature, so the comparison acquired a false-positive mode —
 * "the renderer dropped 65 characters" about a renderer that dropped none.
 *
 * Both halves of the repair are here on purpose:
 *
 *  - **Settle before reading.** Poll the assistant's rendered prose length until
 *    it has been unchanged for QUIET_MS and no `.stream-edge` span remains, then
 *    let two frames pass so the final mutation is actually on screen. This is
 *    what makes the artifact honest, and it works against any build — including
 *    an arm that has not fixed the product, which is the case that matters,
 *    because a critic compares two builds and only one of them is ours.
 *  - **Record what the wait cost.** Settling alone would have quietly absorbed
 *    the very defect the instrument exists to expose. `textSettledMs`,
 *    `textGrewAfterTurnEndChars` and `streamEdgeAtTurnEnd` keep it a stated
 *    fact, so a critic can tell a paint lag from a loss instead of having to
 *    guess — and can fault a build for reporting itself finished early.
 *
 * Polled on a timer rather than on rAF: frames stop in an occluded window and
 * the whole wait would hang there. The two-frame paint settle is raced against
 * a timeout for the same reason. Bounded by BUDGET_MS either way.
 */
const SETTLE_TEXT = String.raw`(() => new Promise((resolve) => {
  var H = window.__h2h
  var QUIET_MS = 100
  var BUDGET_MS = 2500
  var t0 = Date.now()

  function proseLen() {
    var r = H && H.getRoot ? H.getRoot() : null
    if (!r) return -1
    var kids = r.children, a = null
    for (var i = kids.length - 1; i >= 0; i--) {
      if (H.classify(kids[i]) === 'assistant') { a = kids[i]; break }
    }
    if (!a) return -1
    var n = 0, pn = a.querySelectorAll('.markdown-body')
    for (var j = 0; j < pn.length; j++) n += (pn[j].textContent || '').length
    return n
  }

  var start = proseLen()
  var last = start
  var lastChange = t0
  var edgeAtEntry = !!document.querySelector('.stream-edge')
  var edgeGoneAt = edgeAtEntry ? null : t0

  function afterPaint(cb) {
    var fired = false
    var fire = function () { if (!fired) { fired = true; cb() } }
    requestAnimationFrame(function () { requestAnimationFrame(fire) })
    setTimeout(fire, 250)
  }

  function poll() {
    var now = Date.now()
    var n = proseLen()
    if (n !== last) { last = n; lastChange = now }
    if (edgeGoneAt === null && !document.querySelector('.stream-edge')) edgeGoneAt = now
    var quiet = now - lastChange >= QUIET_MS && edgeGoneAt !== null
    var spent = now - t0
    if (quiet || spent >= BUDGET_MS) {
      afterPaint(function () {
        resolve(JSON.stringify({
          settledMs: Date.now() - t0,
          charsAtTurnEnd: start,
          charsWhenSettled: proseLen(),
          streamEdgeAtTurnEnd: edgeAtEntry,
          streamEdgeClearedMs: edgeGoneAt === null ? null : edgeGoneAt - t0,
          quiet: quiet
        }))
      })
      return
    }
    setTimeout(poll, 16)
  }
  poll()
}))()`

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
 * Reads the raw markdown the renderer was HANDED, as opposed to what it drew.
 *
 * Every text artifact beside this one comes from `innerText`, which is
 * post-render by construction: a rendering defect is invisible in them, because
 * they record its output rather than its input. Diffing this against reply.txt
 * separates "the model wrote it that way" from "the app drew it that way".
 *
 * It goes through `window.api.listConversations()` — the same already-exposed
 * production API the app itself uses to populate the sidebar, reached the same
 * way the audit export below is reached. No hook is added to the product for
 * the harness's benefit, and nothing is written back.
 *
 * The newest conversation by updatedAt is the one the turn just ran in. An
 * ephemeral (no-trace) conversation is never persisted and so cannot appear
 * here; that is a product guarantee, and the caller reports it as a gap rather
 * than treating it as a failure.
 */
const RAW_MARKDOWN = String.raw`window.api.listConversations().then(function (cs) {
  var newest = null
  for (var i = 0; i < cs.length; i++) {
    if (!newest || (cs[i].updatedAt || 0) > (newest.updatedAt || 0)) newest = cs[i]
  }
  if (!newest) return JSON.stringify({ ok: false, error: 'no persisted conversation' })
  // Deliberately narrow: role, the raw content, and the raw reasoning. modelId,
  // roleName, stats and titles are all arm tells, and this file is staged into
  // blind pairs.
  var msgs = (newest.messages || []).map(function (m, i) {
    var out = { index: i, role: m.role, content: m.content || '' }
    if (m.reasoning) out.reasoning = m.reasoning
    return out
  })
  return JSON.stringify({ ok: true, messages: msgs })
}).catch(function (e) {
  return JSON.stringify({ ok: false, error: String((e && e.message) || e) })
})`

/**
 * Opens every collapsed disclosure. Only buttons carrying the app's collapsed
 * caret (▸) are clicked — Approve/Reject, Regenerate and Branch never carry it,
 * so nothing with a side effect can be triggered by this sweep.
 *
 * Native `<details>` are opened by setting `.open`, not by clicking: a summary
 * click is a toggle, so a second pass would shut what the first pass opened,
 * and `.open = true` is idempotent and cannot fire anything else.
 *
 * They are handled at all because they were invisible here. The caret is the
 * app's own convention and a native disclosure carries none, so its contents
 * never reached transcript-expanded.txt — the artifact a critic reads to learn
 * what the reader could have reached. A blind critic saw `the runtime reported`
 * with nothing under it and reported it as a dangling label; the text was
 * there, one click away, and the capture could not see it. An instrument that
 * misses a whole element type reports the app as worse than it is.
 */
const EXPAND = String.raw`(async () => {
  // Each button is clicked at most once, ever. React repaints the caret one
  // frame later, so a same-tick second pass would still see ▸ and toggle the
  // section shut again — an even number of clicks leaves everything closed.
  var seen = new Set(), clicked = 0
  var details = document.querySelectorAll('details')
  for (var d = 0; d < details.length; d++) {
    if (!details[d].open) { details[d].open = true; clicked++ }
  }
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

  /**
   * Every message is bounded. An unanswered CDP message used to hang the whole
   * capture for as long as anyone would wait — the turn had finished, the
   * composer was idle, and the harness sat on a reply that never came, leaving
   * no run.json and no _failure.txt to say so. Screenshots are the usual
   * culprit and they are also the slowest legitimate call, hence the generous
   * default rather than a tight one: this is a deadlock guard, not a latency
   * budget, and it must never fire on a call that was merely slow.
   */
  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 120_000
  ): Promise<T> {
    const ws = this.ws
    if (!ws) throw new Error('CDP not connected')
    const id = ++this.nextId
    return new Promise<T>((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rej(new Error(`CDP ${method} did not answer within ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, (r) => {
        clearTimeout(timer)
        res(r as T)
      })
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

/* --------------------------------------------------------- driver actions */

/**
 * Resolves a named subtree in the page. Written as an expression so it can be
 * pasted into any evaluate: 'document' is the whole page, 'transcript' the
 * scrolling message list, 'lastMessage' the last assistant row, 'plan' the plan
 * block inside it.
 */
function scopeExpr(within: string | undefined): string {
  const w = within ?? 'document'
  if (w === 'document') return 'document.documentElement'
  if (w === 'transcript') return 'window.__h2h.getRoot()'
  const lastMessage = String.raw`(() => {
    var H = window.__h2h, r = H && H.getRoot()
    if (!r) return null
    var kids = r.children
    for (var i = kids.length - 1; i >= 0; i--) if (H.classify(kids[i]) === 'assistant') return kids[i]
    return null
  })()`
  if (w === 'lastMessage') return lastMessage
  if (w === 'plan') {
    return String.raw`(() => {
      var m = ${lastMessage}
      if (!m) return null
      var blocks = window.__h2h.blockNodes(m)
      for (var i = blocks.length - 1; i >= 0; i--) {
        var t = blocks[i].innerText || ''
        if (/awaiting approval|steps done|Run this plan|Plan\b/i.test(t)) return blocks[i]
      }
      return blocks.length ? blocks[blocks.length - 1] : null
    })()`
  }
  // Anything else is treated as a CSS selector.
  return `document.querySelector(${JSON.stringify(w)})`
}

interface ActionContext {
  screenshot(phase: ShotRecord['phase'], atMs: number | null, label?: string): Promise<void>
  snapshotsDir: string
  waitTurnEnd(budgetMs: number): Promise<boolean>
  sendPrompt(text: string): Promise<string>
  budgetMs: number
}

/**
 * Presses the focused control, using the keyboard only, and proves it fired.
 *
 * Enter first, because Enter is what a person presses. Blink activates a button
 * from the keypress that follows Enter's keydown, and Space from its keyup —
 * two different code paths, and a control that answers only one of them is a
 * finding, not something to route around. Both are legitimate keyboard
 * activation; a click is not, and is never used here.
 *
 * Whether anything happened is decided by comparing the page, never assumed.
 */
async function activateFocused(
  cdp: Cdp,
  tag: string | null
): Promise<{ key: string | null; before: Fingerprint; after: Fingerprint }> {
  const read = async (): Promise<Fingerprint> =>
    JSON.parse(await cdp.evalString(TAB_FINGERPRINT)) as Fingerprint
  const before = await read()
  let after = before
  // Space is only offered to things a space cannot corrupt. Pressed in a text
  // field it types, and a driver that types into the app it is measuring has
  // changed the thing it is measuring.
  const keys = tag === 'button' || tag === 'a' ? ['Enter', 'Space'] : ['Enter']
  for (const key of keys) {
    await dispatchKey(cdp, key, 0)
    await sleep(350)
    after = await read()
    if (fingerprintChanged(before, after)) return { key, before, after }
  }
  return { key: null, before, after }
}

async function runAction(cdp: Cdp, action: Action, ctx: ActionContext): Promise<string> {
  const timeout = action.timeoutMs ?? 60_000
  switch (action.type) {
    case 'waitMs': {
      await sleep(action.ms ?? 1000)
      return `waited ${action.ms ?? 1000} ms`
    }

    case 'waitForText': {
      if (!action.text) throw new Error('waitForText needs text')
      const re = JSON.stringify(action.text)
      const scope = scopeExpr(action.within)
      const started = Date.now()
      for (;;) {
        const hit = await cdp.evalString(String.raw`(() => {
          var s = ${scope}
          if (!s) return 'no-scope'
          return new RegExp(${re}, 'i').test(s.innerText || '') ? 'yes' : 'no'
        })()`)
        if (hit === 'yes') return `matched after ${Date.now() - started} ms`
        if (Date.now() - started > timeout) {
          throw new Error(`text /${action.text}/i never appeared in ${action.within ?? 'document'} within ${timeout} ms`)
        }
        await sleep(150)
      }
    }

    case 'waitForSelector': {
      if (!action.selector) throw new Error('waitForSelector needs a selector')
      const started = Date.now()
      for (;;) {
        const hit = await cdp.evalString(
          `String(!!document.querySelector(${JSON.stringify(action.selector)}))`
        )
        if (hit === 'true') return `matched after ${Date.now() - started} ms`
        if (Date.now() - started > timeout) {
          throw new Error(`selector ${action.selector} never appeared within ${timeout} ms`)
        }
        await sleep(150)
      }
    }

    case 'pressStop':
    case 'clickText': {
      const pattern = action.type === 'pressStop' ? '^\\s*Stop\\s*$' : action.text
      if (!pattern) throw new Error('clickText needs text')
      const re = JSON.stringify(pattern)
      const scope = scopeExpr(action.within)
      const nth = action.nth ?? 0
      const started = Date.now()
      for (;;) {
        // Only real activatable controls are considered, and the click is a
        // plain .click() on the element the user would have clicked.
        const res = await cdp.evalString(String.raw`(() => {
          var s = ${scope}
          if (!s) return JSON.stringify({ ok: false, why: 'no-scope' })
          var re = new RegExp(${re}, 'i')
          var all = s.querySelectorAll('button, a[href], [role="button"], input[type="submit"]')
          var hits = []
          for (var i = 0; i < all.length; i++) {
            var el = all[i]
            // Visible text first, then the accessible name and the tooltip: an
            // icon-only control has no text a regex could match, but it is
            // still a control a user can identify and reach.
            var visible = (el.innerText || el.value || '').trim()
            var accessible = [el.getAttribute('aria-label') || '', el.getAttribute('title') || '']
              .filter(Boolean).join(' — ')
            // Both are tried separately, never concatenated: an anchored
            // pattern like ^Stop$ must still match a control whose tooltip is a
            // paragraph long.
            var matched = (visible && re.test(visible)) || (accessible && re.test(accessible))
            if (matched && el.offsetParent !== null && !el.disabled) hits.push({ el: el, label: visible || accessible })
          }
          if (hits.length <= ${nth}) return JSON.stringify({ ok: false, why: 'not-found', count: hits.length })
          hits[${nth}].el.click()
          return JSON.stringify({ ok: true, label: hits[${nth}].label, count: hits.length })
        })()`)
        const parsed = JSON.parse(res) as { ok: boolean; why?: string; label?: string; count?: number }
        if (parsed.ok) {
          return `clicked "${parsed.label}" (${parsed.count} candidates) after ${Date.now() - started} ms`
        }
        if (Date.now() - started > timeout) {
          throw new Error(
            `no clickable control matching /${pattern}/i in ${action.within ?? 'document'} within ${timeout} ms (${parsed.why})`
          )
        }
        await sleep(150)
      }
    }

    case 'key': {
      if (!action.key) throw new Error('key needs a key name')
      // Real input, not a synthesized KeyboardEvent: Tab must actually move
      // focus, and only a trusted event does that.
      await dispatchKey(cdp, action.key, action.modifiers ?? 0)
      await sleep(120)
      return `pressed ${action.key}${action.modifiers ? ` (modifiers ${action.modifiers})` : ''}`
    }

    case 'viewport': {
      const width = action.width ?? 1280
      const height = action.height ?? 800
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 0,
        mobile: false
      })
      await sleep(400)
      const metrics = await cdp.evalString(String.raw`(() => JSON.stringify({
        inner: [window.innerWidth, window.innerHeight],
        docScroll: document.documentElement.scrollWidth,
        docClient: document.documentElement.clientWidth
      }))()`)
      return `viewport ${width}x${height}; ${metrics}`
    }

    case 'snapshot': {
      const label = action.label ?? `snapshot-${Date.now()}`
      const scope = scopeExpr(action.within)
      const res = await cdp.evalString(String.raw`(() => {
        var s = ${scope}
        if (!s) return JSON.stringify({ ok: false })
        return JSON.stringify({ ok: true, html: s.outerHTML, text: s.innerText || '' })
      })()`)
      const parsed = JSON.parse(res) as { ok: boolean; html?: string; text?: string }
      if (!parsed.ok) throw new Error(`snapshot scope "${action.within ?? 'document'}" did not resolve`)
      mkdirSync(ctx.snapshotsDir, { recursive: true })
      writeFileSync(join(ctx.snapshotsDir, `${label}.html`), parsed.html ?? '')
      writeFileSync(join(ctx.snapshotsDir, `${label}.txt`), parsed.text ?? '')
      return `snapshots/${label}.html (${(parsed.html ?? '').length} chars)`
    }

    case 'styles': {
      const label = action.label ?? `styles-${Date.now()}`
      const res = await cdp.evalString(stylesIn(scopeExpr(action.within)))
      const parsed = JSON.parse(res) as { ok: boolean; nodes?: Record<string, unknown>[] }
      if (!parsed.ok) throw new Error(`styles scope "${action.within ?? 'document'}" did not resolve`)
      const themeNow = await cdp.evalString(
        `String(document.documentElement.classList.contains('dark') ? 'dark' : 'light')`
      )
      mkdirSync(ctx.snapshotsDir, { recursive: true })
      writeFileSync(
        join(ctx.snapshotsDir, `${label}.json`),
        `${JSON.stringify(
          {
            note:
              'One entry per text node of three or more non-whitespace characters, as it actually ' +
              'rendered. "foregroundRgb" is the ink composited over "backgroundRgb" — the app\'s ' +
              'muted ink is rgba(23,23,23,0.32), so its raw computed colour is not what anyone sees ' +
              '— and "backgroundChain" is the stack of surfaces that produced that background. ' +
              'No contrast ratio is computed here: the ratio is a pure function of those two RGB ' +
              'triples and belongs to the scoring pass, not to the instrument. fontSizePx and ' +
              'fontWeight decide which WCAG threshold applies (4.5:1, or 3.0:1 for large text).',
            theme: themeNow,
            scope: action.within ?? 'document',
            nodeCount: parsed.nodes?.length ?? 0,
            nodes: parsed.nodes ?? []
          },
          null,
          2
        )}\n`
      )
      return `snapshots/${label}.json (${parsed.nodes?.length ?? 0} text nodes, ${themeNow} theme)`
    }

    case 'screenshot': {
      const label = action.label ?? `at-${Date.now()}`
      await ctx.screenshot('action', null, label)
      return `screenshot "${label}"`
    }

    case 'theme': {
      const want = action.theme === 'dark' ? 'dark' : 'light'
      const read = async (): Promise<ThemeReading> => {
        const r = JSON.parse(await cdp.evalString(THEME_READ)) as ThemeReading
        r.setting = await cdp.evalString(THEME_SETTING)
        return r
      }
      const before = await read()
      if (before.setting === want && before.dark === (want === 'dark')) {
        return `already ${want} (body background ${before.bodyBackground}); nothing changed`
      }

      // Through the app's own Settings panel, control by control, exactly as a
      // person changes a theme: open Settings, General, the theme, Save. The
      // shortcut of writing the setting over IPC and toggling the class does
      // not work and must not be used — it leaves the renderer's own store
      // holding the old value, and the Settings panel then repaints from that
      // stale value every time it opens or closes. save() is the only path that
      // updates the persisted settings, the store and the screen together.
      const click = (text: string): Promise<string> =>
        runAction(cdp, { type: 'clickText', text, timeoutMs: 20_000 }, ctx)
      const steps: string[] = []
      if (!before.overlayOpen) steps.push(await click('^Settings\\b'))
      steps.push(await click('^General$'))
      steps.push(await click(`^${want}$`))
      steps.push(await click('^Save$'))
      await sleep(500)

      const after = await read()
      if (after.setting !== want) {
        throw new Error(`the app did not take theme "${want}" — getSettings() reports "${after.setting}"`)
      }
      if (after.dark !== (want === 'dark')) {
        throw new Error(`theme "${want}" was saved but the document class is "${after.htmlClass}"`)
      }
      if (after.overlayOpen) {
        throw new Error('Save did not close the Settings panel; the app is not back in the state the task describes')
      }
      // The witness. A theme that did not move a single rendered colour is a
      // theme that did not happen, and a capture labelled "dark" over a light
      // screen is worse than no capture at all.
      if (before.bodyBackground === after.bodyBackground) {
        throw new Error(
          `theme "${want}" changed no rendered colour — body background stayed ${after.bodyBackground}`
        )
      }
      return `theme ${before.setting} → ${after.setting} via the app's own Settings panel (${steps.length} controls); body background ${before.bodyBackground} → ${after.bodyBackground}`
    }

    case 'tabTraverse': {
      const stops = action.stops ?? 25
      const label = action.label ?? 'tab-traverse'
      const specs = action.activate ?? []
      const baseline = JSON.parse(await cdp.evalString(TAB_BASELINE)) as {
        focusables: number
        startedFrom: string
        reset: boolean
      }
      const themeAt = await cdp.evalString(
        `String(document.documentElement.classList.contains('dark') ? 'dark' : 'light')`
      )
      const rows: TabStopRow[] = []
      const activations: Record<string, unknown>[] = []
      let fired = 0

      for (let i = 0; i < stops; i++) {
        await dispatchKey(cdp, 'Tab', 0)
        await sleep(90)
        const row = JSON.parse(await cdp.evalString(tabStop(i + 1))) as TabStopRow
        rows.push(row)

        const due = nextActivation(typeof row.label === 'string' ? row.label : null, specs, fired)
        if (!due) continue
        const { key, before, after } = await activateFocused(cdp, row.tag)
        fired++
        // Anything the activation created has to be measured unfocused NOW,
        // while nothing in it has been focused yet. This is what makes focus
        // visibility decidable inside the panel rather than only on the way to it.
        const added = key ? Number(await cdp.evalString(TAB_REBASELINE)) : 0
        const record = {
          stop: i + 1,
          match: due.spec.match,
          why: due.spec.note ?? null,
          label: row.label ?? null,
          keyThatWorked: key,
          focusablesBefore: before.focusables,
          focusablesAfter: after.focusables,
          overlayBefore: before.overlay,
          overlayAfter: after.overlay,
          newlyMeasuredUnfocused: added,
          effect: key
            ? `activated with ${key}`
            : 'no observable change from Enter or Space — the control could not be activated from the keyboard'
        }
        activations.push(record)
        row.activated = record
      }

      // Resolved BEFORE the exit, not after. The post-pass exists to measure
      // elements that were focused every time a baseline ran, and the exit
      // unmounts the whole panel — resolving afterwards returns null for every
      // control the traversal was actually about, which is the one place the
      // reading was needed.
      const resolved = JSON.parse(await cdp.evalString(TAB_RESOLVE)) as {
        stop: number
        style: StyleSnapshot | null
      }[]
      const merged = mergeUnfocused(rows, resolved)

      // Whatever the walk opened has to be closed, with the keyboard, before
      // the run's own artifacts are taken. A screenshot is the one artifact
      // nothing can de-identify, and a panel left open puts the app's version
      // number in it.
      let exit: Record<string, unknown> | null = null
      if (action.exit) {
        const budget = action.exitStops ?? 80
        const re = new RegExp(action.exit, 'i')
        let found = false
        for (let i = 0; i < budget && !found; i++) {
          await dispatchKey(cdp, 'Tab', 0)
          await sleep(70)
          const peek = await cdp.evalString(TAB_PEEK)
          if (!re.test(peek)) continue
          const { key, before, after } = await activateFocused(cdp, 'button')
          found = key !== null
          exit = {
            pattern: action.exit,
            label: peek,
            extraTabPresses: i + 1,
            keyThatWorked: key,
            overlayBefore: before.overlay,
            overlayAfter: after.overlay
          }
        }
        if (!found) {
          throw new Error(
            `no control matching /${action.exit}/i could be activated within ${budget} further Tab presses; ` +
              'the surface the traversal opened is still open and the run would not be in the state the task describes'
          )
        }
      }

      const fingerprint = JSON.parse(await cdp.evalString(TAB_FINGERPRINT)) as Fingerprint

      mkdirSync(ctx.snapshotsDir, { recursive: true })
      writeFileSync(
        join(ctx.snapshotsDir, `${label}.json`),
        `${JSON.stringify(
          {
            note:
              'One entry per Tab press, in order, driven with real key events. "focused" is the ' +
              'computed style while focused; "unfocused" is the same element with nothing focused, ' +
              'and "unfocusedSource" says when that reading was taken — "pre" before the traversal ' +
              'or immediately after the activation that created the element, "post" after the walk ' +
              'with focus cleared, null if the traversal itself unmounted the element and no ' +
              'reading exists. A stop whose two readings are identical is a stop with no visible ' +
              'focus indicator; a stop with a null unfocused reading is unmeasured, not passing. ' +
              '"styleDeltaKeys" names exactly which properties moved, because both of the obvious ' +
              'questions mislead: "do the readings differ" scores a colour change on a zero-width ' +
              'outline as a ring, and "did the width or style change" misses a ring that is drawn ' +
              'permanently at 2px and merely turns from transparent to coloured on focus. Both ' +
              'states are recorded in full so the scoring pass need not choose between them. ' +
              '"surface" is "overlay" for a stop inside a modal and "page" otherwise, and ' +
              '"obscured" says whether a click at the element\'s own centre would land on something ' +
              'else — a control behind a modal scrim is focusable, on screen, and unusable.',
            theme: themeAt,
            focusableElementsMeasured: baseline.focusables,
            focusableElementsAtEnd: fingerprint.focusables,
            /**
             * Where focus was when the walk began, and whether it was put back
             * to the top of the document before the first Tab. Two traversals
             * of one route are only comparable stop-for-stop if both say
             * "reset": true — recorded rather than assumed, because the first
             * traversal of a run starts moments after the driver typed and used
             * to begin mid-document.
             */
            focusStartedFrom: baseline.startedFrom,
            startPointReset: baseline.reset,
            overlayOpenAtEnd: fingerprint.overlay,
            stopsRequested: stops,
            activationsRequested: specs.length,
            activationsPerformed: activations.filter((a) => a.keyThatWorked !== null).length,
            activations,
            exit,
            stops: merged
          },
          null,
          2
        )}\n`
      )
      const done = activations.filter((a) => a.keyThatWorked !== null).length
      return `snapshots/${label}.json (${stops} stops in ${themeAt} theme over ${baseline.focusables} focusable elements; ${done}/${specs.length} activations)`
    }

    case 'prompt': {
      if (!action.prompt) throw new Error('prompt action needs prompt text')
      const method = await ctx.sendPrompt(action.prompt)
      return `sent follow-up via ${method}`
    }

    case 'waitTurnEnd': {
      const budget = action.timeoutMs ?? ctx.budgetMs
      const to = await ctx.waitTurnEnd(budget)
      return to ? `turn did not end within ${budget} ms` : 'turn ended'
    }

    default:
      throw new Error(`unknown action type "${String((action as Action).type)}"`)
  }
}

async function dispatchKey(cdp: Cdp, key: string, modifiers: number): Promise<void> {
  // `key` in an action is the physical key name; `keyValue` is what the page's
  // own handlers read off the event (App.tsx compares e.key === '\\' for ⌘\).
  // Getting that wrong silently does nothing, which is the worst failure mode a
  // driver can have, so the mapping is explicit rather than inferred.
  const codes: Record<string, { code: string; vk: number; keyValue?: string; text?: string }> = {
    Tab: { code: 'Tab', vk: 9 },
    Enter: { code: 'Enter', vk: 13, text: '\r' },
    Escape: { code: 'Escape', vk: 27 },
    Backslash: { code: 'Backslash', vk: 220, keyValue: '\\', text: '\\' },
    ArrowDown: { code: 'ArrowDown', vk: 40 },
    ArrowUp: { code: 'ArrowUp', vk: 38 },
    Space: { code: 'Space', vk: 32, keyValue: ' ', text: ' ' }
  }
  const spec = codes[key] ?? { code: key, vk: 0 }
  const keyValue = spec.keyValue ?? key
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: keyValue,
    code: spec.code,
    windowsVirtualKeyCode: spec.vk,
    nativeVirtualKeyCode: spec.vk,
    modifiers
  })
  // No char event under a modifier: ⌘\ is a shortcut, and sending the
  // character too would also type a backslash into whatever has focus.
  if (spec.text && modifiers === 0) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: spec.text, key: keyValue, modifiers })
  }
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: keyValue,
    code: spec.code,
    windowsVirtualKeyCode: spec.vk,
    nativeVirtualKeyCode: spec.vk,
    modifiers
  })
}

/* ------------------------------------------------------------------- main */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const repoRoot = resolve(__dirname, '..', '..')

  // Which build to drive. Default is this repo's own out/, unchanged; --app
  // names another root — a git worktree's checkout, say — and the main entry is
  // resolved from it rather than assumed.
  const appRoot = args.appDir ?? repoRoot
  const entryCandidates = [
    join(appRoot, 'out', 'main', 'index.js'),
    join(appRoot, 'main', 'index.js'),
    join(appRoot, 'index.js')
  ]
  const mainEntry = entryCandidates.find((p) => existsSync(p))
  if (!mainEntry) {
    throw new Error(
      `no main entry under ${appRoot} — looked for ${entryCandidates.join(', ')}. ` +
        'Build it first: node node_modules/electron-vite/bin/electron-vite.js build'
    )
  }
  // The app's own Electron if that root has one (a worktree may pin a different
  // version); this repo's otherwise. The runtime is stated in the sidecar so a
  // mismatch is visible rather than assumed away.
  const electronNames = [
    'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    'node_modules/electron/dist/electron'
  ]
  const electron =
    electronNames.map((p) => join(appRoot, p)).find((p) => existsSync(p)) ??
    electronNames.map((p) => join(repoRoot, p)).find((p) => existsSync(p))
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

  // Fixtures come up before the config is written: their ports are chosen by
  // the OS, and the settings that point the app at them have to carry the real
  // numbers. {{searchFixtureUrl}} / {{lmShimUrl}} in --settings are where they
  // land.
  const fixtures: FixtureHandle[] = []
  const fixtureVars: Record<string, string> = { model: args.model }
  if (args.searchFixture) {
    const f = await startSearchFixture(args.searchFixture)
    fixtures.push(f)
    fixtureVars.searchFixtureUrl = f.url
  }
  if (args.lmFixture) {
    const f = await startLmShim(args.lmFixture)
    fixtures.push(f)
    fixtureVars.lmShimUrl = f.url
  }

  const baseSettings: Json = {
    baseUrl: 'http://127.0.0.1:1234/v1',
    onboardingCompleted: true,
    models: [{ id: 'model-1', modelId: args.model, roleName: 'Assistant', color: 'blue', enabled: true }]
  }
  const extraSettings = args.settings
    ? (substitute(args.settings, fixtureVars) as Json)
    : null
  const seededSettings = extraSettings ? deepMerge(baseSettings, extraSettings) : baseSettings
  const seededConfig = { settings: seededSettings }
  writeFileSync(join(userData, 'config.json'), JSON.stringify(seededConfig, null, 2))

  // Launcher shim: redirect userData before the real main process reads it, and
  // keep the window on top so the compositor keeps painting it (an occluded
  // window returns a stale or empty frame to Page.captureScreenshot).
  const shim = join(runDir, '_launcher.js')
  writeFileSync(
    shim,
    [
      "const { app, dialog } = require('electron')",
      "app.setPath('userData', process.env.OASIS_H2H_USERDATA)",
      // Audit/trace export goes through a native save dialog, which a driver
      // cannot click. The dialog is answered with a fixed path instead. This
      // patches the *dialog*, never the app's own logic: what gets written, and
      // whether anything is written at all, is entirely the app's decision.
      'if (process.env.OASIS_H2H_SAVE_PATH) {',
      '  dialog.showSaveDialog = async () => ({ canceled: false, filePath: process.env.OASIS_H2H_SAVE_PATH })',
      '}',
      'app.on(\'browser-window-created\', (_e, w) => {',
      '  try { w.setAlwaysOnTop(true) } catch {}',
      // Window size is set on the real window rather than emulated, so layout,
      // screenshots and the app's own responsive breakpoints all agree.
      '  try {',
      '    const s = process.env.OASIS_H2H_WINDOW',
      "    if (s) { const [w0, h0] = s.split('x').map(Number); w.setSize(w0, h0); w.center() }",
      '  } catch {}',
      '})',
      'require(process.env.OASIS_H2H_MAIN)',
      ''
    ].join('\n')
  )

  const notes: string[] = []
  const shots: ShotRecord[] = []
  const actionLog: ActionRecord[] = []
  const turns: TurnRecord[] = []
  const settingsChecks: { path: string; expected: unknown; actual: unknown; ok: boolean }[] = []
  let child: ChildProcess | null = null
  let cdp: Cdp | null = null
  const appLog: string[] = []
  const snapshotsDir = join(runDir, 'snapshots')

  const shutdown = async (): Promise<void> => {
    cdp?.close()
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100)
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    for (const f of fixtures) await f.close()
  }

  try {
    // macOS stops compositing a window it considers occluded, and a capture box
    // is nearly always occluded — the frames simply stop, so every screenshot
    // after the first one times out with no error the app could report. These
    // are the standard flags for keeping a background window rendering; without
    // them a run comes back VALID carrying one image and four failures.
    const argv = [
      shim,
      `--remote-debugging-port=${args.port}`,
      '--remote-allow-origins=*',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling'
    ]
    const env: Record<string, string | undefined> = {
      ...process.env,
      OASIS_H2H_USERDATA: userData,
      OASIS_H2H_MAIN: mainEntry
    }
    if (args.windowSize) env.OASIS_H2H_WINDOW = `${args.windowSize.w}x${args.windowSize.h}`
    env.OASIS_H2H_SAVE_PATH = join(runDir, 'trace', 'audit.jsonl')
    mkdirSync(join(runDir, 'trace'), { recursive: true })
    delete env.ELECTRON_RUN_AS_NODE
    // cwd is the app root, not this repo: a dev build resolves its bundled
    // packs/ relative to its own app path.
    child = spawn(electron, argv, { cwd: appRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
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

    /* ------------------------------------------- seeded settings, verified */

    // What the app actually loaded, read back through its own settings API —
    // not out of the file we wrote. normalizeSettings() silently reverts values
    // it does not like (a non-loopback base URL, an out-of-range number), so a
    // seed that was rejected must fail the run rather than produce a run that
    // looks like the task it was not.
    const liveSettingsRaw = await cdp.evalString(
      `window.api.getSettings().then(s => JSON.stringify(s))`
    )
    const liveSettings = JSON.parse(liveSettingsRaw) as Json
    writeFileSync(join(runDir, '_settings-in-app.json'), `${JSON.stringify(liveSettings, null, 2)}\n`)
    if (extraSettings) {
      for (const { path, value } of leaves(extraSettings)) {
        const actual = atPath(liveSettings, path)
        const ok = JSON.stringify(actual) === JSON.stringify(value)
        settingsChecks.push({ path, expected: value, actual, ok })
      }
      const bad = settingsChecks.filter((c) => !c.ok)
      if (bad.length) {
        throw new Error(
          `the app did not take ${bad.length} seeded setting(s): ` +
            bad
              .map((b) => `${b.path} expected ${JSON.stringify(b.expected)} got ${JSON.stringify(b.actual)}`)
              .join('; ')
        )
      }
    }

    /* --------------------------------------------------- reference packs */

    // Installed through the app's own installer, exactly as pressing Install in
    // Settings → Library would: nothing is copied into the library behind the
    // app's back, so a pack that this build cannot install fails here.
    const packsInstalled: string[] = []
    if (args.packs.length) {
      for (const id of args.packs) {
        const res = await cdp.evalString(
          `window.api.libraryInstallBundled(${JSON.stringify(id)}).then(r => JSON.stringify(r)).catch(e => JSON.stringify({ error: String(e && e.message || e) }))`
        )
        const parsed = JSON.parse(res) as { error?: string; ok?: boolean }
        if (parsed.error) throw new Error(`installing pack "${id}" failed: ${parsed.error}`)
        packsInstalled.push(id)
      }
      const listRaw = await cdp.evalString(`window.api.libraryList().then(l => JSON.stringify(l))`)
      const list = JSON.parse(listRaw) as { id: string; docs: number; chunks: number }[]
      const missing = args.packs.filter((id) => !list.some((p) => p.id === id))
      if (missing.length) throw new Error(`packs did not install: ${missing.join(', ')}`)
      notes.push(
        `library: ${list.map((p) => `${p.id} (${p.docs} docs, ${p.chunks} chunks)`).join(', ')}`
      )
    }

    const installed = await cdp.evalString(INSTRUMENT)
    if (installed !== 'installed') notes.push(`sampler install returned "${installed}"`)

    // A screenshot is evidence, never a precondition. Page.captureScreenshot can
    // stall indefinitely when the compositor will not produce a frame — an
    // occluded or sleeping display does it — and a stalled frame grab must not
    // be able to void a run whose transcript, timings and DOM were all captured
    // fine. A failure is recorded in notes and in run.json's screenshot list,
    // so a critic reading the run knows an image is missing rather than absent.
    let shotFailures = 0
    const screenshot = async (
      phase: ShotRecord['phase'],
      atMs: number | null,
      label?: string
    ): Promise<void> => {
      // Every grab gets its OWN short-lived CDP connection, and two tries on it.
      //
      // A screenshot degrades the socket it was taken on: the first one usually
      // succeeds and everything after it — including the next screenshot —
      // stops answering, which is why runs came back VALID with one image and
      // three failures. Isolating each grab keeps that damage off the socket
      // the sampler and the driver share, and off the next grab.
      //
      // fromSurface:true is the window's real OS surface, which is what makes a
      // screenshot a picture of what a person would see; it also needs that
      // surface to exist, and an asleep or occluded display never answers. The
      // renderer's own compositor has no such dependency, so it is the fallback,
      // and each shot records which one produced it.
      let r: { data?: string } | null = null
      let surface: 'os' | 'renderer' = 'os'
      let lastErr = ''
      for (const fromSurface of [true, false]) {
        const shotCdp = new Cdp()
        try {
          await shotCdp.connect(target.webSocketDebuggerUrl as string)
          r = await shotCdp.send<{ data?: string }>(
            'Page.captureScreenshot',
            { format: 'png', fromSurface },
            30_000
          )
          surface = fromSurface ? 'os' : 'renderer'
          break
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err)
        } finally {
          try {
            shotCdp.close()
          } catch {
            /* the socket is going away either way */
          }
        }
      }
      const named = label ? `${phase}-${label.replace(/[^A-Za-z0-9._-]+/g, '-')}` : phase
      if (!r || !r.data) {
        shotFailures++
        notes.push(`screenshot (${named}) failed on both surfaces: ${lastErr || 'no data'}`)
        return
      }
      const buf = Buffer.from(r.data, 'base64')
      const name = `${String(shots.length + 1).padStart(2, '0')}-${named}.png`
      writeFileSync(join(shotsDir, name), buf)
      shots.push({
        file: `screenshots/${name}`,
        phase,
        atMsFromSend: atMs,
        bytes: buf.length,
        surface,
        ...(label ? { label } : {})
      })
    }

    const sampler: { state: PageState | null } = { state: null }
    let midShots = 0
    let lastMidAt = 0
    let timedOut = false

    const readState = async (): Promise<PageState> => {
      const raw = await cdp!.evalString(READ_STATE)
      const s = JSON.parse(raw) as PageState & { missing?: boolean }
      if (s.missing) throw new Error('the page reloaded mid-turn; the sampler is gone')
      sampler.state = s
      return s
    }

    /**
     * Types a message and starts the turn. Called once for the task prompt and
     * again for each `prompt` driver action; the sampler is re-armed in
     * between, so every turn gets its own honest t0.
     */
    let anyTurnSent = false
    const sendPrompt = async (text: string): Promise<string> => {
      if (anyTurnSent) {
        const r = await cdp!.evalString(`window.__h2h.reset(${JSON.stringify(text)})`)
        if (r !== 'reset') throw new Error(`sampler reset returned "${r}"`)
      }
      const p = JSON.stringify(text)
      // Type and send in ONE evaluate: no CDP round-trip may sit between the t0
      // stamp and the keydown that starts the turn.
      const sendRes = await cdp!.evalString(String.raw`(() => {
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
      anyTurnSent = true
      let method = 'enter'

      // Did Enter actually submit? If the composer still holds the text, fall
      // back to the Send button and re-stamp t0 so the reported latency stays true.
      let ok = false
      for (let i = 0; i < 20 && !ok; i++) {
        await sleep(50)
        ok = (await cdp!.evalString(`String(document.querySelector('textarea').value === '')`)) === 'true'
      }
      if (!ok) {
        const clickRes = await cdp!.evalString(String.raw`(() => {
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
        method = 'send-button'
        notes.push('Enter did not submit; the Send button was clicked instead and t0 was re-stamped')
        for (let i = 0; i < 20 && !ok; i++) {
          await sleep(50)
          ok = (await cdp!.evalString(`String(document.querySelector('textarea').value === '')`)) === 'true'
        }
        if (!ok) throw new Error('composer never cleared; the turn did not start')
      }
      return method
    }

    /**
     * The last turn's paint settle (SETTLE_TEXT), read by recordTurn. Held in a
     * slot rather than threaded through, because recordTurn is also called on
     * the path where no waitTurnEnd ran at all.
     */
    let settle: SettleResult | null = null

    /**
     * Polls the in-page clock until the composer leaves its streaming state,
     * then waits for the reply's text to stop changing and paint (SETTLE_TEXT).
     * Poll cadence affects only when the driver *learns* a thing happened,
     * never the recorded time of it — but the settle is not a poll cadence: it
     * is the difference between reading the transcript and reading a transcript
     * that is still being written.
     */
    const waitTurnEnd = async (budgetMs: number): Promise<boolean> => {
      const deadline = Date.now() + budgetMs
      for (;;) {
        const s = await readState()
        if (s.tEnd !== null) {
          settle = JSON.parse(await cdp!.evalString(SETTLE_TEXT)) as SettleResult
          return false
        }
        if (Date.now() > deadline) return true
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
    }

    const recordTurn = (index: number, prompt: string, method: string, s: PageState | null, to: boolean): void => {
      const base = s?.t0 ?? null
      const r = (t: number | null | undefined): number | null => (t == null || base == null ? null : t - base)
      turns.push({
        index,
        prompt,
        sendMethod: method,
        sendToFirstVisibleMs: r(s?.tFirstVisible),
        sendToTurnEndMs: r(s?.tEnd),
        sendToUserBubbleMs: r(s?.tUserBubble),
        sendToAssistantContainerMs: r(s?.tAssistantContainer),
        sendToStreamingStartMs: r(s?.tStreamStart),
        firstVisibleKind: s?.firstVisibleKind ?? null,
        endReason: to ? 'timeout' : (s?.endReason ?? null),
        timedOut: to,
        textSettledMs: settle ? settle.settledMs : null,
        textGrewAfterTurnEndChars: settle ? settle.charsWhenSettled - settle.charsAtTurnEnd : null,
        streamEdgeAtTurnEnd: settle ? settle.streamEdgeAtTurnEnd : null,
        streamEdgeClearedMs: settle ? settle.streamEdgeClearedMs : null
      })
      // Said out loud, not left for a reader to spot in a timing table: a build
      // that releases its composer mid-paint is the exact shape that makes a
      // reply.md/reply.txt diff lie, and a critic reading these artifacts has
      // to be told which of the two they are looking at.
      if (settle && !settle.quiet) {
        notes.push(
          `the reply's text was still changing ${settle.settledMs} ms after turn end and had not settled ` +
            'within the settle budget; the text artifacts may still be short of the finished answer'
        )
      } else if (settle && (settle.charsWhenSettled > settle.charsAtTurnEnd || settle.streamEdgeAtTurnEnd)) {
        notes.push(
          `the build reported this turn finished while it was still painting: ` +
            `${settle.charsWhenSettled - settle.charsAtTurnEnd} more character(s) landed over the ` +
            `${settle.settledMs} ms after turn end` +
            (settle.streamEdgeAtTurnEnd ? ', with the live-tail edge span still on screen' : '') +
            '. The text artifacts below were read after that settled, so a shortfall against reply.md ' +
            'is a real loss and not this lag'
        )
      }
      settle = null
    }

    /* -------------------------------------------------------- the driving */

    let sendMethod = 'enter'
    let currentPrompt = args.prompt
    let t0Absolute: number | null = null

    const ctx: ActionContext = {
      screenshot,
      snapshotsDir,
      waitTurnEnd: async (budget) => {
        const to = await waitTurnEnd(budget)
        timedOut = timedOut || to
        recordTurn(turns.length, currentPrompt, sendMethod, sampler.state, to)
        return to
      },
      sendPrompt: async (text) => {
        sendMethod = await sendPrompt(text)
        currentPrompt = text
        return sendMethod
      },
      budgetMs: args.timeoutMs
    }

    /** Runs one list of actions, logging each. `phase` labels them in run.json. */
    const runActions = async (list: Action[], phase: 'pre' | 'post'): Promise<void> => {
      for (let i = 0; i < list.length; i++) {
        const action = list[i]
        const startedMs = Date.now()
        const rel0 = t0Absolute == null ? null : startedMs - t0Absolute
        const log = (ok: boolean, result: string): void => {
          actionLog.push({
            index: actionLog.length,
            type: `${phase}:${action.type}`,
            detail: { ...action },
            atMsFromSend: rel0,
            durationMs: Date.now() - startedMs,
            ok,
            result
          })
        }
        try {
          log(true, await runAction(cdp!, action, ctx))
        } catch (e) {
          const result = e instanceof Error ? e.message : String(e)
          log(false, result)
          if (!action.optional) throw new Error(`driver action ${phase}[${i}] (${action.type}) failed: ${result}`)
          notes.push(`optional driver action ${phase}[${i}] (${action.type}) failed: ${result}`)
        }
      }
    }

    // Pre-actions: composer toggles the task needs set before Enter, and any
    // earlier turns the prompt is meant to land after.
    await runActions(args.preActions, 'pre')

    sendMethod = await sendPrompt(args.prompt)
    t0Absolute = (await readState()).t0
    const taskTurnIndex = turns.length

    // Post-actions run while the turn is live — pressing Stop or clicking
    // Cancel is only meaningful mid-turn. If none of them waits for the turn to
    // finish, the wait is appended.
    const actions: Action[] = [...args.actions]
    if (!actions.some((a) => a.type === 'waitTurnEnd')) actions.push({ type: 'waitTurnEnd' })
    await runActions(actions, 'post')

    if (turns.length === taskTurnIndex) {
      // No waitTurnEnd ran (an action list that only waits by clock). Record
      // whatever the sampler has so the run still reports a turn.
      recordTurn(taskTurnIndex, args.prompt, sendMethod, sampler.state, timedOut)
    }

    const t0 = sampler.state?.t0 ?? null
    const rel = (t: number | null | undefined): number | null =>
      t == null || t0 == null ? null : t - t0

    // A driver action may have opened a modal — VC2's traversal walks into
    // Settings — and a modal left open at turn end is in every screenshot that
    // follows. Screenshots are the one artifact make-blind-pairs cannot scrub,
    // and Settings → General renders the app's version number, which is the
    // strongest arm tell there is. This does not void a run; it makes the state
    // of the screen a stated fact rather than something a critic infers from
    // the picture.
    const overlayAtEnd = await cdp.evalString(String.raw`(() => {
      var all = document.querySelectorAll('div')
      for (var i = 0; i < all.length; i++) {
        var c = typeof all[i].className === 'string' ? all[i].className : ''
        if (c.indexOf('fixed inset-0') !== -1 && c.indexOf('z-50') !== -1) return 'open'
      }
      return 'none'
    })()`)
    const themeAtEnd = await cdp.evalString(
      `String(document.documentElement.classList.contains('dark') ? 'dark' : 'light')`
    )
    if (overlayAtEnd === 'open') {
      notes.push(
        'a modal overlay was open at turn end, so the turn-end screenshots show it rather than the ' +
          'transcript alone; a traversal that opens a surface should declare an "exit"'
      )
    }

    // Turn-end capture, in the state the app left it: collapsed blocks stay
    // collapsed, because that is what the user was looking at.
    const capRaw = await cdp.evalString(CAPTURE)
    const cap = JSON.parse(capRaw) as Capture
    await screenshot('turn-end', rel(sampler.state?.tEnd ?? null) ?? null)

    // Then open everything and capture again, for the reader who wants inside.
    const expanded = await cdp.evalString(EXPAND)
    await sleep(300)
    const capExpRaw = await cdp.evalString(CAPTURE)
    const capExp = JSON.parse(capExpRaw) as Capture
    await screenshot('turn-end-expanded', rel(sampler.state?.tEnd ?? null) ?? null)

    // The turn's own record, when the app was told to keep one. Several tasks
    // cross-check what the transcript SHOWS against what the app RECORDS as
    // having executed, and that comparison needs both halves.
    let auditExport: Record<string, unknown> | null = null
    if ((liveSettings.audit as Json | undefined)?.enabled === true) {
      const raw = await cdp.evalString(
        `window.api.auditExport().then(r => JSON.stringify(r)).catch(e => JSON.stringify({ ok: false, error: String(e && e.message || e) }))`
      )
      const res = JSON.parse(raw) as { ok?: boolean; entries?: number; chainValid?: boolean; error?: string }
      auditExport = {
        file: res.ok ? 'trace/audit.jsonl' : null,
        entries: res.entries ?? null,
        hashChainValid: res.chainValid ?? null,
        error: res.ok ? null : (res.error ?? 'export refused'),
        note:
          'The app\'s own append-only session record for this run, exported through its own ' +
          'Export-audit path. A task that compares "what the transcript shows" against "what the ' +
          'app says ran" reads this file for the second half.'
      }
      if (!res.ok) notes.push(`audit export failed: ${res.error ?? 'unknown'}`)
    }

    // The markdown the renderer was handed, beside the pixels it produced. See
    // RAW_MARKDOWN: this is the only artifact in the directory that is not
    // post-render, and it is what makes a rendering defect diagnosable at all.
    let rawMessages: RawMessage[] = []
    let rawError: string | null = null
    try {
      const res = JSON.parse(await cdp.evalString(RAW_MARKDOWN)) as {
        ok?: boolean
        messages?: RawMessage[]
        error?: string
      }
      if (res.ok) rawMessages = res.messages ?? []
      else rawError = res.error ?? 'unknown'
    } catch (e) {
      rawError = e instanceof Error ? e.message : String(e)
    }
    if (rawError) notes.push(`raw markdown unavailable: ${rawError}`)

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

    // Raw markdown, added rather than substituted: reply.txt stays the rendered
    // text every score is computed from, and reply.md is what produced it.
    const rawAssistants = rawMessages.filter((m) => m.role === 'assistant')
    const rawReply = rawAssistants.length ? rawAssistants[rawAssistants.length - 1].content : ''
    writeFileSync(join(runDir, 'reply.md'), rawReply ? `${rawReply}\n` : '')
    writeFileSync(join(runDir, 'messages-raw.json'), `${JSON.stringify(rawMessages, null, 2)}\n`)

    const blockCount = capExp.messages.reduce((n, m) => n + m.blocks.length, 0)
    const citationCount = capExp.messages.reduce((n, m) => n + m.citations.length, 0)

    /* ------------------------------------------------------------ fixtures */

    // The fixture logs are task evidence, not harness bookkeeping: a check like
    // "assert the search fixture was hit exactly once" is answered from here.
    // They carry no arm identity, so they are not underscore-prefixed.
    const fixtureReports: Record<string, unknown>[] = []
    const validityReasons: string[] = []
    if (fixtures.length) {
      mkdirSync(join(runDir, 'fixtures'), { recursive: true })
      for (const f of fixtures) {
        const file = `fixtures/${f.kind}.json`
        f.writeLog(join(runDir, file))
        fixtureReports.push({
          kind: f.kind,
          url: f.url,
          file,
          expectHit: f.expectHit,
          requestCount: f.requests.length,
          injectedCount: f.injected().length,
          actions: f.requests.map((r) => r.action)
        })
        if (f.requests.length === 0 && f.expectHit) {
          validityReasons.push(
            `the ${f.kind} fixture was configured but never received a request — the app did not ` +
              'use it, so this run did not exercise the path the task is about'
          )
        }
      }
    }

    /* ------------------------------------------------------ preconditions */

    // The fixture guard only sees tasks that have fixtures. A task whose setup
    // needs something from the machine instead — TTU2's "resources/pyodide
    // present locally" — had nothing checking it, so a run that never paid the
    // Pyodide boot at all came back VALID with an empty reason list. What the
    // task declares it needs is checked here, against the build and against the
    // transcript. See scripts/h2h-preconditions.ts.
    const preconditionReports = checkPreconditions({
      required: requiredCapabilities(args.settings, args.requires),
      appRoot,
      mainDir: dirname(mainEntry),
      blocks: capExp.messages.flatMap((m) => m.blocks)
    })
    for (const p of preconditionReports) if (p.reason) validityReasons.push(p.reason)

    // A turn that never ended is not a result. The precondition guard asks
    // whether the run COULD exercise its task; this asks whether it DID. One
    // arm once timed out at 300 s with the composer still on Stop, mid
    // verification pass, and was written out VALID — so a hang in the build
    // under test read as a comparable capture. It is not: there is no turn to
    // compare, and the timing figures are floors, not measurements.
    if (timedOut) {
      validityReasons.push(
        `the turn had not finished after ${args.timeoutMs} ms — the capture is of an unfinished turn, ` +
          'so this run did not produce a result to compare'
      )
    }

    const validity = validityReasons.length ? 'INVALID' : 'VALID'

    const run = {
      schema: 'h2h-capture/1',
      taskId: args.taskId,
      prompt: args.prompt,
      startedAtIso: startedAt.toISOString(),
      finishedAtIso: new Date().toISOString(),
      send: { method: turns[taskTurnIndex]?.sendMethod ?? sendMethod },
      timings: {
        sendToFirstVisibleMs: turns[taskTurnIndex]?.sendToFirstVisibleMs ?? null,
        sendToTurnEndMs: turns[taskTurnIndex]?.sendToTurnEndMs ?? null,
        sendToUserBubbleMs: turns[taskTurnIndex]?.sendToUserBubbleMs ?? null,
        sendToAssistantContainerMs: turns[taskTurnIndex]?.sendToAssistantContainerMs ?? null,
        sendToStreamingStartMs: turns[taskTurnIndex]?.sendToStreamingStartMs ?? null,
        firstVisibleKind: turns[taskTurnIndex]?.firstVisibleKind ?? null,
        endReason: turns[taskTurnIndex]?.endReason ?? null,
        timedOut: turns[taskTurnIndex]?.timedOut ?? timedOut,
        taskTurnIndex,
        turnNote:
          'These figures are the task prompt\'s own turn (index taskTurnIndex in "turns"). A task whose driver sent follow-up ' +
          'turns reports each of them in "turns" below, in order.',
        clock:
          'page Date.now(); t0 is stamped in the same evaluate that dispatches the Enter keydown, ' +
          'so CDP round-trips and screenshot stalls are excluded from every figure here',
        samplingIntervalMs: sampler.state?.sampleMs ?? null,
        samplingNote:
          'a MutationObserver plus a ' +
          `${sampler.state?.sampleMs ?? 20} ms interval; first-visible and turn-end are therefore accurate to about ` +
          `${sampler.state?.sampleMs ?? 20} ms, not better`,
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
            'elsewhere on screen.',
          textSettledMs:
            'how long AFTER turnEnd the driver had to wait for the reply\'s rendered text to stop ' +
            'changing and paint. Every text artifact in this directory was read after that wait, so ' +
            'they are the finished answer rather than a half-painted one.',
          textGrewAfterTurnEndChars:
            'how many characters of the answer landed during that wait. Above zero, the build released ' +
            'its composer — turned Stop back into Send, and accepted a new message — while it was still ' +
            'painting the last one, which is a defect in the build and is reported as a note. It is ' +
            'ALSO the figure that tells you a short reply.txt is a paint lag rather than a renderer ' +
            'loss: a shortfall against reply.md is a real loss only if this is zero.',
          streamEdgeAtTurnEnd:
            'whether the live-tail edge span (.stream-edge, the newest word of a streaming reply) was ' +
            'still in the document at turnEnd. True is the same defect seen from the DOM side.'
        }
      },
      reply: { file: 'reply.txt', chars: replyText.length, words: replyText.split(/\s+/).filter(Boolean).length },
      rawMarkdown: {
        replyFile: 'reply.md',
        messagesFile: 'messages-raw.json',
        chars: rawReply.length,
        messageCount: rawMessages.length,
        error: rawError,
        note:
          'The markdown the renderer was GIVEN, read through the app\'s own listConversations API. ' +
          'Every other text artifact here is innerText, which is post-render: reply.txt records what ' +
          'the renderer drew, reply.md records what it was asked to draw. Diff them to tell a model ' +
          'defect from a rendering defect — if a figure is present in reply.md and absent from ' +
          'reply.txt, the app lost it. Absent when the run used an ephemeral conversation, which is ' +
          'never persisted; "error" then says so. ' +
          'One caveat, and it has a number attached: a build that reports its turn finished while it ' +
          'is still painting makes this diff show a loss that never happened. reply.txt is therefore ' +
          'read only after the rendered text has settled (see timing.definitions.textSettledMs), and ' +
          'timing.textGrewAfterTurnEndChars says whether that build needed the wait. A trailing ' +
          'shortfall against reply.md is a renderer loss; if you are ever unsure, that figure is the ' +
          'one to check.'
      },
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
      turns,
      setup: {
        packsInstalled,
        /**
         * Every leaf of the --settings file, read back out of the running app
         * through its own settings API. The run fails before the turn if any of
         * these disagree, so a VALID run always shows them all true.
         */
        seededSettingsVerified: settingsChecks,
        windowSize: args.windowSize,
        viewportNote:
          'A "viewport" driver action changes the layout viewport through CDP emulation, not the ' +
          'OS window; --window sets the real window size before the app paints.'
      },
      /**
       * Everything the driver did to the app after Enter, in order, with the
       * time from send at which it happened. A critic reading a transcript that
       * shows a cancelled plan or an interrupted turn can see here that the
       * driver is what cancelled or interrupted it.
       */
      driverActions: actionLog,
      fixtures: fixtureReports,
      /**
       * Every capability the task's setup requires of the machine, and whether
       * it was really there — one entry per capability, passed or failed, so a
       * reader sees that the check ran rather than inferring it from silence.
       */
      preconditions: preconditionReports,
      auditExport,
      /**
       * VALID or INVALID. INVALID means the run did not exercise the path the
       * task is about — a configured fixture was never contacted, or a
       * precondition the task declares did not hold — and must be reported as
       * such rather than scored.
       */
      validity,
      validityReasons,
      screenshots: shots,
      // Stated, not implied: a critic must be able to tell "no image here"
      // from "an image that was never taken".
      screenshotsFailed: shotFailures,
      viewport: cap.viewport,
      /**
       * The screen's state when the run's own artifacts were taken. `theme` is
       * read off the document, not off the seeded config, so a task that
       * switched themes mid-run reports where it finished; `overlayOpen` says
       * whether a modal a driver action opened was still covering the app.
       */
      screenAtTurnEnd: { theme: themeAtEnd, overlayOpen: overlayAtEnd === 'open' },
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
      pkgVersion = (JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown'
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
          baseUrl: String(seededSettings.baseUrl),
          appRoot,
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
        `screenshots        ${shots.map((s) => `${s.phase}:${s.bytes}B`).join('  ') || 'none'}`,
        `turns              ${turns.map((t) => `#${t.index} ${fmt(t.sendToTurnEndMs)}`).join('  ')}`,
        `driver actions     ${actionLog.map((a) => `${a.type}${a.ok ? '' : '!'}`).join(' → ') || 'none'}`,
        `preconditions      ${
          preconditionReports.length
            ? preconditionReports.map((p) => `${p.capability}:${p.ok ? 'held' : 'FAILED'}`).join('  ')
            : 'none declared'
        }`,
        `fixtures           ${
          fixtureReports.length
            ? fixtureReports.map((f) => `${String(f.kind)}:${String(f.requestCount)} req`).join('  ')
            : 'none'
        }`,
        `validity           ${validity}${validityReasons.length ? ` — ${validityReasons.join('; ')}` : ''}`,
        notes.length ? `notes              ${notes.join(' | ')}` : 'notes              none',
        ''
      ].join('\n')
    )
    if (validity === 'INVALID') process.exitCode = 3
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
appeared on screen. Every measurement here is a screen measurement. The two
exceptions are named as such below (reply.md / messages-raw.json, and
trace/audit.jsonl): they are read back through the application's own public
APIs, and they exist precisely so that what is on screen can be checked
against what the application was working from.

FILES
  prompt.txt               the task, verbatim, as it was typed
  reply.txt                the final answer's rendered text
  reply.md                 the same answer's RAW markdown — what the renderer
                           was handed, before it drew anything. reply.txt is
                           post-render by construction, so a defect in the
                           rendering is invisible there; diff the two and a
                           character present in reply.md but missing from
                           reply.txt was lost by the application, not by the
                           model. Empty if the run used an ephemeral chat,
                           which is never persisted (run.json says so).
                           One way this diff can lie, and the figure that
                           settles it: a build that reports its turn finished
                           while it is still painting leaves reply.txt short of
                           an answer it never lost. reply.txt is therefore read
                           only after the rendered text has stopped changing,
                           and run.json's turns[].textGrewAfterTurnEndChars
                           says whether this build needed that wait. A trailing
                           shortfall with that figure at 0 is a real loss.
  messages-raw.json        every message's raw content (and raw reasoning),
                           in order — the un-rendered counterpart to
                           transcript.json
  transcript.txt           everything visible in the transcript at turn end.
                           Collapsed sections appear as their headers only,
                           because that is all the user could see.
  transcript-expanded.txt  the same transcript after every collapsed section
                           was opened, so their contents are readable
  transcript.json          the expanded transcript, structured per message:
                           role, full text, prose, inline blocks (tool calls,
                           plans, reasoning, code runs), citation strips and
                           any red/error text
  run.json                 timings, counts, and the definitions behind them,
                           plus every action the driver took and whether the
                           run is VALID (see below)
  screenshots/             mid-turn frames and the frame at turn end, plus one
                           with every section expanded
  snapshots/               DOM captured at named moments the driver chose (for
                           example, a plan block before and after Cancel);
                           styles-*.json, which records for every piece of prose
                           the two colours a contrast ratio is computed from —
                           the ink as it composited over its real background,
                           that background, and the surfaces that produced it;
                           and tab-traverse-*.json, one entry per Tab press of a
                           keyboard-only walk through the app, with the computed
                           style of each stop focused and unfocused, which
                           properties differ between the two, whether anything
                           is drawn over the control, and every control the walk
                           pressed. Where a name ends in -light or -dark, the
                           same measurement was taken twice on one screen: the
                           app was switched between themes through its own
                           Settings panel and switched back afterwards, so the
                           two readings are of the same reply and the same
                           layout rather than of two different runs.
  fixtures/                every request the task's loopback servers served. If
                           a task claims to have exercised a fixture, it is
                           here that the claim is checked.
  trace/audit.jsonl        present only when the run was told to keep a session
                           audit log: the application's own append-only record
                           of the turn. Where the transcript shows what the
                           reader saw, this shows what the application says
                           happened — the two are meant to be compared.

VALIDITY
  run.json carries validity: VALID or INVALID. INVALID means the run did not
  exercise the path the task is about — a fixture that was set up and then
  never contacted, or a precondition the task's setup declares that did not
  actually hold (the local Python runtime being absent, say, so every Python
  block failed on a runtime that was never installed). validityReasons says
  which, and run.json's "preconditions" lists every capability that was checked
  and what was found. An INVALID run must be reported as invalid, not scored
  against the other arm.

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
