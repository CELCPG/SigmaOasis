/**
 * The keyboard-traversal and theme instruments the capture harness injects.
 *
 * These live apart from scripts/h2h-capture.ts for two reasons. The first is
 * that h2h-capture.ts runs main() at module load, so nothing can import it and
 * nothing can test it. The second is that this is *browser* code written as
 * strings: it can only be exercised in a real window, and test/tabTraverseCheck
 * .ts does exactly that against the very strings the harness sends. A copy in
 * a test would pin the copy.
 *
 * What the traversal is for: VC2 asks whether a keyboard-only user can follow
 * the app's own answer to the settings it names, and whether the focus ring is
 * visible at every stop on the way. Through round 7 the traversal pressed Tab
 * and recorded; it never pressed anything else, so it stopped at the Settings
 * button and the task's actual question went unanswered. Activation is what
 * turns a walk up to the door into a walk through it.
 */

/**
 * What is measured at every stop, focused and unfocused. The pair is the whole
 * point: a focus indicator is a *difference*, so an absolute reading of the
 * focused state cannot decide whether anything is visible.
 */
export const FOCUS_STYLE_KEYS = [
  'outlineStyle',
  'outlineWidth',
  'outlineColor',
  'outlineOffset',
  'boxShadow',
  'borderColor',
  'backgroundColor',
  'color'
] as const

/**
 * Everything a Tab press can land on. Deliberately a superset — an element
 * with tabindex="-1" is not a Tab stop but costs nothing to measure, and a
 * baseline that is a superset can never be missing an entry the traversal
 * needs.
 */
export const FOCUSABLE_SELECTOR = 'a[href],button,input,select,textarea,[tabindex]'

const KEYS_JSON = JSON.stringify(FOCUS_STYLE_KEYS)
const SEL_JSON = JSON.stringify(FOCUSABLE_SELECTOR)

/**
 * Shared page-side helpers, installed once per traversal.
 *
 * `surfaceOf` names which surface a stop is on. The app's overlays are all
 * `fixed inset-0 … z-50`, so an element under one of those is "overlay" and
 * everything else is "page". A critic reading a traversal needs that
 * distinction to say "these twelve stops are inside Settings" without
 * guessing from the labels.
 */
const HELPERS = String.raw`
  var KEYS = ${KEYS_JSON}
  function snap(el) {
    var cs = getComputedStyle(el), o = {}
    for (var i = 0; i < KEYS.length; i++) o[KEYS[i]] = cs[KEYS[i]]
    return o
  }
  function surfaceOf(el) {
    for (var n = el; n; n = n.parentElement) {
      var c = typeof n.className === 'string' ? n.className : ''
      if (c.indexOf('fixed inset-0') !== -1 && c.indexOf('z-50') !== -1) return 'overlay'
    }
    return 'page'
  }
  function labelOf(el) {
    return (el.getAttribute('aria-label') || el.getAttribute('title') || (el.innerText || '').trim()).slice(0, 80)
  }
`

/**
 * Captures, for every focusable element, its computed style while NOT focused,
 * then puts the walk back at the top of the document.
 *
 * Blurring is not enough on its own, and the difference is not cosmetic.
 * Chromium keeps a *sequential focus navigation starting point*, and blur()
 * leaves it where the focus was. A run's first traversal is taken moments after
 * the driver typed into the composer, so it began mid-document and reached
 * Settings at stop 26, while every later traversal began at the sidebar and
 * reached it at stop 8. Two traversals of one route are only comparable if they
 * start in the same place; a light-versus-dark count that is not stop-for-stop
 * aligned is not a comparison at all.
 *
 * What moves the starting point is focusing something, so the body is made
 * focus-only (`tabindex="-1"`, the skip-link pattern) and focused. The next Tab
 * then lands on the document's first tab stop — by keyboard, so the stop is
 * measured with the focus state a keyboard user would actually get. The
 * attribute is taken off again in TAB_RESOLVE, and the baseline is built before
 * it goes on, so the body is never counted as a focusable of the app's.
 *
 * `startedFrom` is recorded rather than assumed: if this ever stops working,
 * the run says where it really began instead of quietly comparing two
 * different walks.
 */
