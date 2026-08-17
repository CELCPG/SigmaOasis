/**
 * Build the curated reference packs from packs/sources/*.json.
 *
 * Runs under Electron proper (scripts/build-packs.sh), not Node: each source
 * page is loaded in a real offscreen Chromium window and converted to Markdown
 * from the live DOM, so headings survive (they become the citation's section),
 * JavaScript-built pages render, and the federal sites that refuse a bare HTTP
 * client answer a browser. This is a *build-time* fetch by the maintainer;
 * the app itself never fetches packs — a user installs the built folder.
 *
 * Output: packs/<id>/manifest.json + docs/<docId>.md, in the format
 * docs/library-pack-format.md describes. A document that fails (HTTP error,
 * too little text, conversion error) is logged and left out of the manifest;
 * the pack still builds with the rest, and the exit code says whether every
 * document made it.
 *
 * Usage: bash scripts/build-packs.sh [packId ...]   (no ids = all)
 */
import { app, BrowserWindow, session } from 'electron'
import { promises as fs } from 'fs'
import { join, resolve } from 'path'

interface SourceDoc {
  id: string
  title: string
  url: string
  license?: string
  date?: string
}
interface SourceSpec {
  id: string
  name: string
  description: string
  version: string
  license: string
  sourceNote?: string
  docLicense?: string
  /** CSS selector for the article on this site, tried before the generic candidates. */
  contentSelector?: string
  docs: SourceDoc[]
}

const ROOT = resolve(__dirname, '..', '..')
const SOURCES_DIR = join(ROOT, 'packs', 'sources')
const OUT_DIR = join(ROOT, 'packs')
/** Below this many characters a page almost certainly rendered a consent wall or an error, not the article. */
const MIN_DOC_CHARS = 500
const LOAD_TIMEOUT_MS = 45_000
/** Settle time after load for late-rendering content. */
const SETTLE_MS = 1500
/**
 * Sequential on purpose. With two offscreen windows in flight the converter
 * was measurably handed the *other* window's DOM (titles off by one document
 * in the log), which would have silently mis-filed content under the wrong
 * provenance — the one failure a reference library must never have.
 */
const CONCURRENCY = 1
const PAUSE_BETWEEN_DOCS_MS = 2500

/**
 * DOM → Markdown, run inside the page (isolated world). Picks the main content
 * container, strips chrome, and walks block elements. Links keep their text
 * only; the document's own URL is the provenance, and inline URLs are noise
 * for retrieval. Returns { markdown, reviewed } where `reviewed` is a date the
 * page states about itself, if any.
 */
