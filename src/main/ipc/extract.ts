/**
 * HTML → readable text, main content, and outbound links.
 *
 * Two problems this solves over the v0.6 `htmlToText`:
 *
 * 1. **Site chrome reached the model.** The old version dropped `<nav>`,
 *    `<footer>` and friends by tag name, but most of the web builds those out of
 *    `<div class="nav">`, so menus, cookie banners and "related stories" rails
 *    landed in the model's context and competed with the article for the
 *    truncation budget. Chrome is now removed by class/id as well, and the
 *    article container is selected by text density.
 * 2. **Links were thrown away.** An agent that reads a page and finds a
 *    reference to follow had no way to follow it — it had to go back through the
 *    search provider, spending both egress and a tool round-trip. Outbound links
 *    are now returned, resolved and deduped.
 *
 * Deliberately string-based rather than DOM-based: the main process has no DOM,
 * and pulling one in to read a page is a large dependency and a large attack
 * surface for something this mechanical. The tradeoff is that extraction is
 * heuristic — hence the caps and safety rails below, and hence
 * `mainContentFound` being reported rather than assumed.
 */

export interface ExtractedLink {
  url: string
  /** Anchor text, trimmed and collapsed. */
  text: string
  /** False when the link points at a different registrable host. */
  sameSite: boolean
}

export interface ExtractedPage {
  title: string
  text: string
  links: ExtractedLink[]
  /** True when a main-content container was identified and used. */
  mainContentFound: boolean
}

/** Outbound links returned per page. */
const MAX_LINKS = 60
/**
 * An element holding more than this share of the page's text is never treated as
 * chrome, however its class reads. Without this rail a wrapper like
 * `<div class="page-header-wrapper">` around the whole article deletes the page.
 */
const MAX_CHROME_TEXT_SHARE = 0.5
/**
 * Share of the document's score a container must retain to count as the main
 * content. A container always scores *at most* what the whole document does,
 * since the document contains it — so the test is retention, not excess. A
 * container holding most of the prose is a tighter wrapper around the same
 * article; one holding a third of it is just a section, and taking it would
 * silently drop two thirds of the page.
 */
const MAIN_CONTENT_RETENTION = 0.6
/** Absolute floor, so a stray div on a near-empty page is never "the article". */
const MIN_MAIN_TEXT = 160
/** Nesting depth explored when looking for containers. */
const MAX_CANDIDATE_DEPTH = 6
/** Link-heavy blocks are navigation, not prose. */
const NAV_LINK_DENSITY = 0.5

/** Elements whose content is never useful as text. */
const DROPPED_TAGS = [
  'script', 'style', 'noscript', 'svg', 'canvas', 'iframe', 'form',
  'template', 'select', 'button', 'video', 'audio', 'object', 'embed'
]

/** Elements that are structurally site chrome. */
const CHROME_TAGS = ['nav', 'header', 'footer', 'aside']

/** Class/id fragments that mark a container as site chrome rather than content. */
const CHROME_PATTERN =
  /\b(?:nav|navbar|navigation|menu|sidebar|side-bar|breadcrumb|footer|header|masthead|banner|cookie|consent|gdpr|newsletter|subscribe|signup|social|share|sharing|comment|comments|disqus|promo|advert|advertisement|ad-slot|ads?-|sponsored|related|recommend|trending|popular|paywall|modal|popup|overlay|toolbar|pagination|pager|skip-link|screen-reader|sr-only|visually-hidden)\b/i

/** HTML void elements — they never have a closing tag. */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr'
])

// ---- text helpers ------------------------------------------------------------

/** Decode HTML entities — enough of them for search snippets and page text. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&rdquo;/g, '”')
    .replace(/&ldquo;/g, '“')
}

/** A malformed numeric entity must not throw out of the whole extraction. */
function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return ''
  try {
    return String.fromCodePoint(n)
  } catch {
    return ''
  }
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/** Approximate visible-text length of an HTML fragment. */
function textLength(html: string): number {
  return stripTags(html).length
}

/** Share of a fragment's text that sits inside anchors (0..1). */
export function linkDensity(html: string): number {
  const total = textLength(html)
  if (total === 0) return 0
  let anchorChars = 0
  for (const m of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    anchorChars += stripTags(m[1]).length
  }
  return Math.min(1, anchorChars / total)
}

// ---- element scanning -------------------------------------------------------

export interface ElementSpan {
  tag: string
  /** Index of the `<` opening the element. */
  start: number
  /** Index just past the element's closing `>`. */
  end: number
  /** The element's inner HTML. */
  inner: string
  /** The opening tag's raw attribute text. */
  attrs: string
}