export const TAB_BASELINE = String.raw`(() => {
  ${HELPERS}
  var startedFrom = document.activeElement && document.activeElement !== document.body
    ? (document.activeElement.tagName.toLowerCase() + ' ' + labelOf(document.activeElement)).trim()
    : 'nothing'
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur()
  var map = new WeakMap()
  var all = document.querySelectorAll(${SEL_JSON})
  for (var i = 0; i < all.length; i++) map.set(all[i], snap(all[i]))
  var hadTabIndex = document.body.hasAttribute('tabindex')
  if (!hadTabIndex) document.body.setAttribute('tabindex', '-1')
  document.body.focus()
  window.__h2hTab = {
    map: map, snap: snap, keys: KEYS, sel: ${SEL_JSON},
    surfaceOf: surfaceOf, labelOf: labelOf, seen: [],
    hadTabIndex: hadTabIndex, startedFrom: startedFrom
  }
  return JSON.stringify({
    focusables: all.length,
    startedFrom: startedFrom,
    reset: document.activeElement === document.body
  })
})()`

/**
 * Adds anything that appeared since the last baseline pass, measured unfocused.
 *
 * Run after every activation. Without it, every control inside the panel the
 * traversal just opened carries `unfocused: null` — the elements did not exist
 * when the baseline ran — and "is the focus visible here" becomes undecidable
 * for exactly the stops the task is about.
 *
 * The currently focused element is skipped rather than measured wrong: reading
 * it now would record its FOCUSED style as its unfocused one. TAB_RESOLVE
 * picks it up afterwards.
 */
export const TAB_REBASELINE = String.raw`(() => {
  var T = window.__h2hTab
  if (!T) return '0'
  var all = document.querySelectorAll(T.sel)
  var added = 0
  for (var i = 0; i < all.length; i++) {
    var el = all[i]
    if (T.map.has(el) || el === document.activeElement) continue
    T.map.set(el, T.snap(el))
    added++
  }
  return String(added)
})()`

/** Reads the focused element and both style states at one Tab stop. */
export function tabStop(stop: number): string {
  return String.raw`(() => {
  var T = window.__h2hTab
  var el = document.activeElement
  if (!el || el === document.body) return JSON.stringify({ stop: ${stop}, tag: null })
  T.seen.push({ stop: ${stop}, el: el })
  var r = el.getBoundingClientRect()
  // What a click at the element's own centre would actually hit. An element
  // behind a modal scrim is still focusable, still "in the viewport" and still
  // completely unusable; nothing in the record said so before.
  var top = null
  if (r.width > 0 && r.height > 0) {
    top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
  }
  var obscured = !!top && top !== el && !el.contains(top) && !top.contains(el)
  var focusVisible = false
  try { focusVisible = el.matches(':focus-visible') } catch (e) { focusVisible = false }
  function describe(n) {
    if (!n) return null
    var c = typeof n.className === 'string' ? n.className.trim() : ''
    return n.tagName.toLowerCase() + (c ? '.' + c.split(/\s+/).slice(0, 3).join('.') : '')
  }
  return JSON.stringify({
    stop: ${stop},
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type'),
    label: T.labelOf(el),
    className: typeof el.className === 'string' ? el.className.slice(0, 200) : '',
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    inViewport: r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth,
    surface: T.surfaceOf(el),
    obscured: obscured,
    obscuredBy: obscured ? describe(top) : null,
    matchesFocusVisible: focusVisible,
    focused: T.snap(el),
    unfocused: T.map.get(el) || null
  })
})()`
}

/** The focused element's label, without recording a stop. Used while looking for the exit. */
export const TAB_PEEK = String.raw`(() => {
  var T = window.__h2hTab
  var el = document.activeElement
  if (!el || el === document.body) return ''
  return T.labelOf(el)
})()`

/**
 * The state an activation is judged against.
 *
 * A driver that presses Enter and assumes it worked is the worst kind of
 * driver: it reports a journey it never took. So activation is decided by
 * comparing the page before and after, and the two fingerprints are written
 * into the record for a critic to check.
 */