const CONVERT_SCRIPT = String.raw`
((preferredSelector) => {
  const STRIP = 'script,style,noscript,template,iframe,svg,canvas,form,button,input,select,textarea,nav,header,footer,aside,[role=navigation],[role=banner],[role=contentinfo],[role=complementary],[aria-hidden=true],[hidden],.usa-banner,.usa-skipnav,.nhsuk-header,.nhsuk-footer,.nhsuk-breadcrumb,.nhsuk-back-link,.nhsuk-skip-link,.breadcrumb,.breadcrumbs,[id*=cookie],[class*=cookie],[id*=consent],[class*=consent],.usa-alert--emergency,.share,.social,.related-links,.pagination,.sidebar,.subnav,.toc-nav,.nhsuk-u-visually-hidden,.visually-hidden,.sr-only,#table-of-contents,#toc-section,#breadcrumbs,#related,#related-topics,#encyclopedia-box,#magazine-box,#mplus-orgs,#citation-how-to,#lastupdate,#mplus-lang-toggle,.page-info,.toc'
  const CANDIDATES = ['main article', 'main [role=main]', 'main', 'article', '[role=main]', '#main-content', '#main', '#content', '.nhsuk-main-wrapper', 'body']
  // The candidate with the most text wins: sites nest a teaser <article>
  // inside <main>, and the first selector that has "some" text is not the
  // article. Body is the floor.
  let root = null, best = 0
  if (preferredSelector) { const el = document.querySelector(preferredSelector); if (el && el.innerText && el.innerText.trim().length > 200) root = el }
  if (!root) for (const sel of CANDIDATES) { const el = document.querySelector(sel); const n = el && el.innerText ? el.innerText.trim().length : 0; if (n > best) { best = n; root = el } }
  if (!root) root = document.body
  root = root.cloneNode(true)
  root.querySelectorAll(STRIP).forEach((el) => el.remove())

  const clean = (s) => s.replace(/\s+/g, ' ').trim()
  const lines = []
  const push = (s) => { if (s && s.trim()) lines.push(s) }
  const blank = () => { if (lines.length && lines[lines.length - 1] !== '') lines.push('') }

  const inlineText = (el) => clean(el.innerText || el.textContent || '')

  const walk = (node, listPrefix) => {
    if (node.nodeType === Node.TEXT_NODE) { const t = clean(node.textContent); if (t) push(t); return }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const tag = node.tagName.toLowerCase()
    if (/^h[1-6]$/.test(tag)) { const t = inlineText(node); if (t) { blank(); push('#'.repeat(Number(tag[1])) + ' ' + t); blank() } return }
    if (tag === 'p') { const t = inlineText(node); if (t) { blank(); push(t); blank() } return }
    // The li's own text is its textContent minus any nested lists — taken from
    // a pruned clone, NOT childNodes joined with spaces: that join split words
    // whose first letter is a styled element ("<b>F</b>ace" became "F ace" in
    // the stroke FAST mnemonic, v1.7). textContent concatenates exactly as the
    // source does; whitespace between runs is the document's own.
    if (tag === 'li') { const own = node.cloneNode(true); own.querySelectorAll('ul, ol').forEach((el) => el.remove()); const t = clean(own.textContent || ''); if (t) push((listPrefix || '- ') + t); [...node.children].filter((c) => /^(ul|ol)$/.test(c.tagName.toLowerCase())).forEach((c) => walk(c, '  - ')); return }
    if (tag === 'ul' || tag === 'ol') { blank(); let i = 0; [...node.children].forEach((c) => { i += 1; walk(c, tag === 'ol' ? (listPrefix ? listPrefix : '') + i + '. ' : (listPrefix || '- ')) }); blank(); return }
    if (tag === 'table') {
      blank()
      const rows = [...node.querySelectorAll('tr')]
      rows.forEach((tr, i) => {
        const cells = [...tr.children].map((c) => inlineText(c).replace(/\|/g, '/'))
        if (cells.length === 0) return
        push('| ' + cells.join(' | ') + ' |')
        if (i === 0) push('|' + cells.map(() => ' --- ').join('|') + '|')
      })
      blank(); return
    }
    if (tag === 'pre') { const FENCE = String.fromCharCode(96, 96, 96); blank(); push(FENCE); push(node.innerText); push(FENCE); blank(); return }
    if (tag === 'br') { push(''); return }
    if (tag === 'dt') { const t = inlineText(node); if (t) { blank(); push('**' + t + '**') } return }
    if (tag === 'dd') { const t = inlineText(node); if (t) push(t); return }
    if (tag === 'blockquote') { const t = inlineText(node); if (t) { blank(); push('> ' + t); blank() } return }
    if (['div','section','main','article','span','a','strong','em','b','i','u','small','td','th','tr','tbody','thead','figure','figcaption','details','summary','dl','body','label','time','abbr','sup','sub','cite','q','mark'].includes(tag)) {
      // Inline containers with only text: emit as one line. Block containers: recurse.
      const hasBlock = [...node.children].some((c) => /^(p|h[1-6]|ul|ol|li|table|thead|tbody|tr|div|section|article|main|nav|aside|header|footer|form|fieldset|pre|blockquote|dl|dt|dd|figure|details|hr)$/.test(c.tagName.toLowerCase()))
      if (!hasBlock) { const t = inlineText(node); if (t) push(t); return }
      [...node.childNodes].forEach((c) => walk(c, listPrefix)); return
    }
    [...node.childNodes].forEach((c) => walk(c, listPrefix))
  }
  walk(root, '')

  // Collapse runs of blank lines and drop chrome-y one-liners.
  const out = []
  for (const l of lines) {
    if (l === '' && out.length && out[out.length - 1] === '') continue
    if (/^(Skip to main content|Print|Share|Email|Back to top|Cookies on|Menu|Search)$/i.test(l)) continue
    out.push(l)
  }
  const markdown = out.join('\n').trim()
  const bodyText = document.body.innerText || ''
  const m = bodyText.match(/(?:Page last reviewed|Last (?:reviewed|updated|Reviewed|Updated)|Content last reviewed|Last Modified|Reviewed):?\s*([0-9]{1,2} \w+ [0-9]{4}|\w+ [0-9]{1,2}, [0-9]{4}|[0-9]{4}-[0-9]{2}-[0-9]{2}|\w+ [0-9]{4})/)
  return { markdown, reviewed: m ? m[1] : null, title: document.title }
})
`