/**
 * Find the element of `tag` beginning at `from`, matching nesting so an outer
 * `<div>` is not closed by an inner one. Returns null when unclosed.
 */
export function readElement(html: string, tag: string, from: number): ElementSpan | null {
  const openRe = new RegExp(`<${tag}\\b([^>]*)>`, 'gi')
  openRe.lastIndex = from
  const open = openRe.exec(html)
  if (!open) return null

  const attrs = open[1] ?? ''
  const innerStart = open.index + open[0].length
  // Self-closing or void: no inner content, no closing tag to find.
  if (attrs.trimEnd().endsWith('/') || VOID_TAGS.has(tag.toLowerCase())) {
    return { tag, start: open.index, end: innerStart, inner: '', attrs }
  }

  const boundaryRe = new RegExp(`<(/?)${tag}\\b([^>]*)>`, 'gi')
  boundaryRe.lastIndex = innerStart
  let depth = 1
  let match: RegExpExecArray | null
  while ((match = boundaryRe.exec(html)) !== null) {
    const isClose = match[1] === '/'
    const selfClosing = !isClose && (match[2] ?? '').trimEnd().endsWith('/')
    if (selfClosing) continue
    depth += isClose ? -1 : 1
    if (depth === 0) {
      return {
        tag,
        start: open.index,
        end: match.index + match[0].length,
        inner: html.slice(innerStart, match.index),
        attrs
      }
    }
  }
  return null
}

/** Every non-nested element of `tag`, outermost first. */
function readAllElements(html: string, tag: string): ElementSpan[] {
  const spans: ElementSpan[] = []
  let cursor = 0
  for (;;) {
    const span = readElement(html, tag, cursor)
    if (!span) break
    spans.push(span)
    // Skip past the whole element so nested same-tag elements aren't re-reported.
    cursor = span.end > cursor ? span.end : cursor + 1
  }
  return spans
}

// ---- chrome removal --------------------------------------------------------

/** Remove elements whose content is never text, by tag. */
function dropUselessTags(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, ' ')
  for (const tag of DROPPED_TAGS) {
    for (const span of readAllElements(out, tag).reverse()) {
      out = out.slice(0, span.start) + ' ' + out.slice(span.end)
    }
  }
  return out
}

/**
 * Remove site chrome: structural chrome tags, plus containers whose class or id
 * marks them as chrome. Guarded by MAX_CHROME_TEXT_SHARE so a badly-named
 * wrapper around the article cannot delete the article.
 */
export function removeChrome(html: string): string {
  let out = html
  const budget = textLength(html) * MAX_CHROME_TEXT_SHARE

  for (const tag of CHROME_TAGS) {
    for (const span of readAllElements(out, tag).reverse()) {
      if (textLength(span.inner) <= budget) {
        out = out.slice(0, span.start) + ' ' + out.slice(span.end)
      }
    }
  }

  for (const tag of ['div', 'section', 'ul', 'ol', 'span']) {
    for (const span of readAllElements(out, tag).reverse()) {
      if (!CHROME_PATTERN.test(span.attrs)) continue
      if (textLength(span.inner) > budget) continue
      out = out.slice(0, span.start) + ' ' + out.slice(span.end)
    }
  }
  return out
}

// ---- main content selection ------------------------------------------------

/**
 * Score a candidate container: text volume, penalized for link density. A
 * navigation rail can be long but is almost entirely anchors, so density is what
 * separates it from prose.
 */
function scoreCandidate(html: string): number {
  const length = textLength(html)
  if (length === 0) return 0
  const density = linkDensity(html)
  if (density >= NAV_LINK_DENSITY) return length * (1 - density)
  return length * (1 - density * 0.5)
}

/** Every div/section at any depth, so a page wrapper and the article both appear. */
function collectCandidates(html: string, depth = 0): string[] {
  if (depth >= MAX_CANDIDATE_DEPTH) return []
  const found: string[] = []
  for (const tag of ['div', 'section']) {
    for (const span of readAllElements(html, tag)) {
      found.push(span.inner)
      found.push(...collectCandidates(span.inner, depth + 1))
    }
  }
  return found
}

/**
 * Pick the container most likely to hold the article. Semantic elements win when
 * present; otherwise the *smallest* `<div>`/`<section>` that still retains most
 * of the document's prose is used.
 *
 * Smallest-that-retains is the whole point: a page's outermost wrapper retains
 * 100% of the prose but narrows nothing, while the article container retains
 * nearly as much and drops the surrounding furniture. Picking the highest score
 * would always return the wrapper. If nothing clears the retention bar — a
 * single continuous document, or an article split across sibling containers —
 * the whole document is used and `found` is false.
 */