export const TAB_FINGERPRINT = String.raw`(() => {
  var overlay = null
  var all = document.querySelectorAll('div')
  for (var i = 0; i < all.length; i++) {
    var c = typeof all[i].className === 'string' ? all[i].className : ''
    if (c.indexOf('fixed inset-0') !== -1 && c.indexOf('z-50') !== -1) { overlay = all[i]; break }
  }
  // document.body is excluded: TAB_BASELINE borrows a tabindex on it to put the
  // walk back at the top of the document, and counting that would make every
  // figure in the record one larger than the app's own.
  var focusable = document.querySelectorAll(${SEL_JSON})
  var n = 0
  for (var j = 0; j < focusable.length; j++) if (focusable[j] !== document.body) n++
  return JSON.stringify({
    focusables: n,
    overlay: !!overlay,
    // Length only, never the text: an overlay's prose can carry the app
    // version, and this string is staged to a blind critic.
    overlayTextLength: overlay ? (overlay.innerText || '').length : 0
  })
})()`

/**
 * Measures every element the traversal touched, unfocused, after the walk.
 *
 * The inverse of TAB_REBASELINE and the reason nothing is left undecidable:
 * anything that appeared *and* was focused before a rebaseline could reach it
 * is caught here. Elements the traversal unmounted on its way through report
 * null and say so rather than being quietly dropped.
 */
export const TAB_RESOLVE = String.raw`(() => {
  var T = window.__h2hTab
  if (!T) return '[]'
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur()
  // The app's DOM goes back exactly as it was found.
  if (!T.hadTabIndex) document.body.removeAttribute('tabindex')
  var out = []
  for (var i = 0; i < T.seen.length; i++) {
    var s = T.seen[i]
    out.push({ stop: s.stop, style: s.el.isConnected ? T.snap(s.el) : null })
  }
  return JSON.stringify(out)
})()`

/** What a theme reading consists of: the setting, the switch, and the paint. */
export interface ThemeReading {
  setting: string
  dark: boolean
  htmlClass: string
  bodyBackground: string
  overlayOpen: boolean
}

/**
 * Everything needed to tell whether the app is really in a theme.
 *
 * Three readings, because two of them can disagree and the disagreement is the
 * whole risk. `setting` is what the app persisted; `dark` is the class the
 * stylesheet keys on; `bodyBackground` is a colour that actually rendered. A
 * capture labelled "dark" is only honest when all three moved together — and
 * they genuinely can come apart here: the renderer reads settings once at mount
 * and has no settings-changed event, so a write that does not go through the
 * app's own Settings panel leaves the store holding the old theme. The panel
 * then repaints from that stale store the moment it opens (`draft.theme`) and
 * again when it closes (`revertAppearance`), silently putting the screen back.
 * That is exactly how a run once walked four traversals labelled dark, two of
 * which were light.
 */
export const THEME_READ = String.raw`(() => {
  var overlay = false
  var all = document.querySelectorAll('div')
  for (var i = 0; i < all.length; i++) {
    var c = typeof all[i].className === 'string' ? all[i].className : ''
    if (c.indexOf('fixed inset-0') !== -1 && c.indexOf('z-50') !== -1) { overlay = true; break }
  }
  return JSON.stringify({
    setting: null,
    dark: document.documentElement.classList.contains('dark'),
    htmlClass: document.documentElement.className,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    overlayOpen: overlay
  })
})()`

/** The persisted theme, read back through the app's own settings API. */
export const THEME_SETTING = String.raw`window.api.getSettings().then(function (s) { return String(s.theme) })`