async function fetchDoc(doc: SourceDoc, contentSelector?: string): Promise<{ markdown: string; reviewed: string | null }> {
  const part = `pack-build-${Math.random().toString(36).slice(2)}`
  const ses = session.fromPartition(part)
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 2000,
    webPreferences: { offscreen: true, sandbox: true, nodeIntegration: false, contextIsolation: true, session: ses, images: false }
  })
  try {
    // Block heavy/irrelevant resources; keep documents, scripts and styles.
    ses.webRequest.onBeforeRequest((details, cb) => {
      const t = details.resourceType
      cb({ cancel: t === 'image' || t === 'media' || t === 'font' })
    })
    // Load, then wait until the *requested* document has rendered real
    // content: the main-frame URL is on the right host and the page carries
    // more than a shell. did-stop-loading alone fires for intermediate
    // navigations (redirect hops, SPA shells) — measured: it handed the
    // previous document's DOM to the converter on investor.gov.
    const failed = new Promise<never>((_r, rej) =>
      win.webContents.once('did-fail-load', (_e, code, desc, url, isMain) => {
        if (isMain && code !== -3 /* ERR_ABORTED: redirects */) rej(new Error(`load failed: ${desc} (${code}) ${url}`))
      })
    )
    const wantHost = new URL(doc.url).hostname.replace(/^www\./, '')
    const rendered = (async (): Promise<void> => {
      const deadline = Date.now() + LOAD_TIMEOUT_MS
      let lastChars = -1
      // Fire and forget: the promise itself is not the signal.
      win.loadURL(doc.url, { userAgent: win.webContents.getUserAgent().replace(/Electron\/\S+\s?/, '') }).catch(() => undefined)
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 400))
        if (win.isDestroyed()) throw new Error('window destroyed')
        const here = win.webContents.getURL()
        let host = ''
        try {
          host = new URL(here).hostname.replace(/^www\./, '')
        } catch {
          continue
        }
        if (host !== wantHost) continue
        // Body, not a container: on JS-built pages the container exists empty
        // long before the content arrives, and its name varies per site. Not
        // isLoading(): a hung analytics beacon keeps that true forever
        // (measured on nhs.uk and medlineplus.gov). "Enough text, and the same
        // amount as last poll" is the signal that the article is there.
        const chars = (await win.webContents
          .executeJavaScript('document.body ? document.body.innerText.length : 0')
          .catch(() => 0)) as number
        if (chars > 1200 && chars === lastChars) return
        lastChars = chars
      }
      throw new Error('load timeout (page never rendered enough content)')
    })()
    await Promise.race([rendered, failed])
    await new Promise((r) => setTimeout(r, SETTLE_MS))
    const result = (await win.webContents.executeJavaScriptInIsolatedWorld(1, [
      { code: `(${CONVERT_SCRIPT})(${JSON.stringify(contentSelector ?? null)})` }
    ])) as {
      markdown: string
      reviewed: string | null
      title: string
    }
    if (!result || typeof result.markdown !== 'string') throw new Error('conversion returned nothing')
    if (result.markdown.length < MIN_DOC_CHARS) {
      throw new Error(`only ${result.markdown.length} chars extracted (title: ${JSON.stringify(result.title)})`)
    }
    return { markdown: result.markdown, reviewed: result.reviewed }
  } finally {
    win.destroy()
    await ses.clearStorageData().catch(() => undefined)
  }
}

