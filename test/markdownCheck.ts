/**
 * Pins the markdown → HTML sanitization boundary in a real Chromium window.
 *
 * `renderMarkdown` is the one place model output becomes DOM (MessageBubble
 * sets innerHTML from it), which makes it the app's XSS surface. DOMPurify
 * needs a DOM to do anything at all — under Node it returns its input
 * untouched, so a node:test of this function would pass while sanitizing
 * nothing. Hence an offscreen BrowserWindow, like renderCheck.ts.
 *
 * The bundle is built with Vite (a dev dependency already) from
 * test/markdownEntry.ts so the code under test is byte-for-byte what ships:
 * marked with the app's renderer, highlight.js with the app's language set,
 * DOMPurify with the app's config (SANITIZE_OPTIONS in markdown.ts).
 *
 * Run through scripts/test-render.sh (Electron proper, not ELECTRON_RUN_AS_NODE).
 */
import { app, BrowserWindow } from 'electron'
import { createServer } from 'http'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { AddressInfo } from 'net'

/** The shipped stylesheet: this file's markup has to pair with a rule over there. */
const indexCss = readFileSync(
  join(__dirname, '..', '..', 'src', 'renderer', 'src', 'assets', 'index.css'),
  'utf-8'
)

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

async function buildBundle(outDir: string): Promise<string> {
  // Vite 5 still ships a CJS entry; the deprecation notice is noise here.
  process.env.VITE_CJS_IGNORE_DEPRECATION = 'true'
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { build } = require('vite') as typeof import('vite')
  const root = join(__dirname, '..', '..')
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      lib: {
        entry: join(root, 'test', 'markdownEntry.ts'),
        formats: ['iife'],
        name: 'MarkdownUnderTest',
        fileName: () => 'markdown-under-test.js'
      }
    }
  })
  return readFileSync(join(outDir, 'markdown-under-test.js'), 'utf-8')
}