/**
 * Every piece of prose in a scope, with the two colours a contrast ratio is
 * computed from.
 *
 * VC3's checks are per-text-node contrast ratios and there was nothing in a run
 * directory to compute one from: snapshots carry outerHTML and innerText, and
 * neither says what colour anything actually rendered in. The README has
 * promised a `styles.json` "in both themes" since the protocol was written; it
 * did not exist.
 *
 * The ratio itself is deliberately NOT computed here. The harness records; the
 * scoring pass judges. What is recorded is everything the judgement needs: the
 * composited foreground RGB (the app's muted ink is rgba(…,0.32), so the raw
 * colour is not what anyone sees), the background it was composited over, the
 * chain of surfaces that produced that background, and the font metrics that
 * decide which threshold applies.
 */
export function stylesIn(scopeExpression: string): string {
  return String.raw`(() => {
  var scope = ${scopeExpression}
  if (!scope) return JSON.stringify({ ok: false })

  function parse(c) {
    var m = /rgba?\(([^)]+)\)/.exec(c || '')
    if (!m) return null
    var p = m[1].split(',').map(function (s) { return parseFloat(s) })
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
  }
  // Source-over, with the result's alpha carried forward. Forcing it to 1 after
  // one step is the mistake that makes a 5%-white veil behave like opaque white:
  // an "Assistant" pill measured that way came back as pale blue on a black
  // screen, and every ratio computed from it would have been fiction.
  function over(f, b) {
    var a = f.a + b.a * (1 - f.a)
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
    return {
      r: (f.r * f.a + b.r * b.a * (1 - f.a)) / a,
      g: (f.g * f.a + b.g * b.a * (1 - f.a)) / a,
      b: (f.b * f.a + b.b * b.a * (1 - f.a)) / a,
      a: a
    }
  }
  function round(c) { return [Math.round(c.r), Math.round(c.g), Math.round(c.b)] }

  // The effective background is a stack, not a value: the app layers a tinted
  // pill on a glass veil on a panel on the canvas, and every layer may be
  // translucent. Walk up compositing until the accumulation is opaque.
  function backgroundOf(el) {
    var chain = [], acc = { r: 0, g: 0, b: 0, a: 0 }, resolved = 'canvas'
    for (var n = el; n; n = n.parentElement) {
      var raw = getComputedStyle(n).backgroundColor
      var c = parse(raw)
      if (!c || c.a === 0) continue
      chain.push({ node: n.tagName.toLowerCase(), color: raw })
      acc = over(acc, c)
      if (acc.a >= 0.999) { resolved = 'opaque-layer'; break }
    }
    // Nothing opaque anywhere up the tree: what shows through is the browser's
    // own canvas, which is white. Stated, because a stack that never bottoms
    // out is a different measurement from one that did.
    if (acc.a < 0.999) acc = over(acc, { r: 255, g: 255, b: 255, a: 1 })
    return { rgb: round(acc), chain: chain, resolved: resolved }
  }

  var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null)
  var nodes = [], node
  while ((node = walker.nextNode())) {
    var text = (node.nodeValue || '').replace(/\s+/g, ' ').trim()
    if (text.replace(/\s/g, '').length < 3) continue
    var el = node.parentElement
    if (!el) continue
    var cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none') continue
    var r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    var bg = backgroundOf(el)
    var fg = parse(cs.color)
    if (!fg) continue
    var opacity = parseFloat(cs.opacity)
    if (Number.isFinite(opacity) && opacity < 1) fg = { r: fg.r, g: fg.g, b: fg.b, a: fg.a * opacity }
    nodes.push({
      text: text.slice(0, 120),
      tag: el.tagName.toLowerCase(),
      className: typeof el.className === 'string' ? el.className.slice(0, 200) : '',
      fontSizePx: parseFloat(cs.fontSize),
      fontWeight: cs.fontWeight,
      colorComputed: cs.color,
      opacity: cs.opacity,
      foregroundRgb: round(over(fg, { r: bg.rgb[0], g: bg.rgb[1], b: bg.rgb[2], a: 1 })),
      backgroundRgb: bg.rgb,
      backgroundResolved: bg.resolved,
      backgroundChain: bg.chain
    })
  }
  return JSON.stringify({ ok: true, nodes: nodes })
})()`
}

/* ------------------------------------------------------- pure orchestration */