/** Ensure the document starts with an H1 carrying the manifest title, for citations. */
function withTitle(markdown: string, title: string): string {
  const firstLine = markdown.split('\n')[0] ?? ''
  if (/^#\s/.test(firstLine)) return markdown
  return `# ${title}\n\n${markdown}`
}

async function buildPack(spec: SourceSpec, today: string): Promise<{ ok: number; failed: string[] }> {
  const outDir = join(OUT_DIR, spec.id)
  await fs.rm(outDir, { recursive: true, force: true })
  await fs.mkdir(join(outDir, 'docs'), { recursive: true })
  const failed: string[] = []
  const built: { id: string; title: string; source: string; license?: string; date?: string; file: string; chars: number }[] = []

  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const doc = spec.docs[cursor++]
      if (!doc) return
      // Courtesy pause: a burst of page loads from one address is what trips
      // the throttling that shows up as intermittent 404s and stalls.
      if (cursor > 1) await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_DOCS_MS))
      process.stdout.write(`  ${spec.id}/${doc.id} … `)
      try {
        // Federal sites answer a burst of requests with intermittent 404 pages
        // and stalls (measured on usa.gov and medlineplus.gov: the same URL
        // succeeded a minute earlier). Retry with a growing pause.
        let attempt = 0
        let last: unknown
        let got: { markdown: string; reviewed: string | null } | null = null
        while (attempt < 3 && !got) {
          try {
            got = await fetchDoc(doc, spec.contentSelector)
          } catch (err) {
            last = err
            attempt += 1
            if (attempt < 3) {
              process.stdout.write(`retry ${attempt} … `)
              await new Promise((r) => setTimeout(r, 4000 * attempt))
            }
          }
        }
        if (!got) throw last
        const { markdown, reviewed } = got
        const text = withTitle(markdown, doc.title)
        const file = `${doc.id}.md`
        await fs.writeFile(join(outDir, 'docs', file), text + '\n', 'utf-8')
        built.push({
          id: doc.id,
          title: doc.title,
          source: doc.url,
          license: doc.license ?? spec.docLicense,
          date: doc.date ?? (reviewed ? `page reviewed ${reviewed}; retrieved ${today}` : `retrieved ${today}`),
          file,
          chars: text.length
        })
        console.log(`ok (${text.length} chars${reviewed ? `, reviewed ${reviewed}` : ''})`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        failed.push(`${doc.id}: ${msg}`)
        console.log(`FAILED — ${msg}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, spec.docs.length) }, worker))

  // Manifest order follows the spec, not completion order.
  const order = new Map(spec.docs.map((d, i) => [d.id, i]))
  built.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  const manifest = {
    formatVersion: 1,
    id: spec.id,
    name: spec.name,
    description: spec.description,
    version: spec.version,
    license: spec.license,
    kind: 'curated',
    sourceNote: `${spec.sourceNote ?? ''} Built ${today} by scripts/build-packs.ts from packs/sources/${spec.id}.json.`.trim(),
    docs: built
  }
  await fs.writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
  return { ok: built.length, failed }
}

async function main(): Promise<void> {
  const files = (await fs.readdir(SOURCES_DIR)).filter((f) => f.endsWith('.json')).sort()
  const known = new Set(files.map((f) => f.replace(/\.json$/, '')))
  // Electron's own switches and the script path share argv; only known pack
  // ids count as a filter, and an unknown word is a typo worth failing on.
  const words = process.argv.slice(1).filter((a) => !a.startsWith('-') && !/\.js$/.test(a) && a !== 'all')
  const unknown = words.filter((w) => !known.has(w))
  if (unknown.length) {
    console.error(`unknown pack id(s): ${unknown.join(', ')} — known: ${[...known].join(', ')}`)
    return exitAfterFlush(2)
  }
  const only = words
  const today = new Date().toISOString().slice(0, 10)
  console.log(`building: ${only.length ? only.join(', ') : 'all'}`)
  let exit = 0
  for (const f of files) {
    const spec = JSON.parse(await fs.readFile(join(SOURCES_DIR, f), 'utf-8')) as SourceSpec
    if (only.length > 0 && !only.includes(spec.id)) continue
    console.log(`\n== ${spec.id} (${spec.docs.length} documents)`)
    const { ok, failed } = await buildPack(spec, today)
    console.log(`   ${ok}/${spec.docs.length} built${failed.length ? `; failed: ${failed.length}` : ''}`)
    if (failed.length) exit = 1
  }
  exitAfterFlush(exit)
}

// Windows are created and destroyed per document; the default quit-on-last-
// window-closed would end the build between two documents.
app.on('window-all-closed', () => undefined)

/** app.exit right after console.log drops buffered stdout on a pipe; give it a beat. */
function exitAfterFlush(code: number): void {
  setTimeout(() => app.exit(code), 250)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('BUILD ERROR:', err)
    exitAfterFlush(1)
  })
)
