// Smoke test for the new search/security layer (src/main/ipc/search.ts).
// Bundles the real module with esbuild, aliasing 'electron' to a stub so the
// pure logic (providers, SSRF guard, HTML extraction, query hygiene) runs in
// plain Node against live endpoints where possible.
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const root = new URL('..', import.meta.url).pathname
const tmp = mkdtempSync(join(tmpdir(), 'sigma-smoke-'))

// Minimal electron stub — enough for store.ts / net.ts / search.ts imports.
const stub = join(tmp, 'electron-stub.mjs')
writeFileSync(
  stub,
  `import { join } from 'node:path'
   const base = process.env.SMOKE_USERDATA
   export const app = {
     getPath: (name) => join(base, name),
     getVersion: () => '0.5.0-smoke',
     isPackaged: false,
     whenReady: () => Promise.resolve(),
     on: () => {}
   }
   export const ipcMain = { handle: () => {}, on: () => {} }
   export const BrowserWindow = { getAllWindows: () => [], fromWebContents: () => null }
   export const dialog = {}
   export const safeStorage = {
     isEncryptionAvailable: () => false,
     encryptString: (s) => Buffer.from(s),
     decryptString: (b) => b.toString()
   }
   export const contextBridge = {}
   export const shell = {}`
)

process.env.SMOKE_USERDATA = join(tmp, 'userdata')

const outfile = join(tmp, 'search.bundle.mjs')
await build({
  entryPoints: [join(root, 'src/main/ipc/search.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  alias: { electron: stub },
  // CJS deps (electron-store/conf) use dynamic require; shim it for ESM output.
  banner: {
    js: "import { createRequire as __smokeCreateRequire } from 'node:module'; const require = __smokeCreateRequire(import.meta.url);"
  },
  logLevel: 'silent'
})

const search = await import(pathToFileURL(outfile).href)

let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
  if (!cond) failures++
}

// 1. htmlToText strips scripts and keeps text.
const { title, text } = search.htmlToText(
  '<html><head><title>Test Page</title><style>body{color:red}</style></head>' +
    '<body><h1>Hello</h1><script>alert("xss")</script><p>World &amp; friends</p></body></html>'
)
check('htmlToText extracts title', title === 'Test Page', JSON.stringify(title))
check('htmlToText keeps body text', text.includes('Hello') && text.includes('World & friends'))
check('htmlToText strips scripts', !text.includes('alert'))

// 2. fetch_webpage refuses loopback (SSRF guard).
const loopback = await search.fetchWebpage('https://127.0.0.1:1234/v1/models')
check('fetch_webpage refuses loopback', !loopback.ok, loopback.error)

const nonHttps = await search.fetchWebpage('http://example.com/')
check('fetch_webpage refuses plain HTTP', !nonHttps.ok, nonHttps.error)

// 3. Query hygiene: secrets are redacted before anything is sent.
//    (DuckDuckGo is the default provider; this also exercises live search
//    when the network allows it.)
const outcome = await search.runWebSearch(
  'best pasta recipe sk-ABCDEFGHIJKLMNOP1234 colin@example.com'
)
check('query hygiene redacts email', outcome.redactions.includes('email address'), outcome.redactions.join(','))
check(
  'query hygiene redacts API-key-like token',
  outcome.redactions.includes('API-key-like token'),
  outcome.redactions.join(',')
)
check(
  'sanitized query sent contains no secret',
  !outcome.sentQuery.includes('colin@example.com') && !outcome.sentQuery.includes('sk-ABCDEF'),
  JSON.stringify(outcome.sentQuery)
)
if (outcome.ok) {
  check('live DuckDuckGo search returns results', outcome.results.length > 0, `${outcome.results.length} results`)
  if (outcome.results[0]) {
    console.log(`   first result: ${outcome.results[0].title} — ${outcome.results[0].url}`)
  }
} else {
  console.log(`   (live search skipped/failed — offline or rate-limited: ${outcome.error})`)
}

// 4. fetch_webpage against a real public page (network permitting).
const page = await search.fetchWebpage('https://example.com/')
if (page.ok) {
  check('fetch_webpage fetches example.com', page.text.includes('Example Domain'))
} else {
  console.log(`   (live fetch skipped/failed — offline: ${page.error})`)
}

console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