/** One activation the traversal is allowed to perform, in order. */
export interface ActivationSpec {
  /** Case-insensitive regular expression source, matched against the stop's label. */
  match: string
  /** Why this stop is activated. Copied into the record so the route is justified, not just taken. */
  note?: string
}

/**
 * Which activation, if any, this stop should fire.
 *
 * Strictly ordered: spec[i] is eligible only once spec[0..i-1] have fired. The
 * app's own labels repeat across surfaces — "Search" is a sidebar control and
 * a Settings tab — and an unordered matcher would fire on the first one it saw
 * and send the traversal somewhere the task did not ask for.
 */
export function nextActivation(
  label: string | null,
  specs: ActivationSpec[],
  fired: number
): { index: number; spec: ActivationSpec } | null {
  if (fired >= specs.length) return null
  if (!label) return null
  const spec = specs[fired]
  let re: RegExp
  try {
    re = new RegExp(spec.match, 'i')
  } catch {
    return null
  }
  return re.test(label) ? { index: fired, spec } : null
}

/** A style reading, as the page reports it. */
export type StyleSnapshot = Record<string, string>

export interface TabStopRow {
  stop: number
  tag: string | null
  label?: string
  unfocused?: StyleSnapshot | null
  unfocusedSource?: 'pre' | 'post' | null
  [key: string]: unknown
}

/**
 * Fills in the unfocused reading for stops the pre-traversal baseline could not
 * cover, and states where each one came from.
 *
 * 'pre'  — measured before the traversal, or right after the activation that
 *          created the element. The best reading: nothing had been focused yet.
 * 'post' — measured after the traversal, with focus cleared. Used for the
 *          elements that were focused at every moment a baseline pass ran.
 * null   — the element no longer exists; the traversal itself unmounted it.
 *          Recorded as unknown rather than as "no difference", which would
 *          score a missing measurement as a passing one.
 */
export function mergeUnfocused(
  rows: TabStopRow[],
  resolved: { stop: number; style: StyleSnapshot | null }[]
): TabStopRow[] {
  const byStop = new Map(resolved.map((r) => [r.stop, r.style]))
  return rows.map((row) => {
    if (row.tag === null) return row
    const unfocused = row.unfocused ?? byStop.get(row.stop) ?? null
    const source = row.unfocused ? 'pre' : unfocused ? 'post' : null
    return {
      ...row,
      unfocused,
      unfocusedSource: source as 'pre' | 'post' | null,
      styleDeltaKeys: styleDelta(row.focused as StyleSnapshot | undefined, unfocused)
    }
  })
}

/**
 * Which recorded properties read differently focused than unfocused.
 *
 * A fact, not a verdict — and the fact a scorer most needs, because both of the
 * obvious questions are the wrong one. "Do the two readings differ?" scores a
 * colour change on an outline of zero width as a visible ring. "Did the outline
 * width or style change?" scores the opposite mistake, and this app is a
 * recorded instance of it: its inputs carry a permanent `2px solid` outline
 * whose colour is `rgba(0, 0, 0, 0)` until focus turns it teal, so `outlineColor`
 * is the ONLY property that moves on a ring that is plainly visible.
 *
 * Naming the keys, beside the absolute values of both states, is what lets the
 * scoring pass tell those two apart instead of being forced into one of them.
 */
export function styleDelta(
  focused: StyleSnapshot | undefined,
  unfocused: StyleSnapshot | null
): string[] | null {
  if (!focused || !unfocused) return null
  return Object.keys(focused).filter((k) => focused[k] !== unfocused[k])
}

/**
 * Did activating this stop change anything?
 *
 * Any of the three moving is enough: a new surface opened, the number of
 * focusable controls changed, or the open surface's content changed size. A
 * Settings tab switch moves the last two; opening Settings moves all three.
 */
export interface Fingerprint {
  focusables: number
  overlay: boolean
  overlayTextLength: number
}

export function fingerprintChanged(before: Fingerprint, after: Fingerprint): boolean {
  return (
    before.focusables !== after.focusables ||
    before.overlay !== after.overlay ||
    before.overlayTextLength !== after.overlayTextLength
  )
}