async function main(): Promise<void> {
  const bundle = await buildBundle(join(__dirname, '..', 'markdown-bundle'))

  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${bundle}</script></body></html>`
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, sandbox: true, nodeIntegration: false }
  })
  await win.loadURL(`http://127.0.0.1:${port}/`)

  const render = async (markdown: string, citations: unknown[] = []): Promise<string> =>
    (await win.webContents.executeJavaScript(
      `MarkdownUnderTest.renderMarkdown(${JSON.stringify(markdown)}, ${JSON.stringify(citations)})`
    )) as string

  console.log('\nsanitization: what a model must not be able to inject')

  let html = await render('Hello <script>window.__pwned = 1</script> world')
  check('inline <script> is removed', !/<script/i.test(html), html)
  check('the surrounding text survives', html.includes('Hello') && html.includes('world'))

  html = await render('<img src="x" onerror="window.__pwned=1">')
  check('event-handler attributes are removed', !/onerror/i.test(html), html)

  html = await render('<svg onload="window.__pwned=1"><circle r="1"/></svg>')
  check('svg onload is removed', !/onload/i.test(html), html)

  html = await render('[click me](javascript:window.__pwned=1)')
  check('javascript: hrefs are removed from markdown links', !/javascript:/i.test(html), html)

  html = await render('<a href="javascript:window.__pwned=1">raw</a>')
  check('javascript: hrefs are removed from raw HTML links', !/javascript:/i.test(html), html)

  html = await render('<a href="  JaVaScRiPt:window.__pwned=1">obfuscated</a>')
  check('obfuscated javascript: scheme is removed', !/javascript/i.test(html), html)

  html = await render('<iframe src="https://example.com"></iframe>')
  check('iframes are removed', !/<iframe/i.test(html), html)

  html = await render('<object data="x"></object><embed src="x">')
  check('object/embed are removed', !/<object|<embed/i.test(html), html)

  html = await render('<form action="https://example.com"><input name="q"><textarea></textarea><select><option>x</option></select></form>')
  check('forms and form controls are removed (phishing surface)', !/<form|<input|<textarea|<select/i.test(html), html)

  html = await render('<a href="https://example.com" target="_blank">x</a>')
  check('target attribute is stripped (window.opener surface)', !/target=/i.test(html), html)

  html = await render('<div style="position:fixed;top:0;left:0;width:100vw;height:100vh">overlay</div>')
  check('inline style attributes are removed (overlay surface)', !/style=/i.test(html) && html.includes('overlay'), html)

  html = await render('<style>body{display:none}</style>text')
  check('<style> elements are removed', !/<style/i.test(html) && html.includes('text'), html)

  html = await render('```html\n<script>alert(1)</script>\n```')
  check('code inside a fence is escaped, not executed', !/<script/.test(html) && /&lt;/.test(html), html)

  html = await render('`<img src=x onerror=alert(1)>`')
  check('inline code is escaped', !/onerror=/.test(html) || /&lt;img/.test(html), html)

  const pwned = (await win.webContents.executeJavaScript('window.__pwned === undefined')) as boolean
  check('nothing above executed in the page', pwned)

  console.log('\nrendering: what must survive sanitization')

  html = await render('**bold** and _italic_ and `code`')
  check('emphasis renders', /<strong>bold<\/strong>/.test(html) && /<em>italic<\/em>/.test(html), html)
  check('inline code renders', /<code>code<\/code>/.test(html), html)

  html = await render('```python\ndef f():\n    return 1\n```')
  check('code block keeps its header + copy button', /class="code-header"/.test(html) && /code-copy-btn/.test(html), html)
  check('code block is highlighted', /class="hljs language-python"/.test(html) && /hljs-/.test(html), html)
  // Code scrolls by default (a wrapped line misrepresents the source), so the
  // header has to offer the reader a way to unfold one — and the control has to
  // survive the sanitizer, which is the only reason it can be asserted here.
  check(
    'code block offers a wrap control, and it survives sanitization',
    /class="code-wrap-btn"/.test(html) && /aria-pressed="false"/.test(html),
    html
  )
  check(
    'a block of ordinary code still scrolls by default',
    !/code-wrapped/.test(html) && /aria-pressed="false"/.test(html),
    html
  )

  // v1.17.2: "a wrapped line is a lie about the source" is an argument about
  // lines that HAVE a shape — indentation, two things on one line, a chosen
  // line end. A line that is one unbroken token has none of that, and scrolling
  // it shows 26 of its 220 characters at a time in split view. So that one
  // shape of line, and only it, arrives wrapped. The class and the control's
  // state have to agree, because MessageBubble's toggle derives one from the
  // other.
  const TOKEN = 'c2lnbWEtb2FzaXMtaGVhZC10by1oZWFkLWxheW91dC1wcm9iZS1hLXNpbmdsZS11bmJyb2tlbi10b2tlbi10aGF0LW11c3Qtbm90LWJsb3ctb3V0LXRoZS1jaGF0LWNvbHVtbg'
  html = await render('```\n' + TOKEN + '\n```')
  check(
    'a fenced line that is one 220-character token arrives already wrapped',
    /class="code-block code-wrapped"/.test(html) && /aria-pressed="true"/.test(html),
    html
  )
  check('and the token itself is untouched in the DOM', html.includes(TOKEN), html)

  // The true negatives: a long line of real code has a shape to misrepresent,
  // and a short token would not have wrapped anyway — both still scroll.
  html = await render('```js\nconst x = [' + Array(30).fill('"aaaaaa"').join(', ') + ']\n```')
  check(
    'a 260-character line of real code is left scrolling',
    !/code-wrapped/.test(html) && /aria-pressed="false"/.test(html),
    html
  )
  html = await render('```\nabcdefghij\n```')
  check(
    'a short unbroken token does not flip the control for nothing',
    !/code-wrapped/.test(html) && /aria-pressed="false"/.test(html),
    html
  )

  html = await render('```nosuchlang\nx\n```')
  check('unknown language falls back to plaintext', /language-plaintext/.test(html), html)

  html = await render('| a | b |\n|---|---|\n| 1 | 2 |')
  check('tables render', /<table>/.test(html) && /<td>1<\/td>/.test(html), html)
  // A table is the only block whose width its own cells decide, so it is the
  // only one that can either push the chat column sideways or be squeezed until
  // words break. Its own scroll container is what lets it do neither — and the
  // wrapper has to survive the sanitizer, or the layout silently reverts.
  check(
    'a table is wrapped in a scroll container that survives sanitization',
    /<div class="md-table-scroll" tabindex="0"><table>/.test(html),
    html
  )
  // A scroll region has to be reachable from the keyboard, and a new tab stop
  // that shows no ring is a VC2 regression — so the stylesheet is read here for
  // the rule that gives this one its ring. The two live in different files;
  // nothing else pairs them.
  check(
    'the tab stop it adds has a visible focus ring in the shipped stylesheet',
    /\[tabindex\]:focus-visible/.test(indexCss),
    'no [tabindex]:focus-visible rule in assets/index.css'
  )
  check('header and body rows both survive the wrapper', /<thead>[\s\S]*<th>a<\/th>/.test(html) && /<tbody>[\s\S]*<td>1<\/td>/.test(html), html)

  html = await render('| a |\n|---|\n| 1 |\n\ntext\n\n| b |\n|---|\n| 2 |')
  check(
    'two tables get two independent containers, so one cannot drag the other',
    (html.match(/md-table-scroll/g) ?? []).length === 2,
    html
  )

  // v1.17.1: `~` means "about" in technical prose, and models write it
  // constantly. GFM lets a SINGLE tilde open a strikethrough and marked
  // implements that, so two approximations in one paragraph pair up: the run
  // between them renders struck through and both tildes are consumed. A blind
  // critic caught `~51 GPH (~0.9 GPM)` reaching the reader as `51 GPH (0.9
  // GPM)` — an estimate turned into an exact figure, in the line a reader is
  // most likely to quote. Strikethrough is `~~text~~` only; the true negative
  // below is that real strikethrough still works.
  html = await render('Flow is ~51 GPH (~0.9 GPM) at the tap.')
  check(
    'two approximations in a line stay approximations',
    html.includes('~51 GPH (~0.9 GPM)') && !/<del>/.test(html),
    html
  )

  html = await render('| a |\n|---|\n| **~51 GPH (~0.9 GPM)** |')
  check('an approximation inside a table cell keeps its tildes', html.includes('~51 GPH (~0.9 GPM)'), html)

  html = await render('Target: ~84,000 calories total (~2,100 cal/person/day)')
  check('an approximate quantity is not struck through', !/<del>/.test(html) && html.includes('~84,000'), html)

  html = await render('This is ~~definitely struck~~ text.')
  check('real strikethrough still renders', /<del>definitely struck<\/del>/.test(html), html)

  html = await render('[site](https://example.com/path?q=1)')
  check('https links keep their href', /href="https:\/\/example\.com\/path\?q=1"/.test(html), html)

  html = await render('![pic](data:image/png;base64,iVBORw0KGgo=)')
  check('data: images are allowed (image galleries rely on it)', /<img[^>]+src="data:image\/png;base64,iVBORw0KGgo="/.test(html), html)

  html = await render('line one\nline two')
  check('single newlines break (breaks: true)', /<br>/.test(html), html)

  html = await render('Water boils at $100^\\circ\\text{C}$.')
  check('inline TeX is rewritten to plain text', !html.includes('$') && html.includes('100'), html)

  console.log('\ncitations: a retrieved passage the reader can actually open')

  // The locators the app itself retrieved, in the shape citations.ts parses
  // out of a reference_lookup result.
  const IRS = 'https://www.irs.gov/newsroom/irs-releases-tax-inflation-adjustments-for-tax-year-2025'
  const cited = [
    { index: 1, label: 'Personal finance & tax basics › Tax inflation adjustments · 10% in', source: IRS, href: IRS },
    { index: 2, label: 'Personal finance & tax basics › Tax Topic 501 · 0% in', source: '/Users/me/docs/tc501.md' }
  ]

  html = await render('The deduction is $30,000 [1].', cited)
  check(
    'an inline [1] becomes a link to the passage the app retrieved',
    new RegExp(`<a[^>]+class="citation-ref"[^>]+href="${IRS.replace(/[.?*+]/g, '\\$&')}"`).test(html) ||
      new RegExp(`<a[^>]+href="${IRS.replace(/[.?*+]/g, '\\$&')}"[^>]+class="citation-ref"`).test(html),
    html
  )
  check('the marker text survives as [1]', />\[1\]<\/a>/.test(html), html)
  check('the passage citation is on the marker as a title', /title="Personal finance &amp; tax basics/.test(html), html)

  html = await render('Itemizing may beat it [2].', cited)
  check(
    'a passage whose source is a local path is marked, not linked',
    /<span[^>]+class="citation-ref"[^>]*>\[2\]<\/span>/.test(html) && !html.includes('/Users/me/docs'),
    html
  )

  html = await render('See Publication 17 [4].', cited)
  check('a marker naming no retrieved passage is left inert', !/citation-ref/.test(html) && html.includes('[4]'), html)

  html = await render('```python\nvalues[1] = 2\n```\n\nand `rows[1]` inline', cited)
  check('array indexing in code is never linked', !/citation-ref/.test(html), html)

  html = await render('bad [1]', [{ index: 1, label: 'Pack › Doc', href: 'javascript:window.__pwned=1' }])
  check('a javascript: source cannot become a citation link', !/javascript:/i.test(html), html)

  server.close()
  win.destroy()

  console.log(`\n${'='.repeat(58)}`)
  if (failures.length === 0) {
    console.log(`ALL ${passed} MARKDOWN CHECKS PASSED`)
    app.exit(0)
  } else {
    console.log(`${passed} passed, ${failures.length} FAILED:`)
    for (const f of failures) console.log(`  - ${f}`)
    app.exit(1)
  }
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('MARKDOWN CHECK ERROR:', err)
    app.exit(1)
  })
)