export function findMainContent(html: string): { html: string; found: boolean } {
  for (const tag of ['main', 'article']) {
    const spans = readAllElements(html, tag).filter((s) => textLength(s.inner) > 0)
    if (spans.length === 0) continue
    const best = spans.reduce((a, b) => (scoreCandidate(b.inner) > scoreCandidate(a.inner) ? b : a))
    if (scoreCandidate(best.inner) > 0) return { html: best.inner, found: true }
  }

  const roleMain = html.match(/<(\w+)\b[^>]*role=["']main["'][^>]*>/i)
  if (roleMain) {
    const span = readElement(html, roleMain[1], roleMain.index ?? 0)
    if (span && textLength(span.inner) > 0) return { html: span.inner, found: true }
  }

  const baseline = scoreCandidate(html)
  if (baseline <= 0) return { html, found: false }

  let best: { html: string; length: number } | null = null
  for (const candidate of collectCandidates(html)) {
    const length = textLength(candidate)
    if (length < MIN_MAIN_TEXT) continue
    if (scoreCandidate(candidate) < baseline * MAIN_CONTENT_RETENTION) continue
    if (!best || length < best.length) best = { html: candidate, length }
  }

  return best ? { html: best.html, found: true } : { html, found: false }
}

// ---- links ------------------------------------------------------------------

/** Hosts compared ignoring a leading `www.`, so a site's own links group. */
function normalizeHost(host: string): string {
  return host.replace(/^www\./i, '').toLowerCase()
}

/**
 * Outbound links with their anchor text, resolved against `baseUrl`. Anchors
 * with no text, non-HTTP schemes and duplicates are dropped; same-page fragment
 * links are dropped because they lead nowhere new.
 */
export function extractLinks(html: string, baseUrl: string): ExtractedLink[] {
  let base: URL | null = null
  try {
    base = new URL(baseUrl)
  } catch {
    base = null
  }

  const seen = new Set<string>()
  const links: ExtractedLink[] = []

  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (links.length >= MAX_LINKS) break
    const href = m[1].match(/href=["']([^"']*)["']/i)?.[1]
    if (!href) continue

    const raw = decodeEntities(href).trim()
    if (!raw || raw.startsWith('#')) continue
    if (/^(?:javascript|mailto|tel|data|blob|file):/i.test(raw)) continue

    let resolved: URL
    try {
      resolved = base ? new URL(raw, base) : new URL(raw)
    } catch {
      continue
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue

    resolved.hash = ''
    const url = resolved.toString()
    if (seen.has(url)) continue
    // A link back to the page we are already reading is not a lead.
    if (base && url === (() => { const b = new URL(base.toString()); b.hash = ''; return b.toString() })()) {
      continue
    }
    seen.add(url)

    const text = stripTags(m[2]).slice(0, 120)
    if (!text) continue

    links.push({
      url,
      text,
      sameSite: base ? normalizeHost(resolved.host) === normalizeHost(base.host) : false
    })
  }
  return links
}

// ---- public entry point -----------------------------------------------------

/**
 * Convert a cleaned HTML fragment to text, preserving block structure.
 *
 * Note the deliberate avoidance of `stripTags` here: it collapses all
 * whitespace, newlines included, which silently undid the block-level newlines
 * inserted just above (a flaw inherited from the v0.6 `htmlToText`). Only
 * horizontal whitespace is collapsed, so paragraph boundaries survive — which
 * matters because chunking splits on them.
 */
export function htmlFragmentToText(html: string): string {
  const withBreaks = html.replace(
    /<\/?(p|div|br|hr|li|ul|ol|h[1-6]|tr|table|section|article|blockquote|pre|dd|dt|dl|figcaption)\b[^>]*>/gi,
    '\n'
  )
  return decodeEntities(withBreaks.replace(/<[^>]+>/g, ' '))
    .replace(/[^\S\n]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
}

/**
 * Full extraction: title, main-content text, and outbound links.
 *
 * Links come from the chrome-stripped document rather than the main-content
 * region, because a page's useful references (citations, "see also", docs
 * navigation) often sit just outside the article body.
 */
export function extractFromHtml(html: string, baseUrl: string): ExtractedPage {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? stripTags(titleMatch[1]) : ''

  const cleaned = dropUselessTags(html)
  const dechromed = removeChrome(cleaned)
  const { html: mainHtml, found } = findMainContent(dechromed)

  return {
    title,
    text: htmlFragmentToText(mainHtml),
    links: extractLinks(dechromed, baseUrl),
    mainContentFound: found
  }
}

/**
 * Back-compatible shape for callers that only want title + text.
 * (The v0.6 signature; retained so nothing has to change to keep working.)
 */
export function htmlToText(html: string): { title: string; text: string } {
  const { title, text } = extractFromHtml(html, '')
  return { title, text }
}
