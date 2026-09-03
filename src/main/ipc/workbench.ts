import { app, BrowserWindow, ipcMain, protocol, session } from 'electron'
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import { extname, join, normalize } from 'path'

/**
 * The Workbench (STRATEGY-depth-and-reasoning.md, Feature B): a Python
 * runtime the model can use as a calculator, a spreadsheet and a verifier —
 * program-of-thought for a small model that is bad at arithmetic and exact at
 * writing the program.
 *
 * Sandboxed by construction, not by policy. Python runs as Pyodide (CPython
 * compiled to WebAssembly) inside a hidden, sandboxed Electron window:
 *   - `sandbox: true`, context isolation, no Node — the page has a DOM and
 *     nothing else; Python's `js` bridge reaches only that page.
 *   - its own session, whose network access is refused for every request that
 *     is not the app's own `sigma-workbench://` scheme (the runtime files),
 *     with a CSP that says the same (`connect-src 'self'`) and no permissions.
 *   - a virtual filesystem the app populates per job under /work and reads
 *     back after; the real disk is never mounted.
 *   - one job at a time; a job that overruns its budget has its window
 *     destroyed — the sandbox is disposable, and a fresh one costs a few
 *     seconds, not a leaked process.
 * The runtime files come from resources/pyodide (scripts/fetch-pyodide.sh; an
 * extra resource in packaged builds). No download ever happens at run time.
 */

export interface WorkbenchJobInput {
  code: string
  files?: { name: string; data: Buffer }[]
  timeoutMs?: number
  /**
   * v1.8: a session key (in practice the conversation id). Runs sharing a key
   * keep their globals and /work between calls — a REPL scoped to one
   * conversation. Absent = fresh globals for this job, exactly as before.
   */
  session?: string | null
  /**
   * v2.7 Code Mode: the generated `tools` module and the app's answer to each
   * call a program makes through it. The sandbox only relays; `onCall` is the
   * app's ordinary tool path, allowlists, budgets and audit included, and it
   * runs in whoever asked for the job — the renderer, for a turn.
   */
  bridge?: {
    sdk: string
    onCall: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; output?: string; error?: string }>
  }
}

export interface WorkbenchOutcome {
  ok: boolean
  stdout: string
  stderr: string
  result: string | null
  files: { name: string; data: Buffer }[]
  durationMs: number
  /**
   * v1.12.4: milliseconds this call spent waiting for the runtime to come up
   * before a line of its code ran — the one-time CPython-in-WASM load, charged
   * to whoever asked first. 0 on every later run of the session.
   *
   * `durationMs` is measured inside the page, and the host only sends the job
   * once `ensureSandbox()` has resolved, so the boot was invisible to it: a
   * cold call reported 6 ms against a warm one's 20 ms and read as the faster
   * of the two (judge-r3/TTU2/run-1). The wait was real either way; this is
   * where it is written down.
   */
  bootMs?: number
  error?: string
  /** True when the sandbox had to be restarted (timeout or crash). */
  restarted?: boolean
  /** v1.8: this run continued an existing session's globals. */
  resumed?: boolean
  /** v1.8: names defined in the session after this run (sorted, capped at 40). */
  sessionVars?: string[]
  /**
   * v1.8: this run asked for a session the sandbox had served before, but the
   * state was gone (restart, idle teardown, app relaunch) — earlier variables
   * no longer exist and the model should be told so.
   */
  sessionReset?: boolean
}

export interface WorkbenchStatus {
  available: boolean
  version: string | null
  reason?: string
  /**
   * The runtime is loaded and serving jobs — the next run pays no cold start.
   * Not "a window object exists": that is true from the first millisecond of a
   * boot that has seconds left to run, which is precisely the window in which
   * a caller needs to be told it is waiting.
   */
  warm: boolean
  /** Top-level packages bundled offline (from workbench-packages.json), e.g. numpy, pandas, matplotlib. */
  packages: string[]
}

const SCHEME = 'sigma-workbench'
const HOST = 'app'
const PARTITION = 'workbench'
const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 180_000
/** Total bytes of files read back from /work per job. */
const MAX_OUTPUT_FILE_BYTES = 8 * 1024 * 1024
const MAX_OUTPUT_FILES = 24
const MAX_STDIO_CHARS = 200_000
/** Idle sandbox is destroyed after this long: it holds ~150 MB. */
const IDLE_MS = 10 * 60 * 1000
/**
 * A runtime start under this is not a wait anyone noticed, and reporting it
 * would put a boot line on every run that failed fast — the runtime-not-
 * installed refusal returns in about a millisecond. A real one is seconds.
 */
const BOOT_REPORT_MS = 250

/** Must run before app.whenReady(): standard + secure so fetch() and WASM work under it. */
export function registerWorkbenchScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
  ])
}

export function pyodideDir(): string {
  // SIGMA_PYODIDE_DIR: the check suite runs from .test-build with no app path.
  if (process.env.SIGMA_PYODIDE_DIR) return process.env.SIGMA_PYODIDE_DIR
  if (app.isPackaged) return join(process.resourcesPath, 'pyodide')
  // Dev: the repo's resources/. app.getAppPath() is the usual answer; when the
  // app is launched through a wrapper script it points elsewhere, so the
  // location relative to this file (out/main → ../../resources) is the fallback.
  const candidates = [join(app.getAppPath(), 'resources', 'pyodide'), join(__dirname, '..', '..', 'resources', 'pyodide')]
  return candidates.find((c) => existsSync(join(c, 'pyodide.js'))) ?? candidates[0]
}

function preloadPath(): string {
  if (process.env.SIGMA_WORKBENCH_PRELOAD) return process.env.SIGMA_WORKBENCH_PRELOAD
  // out/preload/workbench.js next to out/main (dev and asar alike).
  return join(__dirname, '../preload/workbench.js')
}

async function runtimeVersion(): Promise<string | null> {
  try {
    const pkg = JSON.parse(await fs.readFile(join(pyodideDir(), 'package.json'), 'utf-8')) as { version?: string }
    return pkg.version ?? null
  } catch {
    return null
  }
}

function runtimePresent(): boolean {
  return existsSync(join(pyodideDir(), 'pyodide.js')) && existsSync(join(pyodideDir(), 'pyodide.asm.wasm'))
}

/** Exported for callers that must refuse fast (docx extraction) instead of paying a cold start to fail. */
export function workbenchRuntimePresent(): boolean {
  return runtimePresent()
}

// ---- the page --------------------------------------------------------------------

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Sigma Oasis Workbench</title></head>
<body><script src="${SCHEME}://${HOST}/pyodide/pyodide.js"></script><script src="${SCHEME}://${HOST}/workbench.js"></script></body></html>`

/**
 * The page's own script: load Pyodide from the app scheme, then serve jobs.
 * stdout/stderr are captured batched; the last expression's repr is returned;
 * files that appeared or changed under /work are read back (bounded). Errors
 * carry the Python traceback in `stderr` and `error`. Timeouts are the host's
 * job (window destroy), because a synchronous Python loop cannot be
 * interrupted here.
 *
 * Sessions (v1.8): a job carrying a `session` key keeps its globals and /work
 * between runs with the same key — a REPL scoped to one conversation, so
 * "now filter that to Q4" works on the dataframe already loaded instead of
 * re-writing the whole load-and-clean preamble (each rewrite being a fresh
 * chance for a small model to err). A different key resets both; a job with
 * no key runs in fresh globals every time exactly as before (profiles, the
 * verification recompute and code checks stay stateless by construction —
 * a check that could see session state would not be checking the reply).
 * At most one session lives at a time: the newest key wins, so RAM holds one
 * conversation's dataframes, not every conversation's.
 */
const PAGE_JS = String.raw`
(() => {
  const MAX_FILES = ${MAX_OUTPUT_FILES};
  const MAX_FILE_BYTES = ${MAX_OUTPUT_FILE_BYTES};
  const MAX_STDIO = ${MAX_STDIO_CHARS};
  let pyodide = null;
  const ready = (async () => {
    try {
      pyodide = await loadPyodide({ indexURL: '${SCHEME}://${HOST}/pyodide/' });
      pyodide.FS.mkdirTree('/work');
      window.workbench.ready({ version: pyodide.version });
    } catch (e) {
      window.workbench.failed(String(e && e.message ? e.message : e));
      throw e;
    }
  })();

  const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bytesToB64 = (bytes) => { let s = ''; const CH = 0x8000; for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH)); return btoa(s); };

  const listWork = () => {
    const out = new Map();
    const walk = (dir) => {
      for (const name of pyodide.FS.readdir(dir)) {
        if (name === '.' || name === '..') continue;
        const p = dir === '/work' ? '/work/' + name : dir + '/' + name;
        const st = pyodide.FS.stat(p);
        if (pyodide.FS.isDir(st.mode)) walk(p); else out.set(p, st.mtime + ':' + st.size);
      }
    };
    walk('/work');
    return out;
  };
  const clearWork = () => {
    const rm = (dir) => {
      for (const name of pyodide.FS.readdir(dir)) {
        if (name === '.' || name === '..') continue;
        const p = dir + '/' + name;
        const st = pyodide.FS.stat(p);
        if (pyodide.FS.isDir(st.mode)) { rm(p); pyodide.FS.rmdir(p); } else pyodide.FS.unlink(p);
      }
    };
    rm('/work');
  };

  // The one live session: its key and its kept globals (a PyProxy dict).
  let sessionKey = null;
  let sessionGlobals = null;

  // v2.7 Code Mode: a program's tool calls. Python awaits _sigma_bridge.call,
  // which posts the call to the app and resolves with the app's JSON answer.
  // The module is registered once; a job with no SDK never imports it, and a
  // call outside a bridged job is refused by the app, not answered here.
  const bridgeWaits = new Map();
  let bridgeCounter = 0;
  let currentJobId = null;
  window.workbench.onToolResult((r) => {
    const w = bridgeWaits.get(r.callId);
    if (!w) return;
    bridgeWaits.delete(r.callId);
    w(r.resultJson);
  });
  const registerBridge = () => {
    pyodide.registerJsModule('_sigma_bridge', {
      call: (name, argsJson) => new Promise((resolve) => {
        const callId = 'call-' + (++bridgeCounter);
        bridgeWaits.set(callId, resolve);
        window.workbench.callTool({ jobId: currentJobId, callId, name: String(name), argsJson: String(argsJson) });
      })
    });
  };
  let bridgeRegistered = false;

  window.workbench.onJob(async (job) => {
    const started = performance.now();
    let stdout = '', stderr = '';
    const cap = (s, add) => (s.length >= MAX_STDIO ? s : (s + add).slice(0, MAX_STDIO));
    try {
      await ready;
      const wantSession = job.session || null;
      let resumed = false;
      if (wantSession && wantSession === sessionKey && sessionGlobals) {
        resumed = true; // same conversation: keep globals AND /work
      } else if (wantSession) {
        if (sessionGlobals) { try { sessionGlobals.destroy(); } catch (_) {} }
        sessionGlobals = null; sessionKey = wantSession;
        clearWork();
      } else if (!sessionKey) {
        clearWork(); // sessionless steady state: fresh /work per job, as always
      } // else: a one-shot alongside a live session — leave the session's /work alone
      for (const f of job.files || []) {
        const safe = String(f.name).replace(/[\/\\]/g, '_');
        pyodide.FS.writeFile('/work/' + safe, b64ToBytes(f.base64));
      }
      currentJobId = job.id;
      // A fresh module object each job: the SDK may have changed with the
      // tool set, and a job with no bridge must not inherit the last one's.
      try { pyodide.runPython('import sys; sys.modules.pop("tools", None)'); } catch (_) {}
      if (job.sdk) {
        if (!bridgeRegistered) { registerBridge(); bridgeRegistered = true; }
        pyodide.FS.writeFile('/work/tools.py', job.sdk);
      } else {
        try { pyodide.FS.unlink('/work/tools.py'); } catch (_) {}
      }
      // Snapshot after the SDK is written, so the generated module is the
      // app's and never reported as a file the program wrote.
      const before = listWork();
      pyodide.setStdout({ batched: (s) => { stdout = cap(stdout, s + '\n'); } });
      pyodide.setStderr({ batched: (s) => { stderr = cap(stderr, s + '\n'); } });
      pyodide.runPython('import os, sys; os.chdir("/work"); sys.path.insert(0, "/work"); os.environ.setdefault("MPLBACKEND", "Agg")');
      // Packages the code imports load from the bundled wheels (offline). One
      // that is not bundled fails here; the run still happens so the model
      // gets Python's own ModuleNotFoundError plus our note naming what is.
      let packageNote = '';
      try {
        await pyodide.loadPackagesFromImports(job.code, { messageCallback: () => {}, errorCallback: () => {} });
        // pandas' .plot() needs matplotlib without importing it (measured:
        // "matplotlib is required for plotting" on the first real chart).
        if (/^\s*(import|from)\s+pandas\b/m.test(job.code) && /\.plot\s*\(/.test(job.code)) {
          await pyodide.loadPackage('matplotlib', { messageCallback: () => {}, errorCallback: () => {} });
        }
      } catch (e) {
        packageNote = 'Package load: ' + String(e && e.message ? e.message : e);
      }
      const globals = resumed ? sessionGlobals : pyodide.toPy({ __name__: '__main__' });
      let result = null, ok = true, error;
      try {
        const r = await pyodide.runPythonAsync(job.code, { globals });
        if (r !== undefined && r !== null) {
          try {
            const repr = pyodide.globals.get('repr');
            result = String(repr(r));
            if (r && typeof r.destroy === 'function') r.destroy();
          } catch (e2) { result = String(r); }
        }
      } catch (e) {
        ok = false;
        error = String(e && e.message ? e.message : e);
        if (packageNote) error += '\n' + packageNote;
      } finally {
        // A session keeps its globals — like a REPL, an exception mid-run
        // leaves earlier definitions standing. One-shots destroy theirs.
        if (wantSession) sessionGlobals = globals;
        else { try { globals.destroy(); } catch (_) {} }
      }
      // Which names the session now holds, so the model can see its own state.
      let sessionVars = [];
      if (wantSession) {
        try {
          sessionVars = JSON.parse(pyodide.runPython(
            'import json as _sj; _sj.dumps(sorted([k for k in list(globals().keys()) if not k.startswith("_")])[:40])',
            { globals }
          ));
        } catch (_) {}
      }
      if (ok && packageNote) stderr = cap(stderr, packageNote + '\n');
      // Files that appeared or changed.
      const after = listWork();
      const files = [];
      let total = 0;
      for (const [p, sig] of after) {
        if (before.get(p) === sig) continue;
        if (files.length >= MAX_FILES) break;
        const bytes = pyodide.FS.readFile(p);
        if (total + bytes.length > MAX_FILE_BYTES) break;
        total += bytes.length;
        files.push({ name: p.slice('/work/'.length), base64: bytesToB64(bytes), bytes: bytes.length });
      }
      window.workbench.result({ id: job.id, ok, stdout, stderr, result, files, durationMs: Math.round(performance.now() - started), error, resumed, sessionVars });
    } catch (e) {
      window.workbench.result({ id: job.id, ok: false, stdout, stderr, result: null, files: [], durationMs: Math.round(performance.now() - started), error: 'sandbox: ' + String(e && e.message ? e.message : e) });
    }
  });
})();
`

const CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; worker-src 'self' blob:; base-uri 'none'; form-action 'none'"

/** MIME by extension. Takes a file name, not a bare extension — extname('.html') is '' (dotfile rule). */
function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.js':
    case '.mjs':
      return 'text/javascript'
    case '.wasm':
      return 'application/wasm'
    case '.json':
      return 'application/json'
    case '.zip':
      return 'application/zip'
    case '.html':
      return 'text/html; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}

let schemeHandlerInstalled = false

/** Serve the page, its script and the runtime files on the workbench session only. */
function installSchemeHandler(ses: Electron.Session): void {
  if (schemeHandlerInstalled) return
  schemeHandlerInstalled = true
  const root = pyodideDir()
  ses.protocol.handle(SCHEME, async (request) => {
    if (process.env.SIGMA_WORKBENCH_DEBUG) console.log('[workbench scheme]', request.url)
    const url = new URL(request.url)
    if (url.host !== HOST) return new Response('not found', { status: 404 })
    const path = decodeURIComponent(url.pathname)
    const headers: Record<string, string> = { 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' }
    if (path === '/workbench.html') return new Response(PAGE_HTML, { headers: { ...headers, 'Content-Type': contentType('workbench.html') } })
    if (path === '/workbench.js') return new Response(PAGE_JS, { headers: { ...headers, 'Content-Type': contentType('workbench.js') } })
    if (path.startsWith('/pyodide/')) {
      // Path-confined to the runtime directory: no traversal, no other files.
      const rel = normalize(path.slice('/pyodide/'.length)).replace(/^(\.\.[/\\])+/, '')
      const file = join(root, rel)
      if (!file.startsWith(root) || rel.includes('..')) return new Response('forbidden', { status: 403 })
      try {
        const data = await fs.readFile(file)
        return new Response(data, { headers: { ...headers, 'Content-Type': contentType(file) } })
      } catch {
        return new Response('not found', { status: 404 })
      }
    }
    return new Response('not found', { status: 404 })
  })
}

// ---- window lifecycle ---------------------------------------------------------------

let win: BrowserWindow | null = null
let readyPromise: Promise<string> | null = null
/** The runtime has finished loading and is serving jobs. See WorkbenchStatus.warm. */
let runtimeReady = false
let idleTimer: NodeJS.Timeout | null = null
let ipcInstalled = false
const pending = new Map<string, { resolve: (r: WorkbenchOutcome) => void; timer: NodeJS.Timeout }>()
/** v2.7: the bridge of each job that has one — the app's answer to a program's tool call, and the timer re-arm. */
const bridges = new Map<string, { onCall: NonNullable<WorkbenchJobInput['bridge']>['onCall']; rearm: () => void }>()
let queue: Promise<unknown> = Promise.resolve()

function armIdle(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => destroySandbox('idle'), IDLE_MS)
}

function destroySandbox(reason: string): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  const w = win
  win = null
  readyPromise = null
  runtimeReady = false
  if (w && !w.isDestroyed()) w.destroy()
  for (const [id, p] of pending) {
    clearTimeout(p.timer)
    p.resolve({ ok: false, stdout: '', stderr: '', result: null, files: [], durationMs: 0, error: `sandbox ${reason}`, restarted: true })
    pending.delete(id)
  }
}

function installIpc(): void {
  if (ipcInstalled) return
  ipcInstalled = true
  ipcMain.on('workbench:result', (event, r: { id: string; ok: boolean; stdout: string; stderr: string; result: string | null; files: { name: string; base64: string; bytes: number }[]; durationMs: number; error?: string; resumed?: boolean; sessionVars?: string[] }) => {
    if (!win || event.sender !== win.webContents) return
    const p = pending.get(r.id)
    if (!p) return
    pending.delete(r.id)
    clearTimeout(p.timer)
    p.resolve({
      ok: r.ok,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      result: r.result ?? null,
      files: (r.files ?? []).map((f) => ({ name: f.name, data: Buffer.from(f.base64, 'base64') })),
      durationMs: r.durationMs ?? 0,
      error: r.error,
      resumed: r.resumed === true,
      sessionVars: Array.isArray(r.sessionVars) ? r.sessionVars.filter((v) => typeof v === 'string').slice(0, 40) : undefined
    })
    armIdle()
  })
  // v2.7 Code Mode: a program's tool call. Relayed to the job's bridge and
  // answered by callId; a job with no bridge, or a call after the job ended,
  // is refused in the program's own terms. The sandbox never learns which
  // tools exist beyond the module it was given.
  ipcMain.on('workbench:call', (event, call: { jobId: string; callId: string; name: string; argsJson: string }) => {
    if (!win || event.sender !== win.webContents) return
    const reply = (result: { ok: boolean; output?: string; error?: string }): void => {
      if (win && !win.isDestroyed()) win.webContents.send('workbench:callResult', { jobId: call.jobId, callId: call.callId, resultJson: JSON.stringify(result) })
    }
    const bridge = bridges.get(String(call.jobId))
    if (!bridge) return reply({ ok: false, error: 'This program cannot call tools.' })
    let args: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(String(call.argsJson ?? '{}'))
      args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch {
      return reply({ ok: false, error: 'Arguments must be a JSON object.' })
    }
    void bridge
      .onCall(String(call.name), args)
      .then((r) => reply({ ok: r.ok, ...(r.ok ? { output: r.output ?? '' } : { error: r.error ?? 'failed' }) }))
      .catch((err: unknown) => reply({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      .finally(() => bridges.get(String(call.jobId))?.rearm())
  })
  // The hidden sandbox must never keep the app alive: when every *other*
  // window has closed, tear it down so window-all-closed fires as before.
  // (Electron has no browser-window-closed app event; each app window's own
  // 'closed' is watched instead when the sandbox is created — see ensureSandbox.)
  app.on('before-quit', () => destroySandbox('quit'))
}

async function ensureSandbox(): Promise<string> {
  if (win && !win.isDestroyed() && readyPromise) return readyPromise
  if (!runtimePresent()) {
    throw new Error(
      `Workbench runtime not installed (${pyodideDir()}). Run scripts/fetch-pyodide.sh in a checkout; packaged builds include it.`
    )
  }
  installIpc()
  const ses = session.fromPartition(PARTITION)
  installSchemeHandler(ses)
  // Belt and braces with the CSP: refuse every request that is not ours.
  ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith(`${SCHEME}://${HOST}/`) }))
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)

  const w = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      session: ses,
      preload: preloadPath(),
      backgroundThrottling: false
    }
  })
  win = w
  if (process.env.SIGMA_WORKBENCH_DEBUG) {
    w.webContents.on('console-message', (e) => console.log('[workbench page]', String(e.message ?? '').slice(0, 500)))
    w.webContents.on('did-fail-load', (_e, code, desc, url) => console.log('[workbench page] fail-load', code, desc, url))
  }
  // Watch every other window: when the last of them closes, tear the sandbox
  // down so 'window-all-closed' fires exactly as it did before the Workbench.
  const watchClose = (other: BrowserWindow): void => {
    if (other === w) return
    other.once('closed', () => {
      const remaining = BrowserWindow.getAllWindows().filter((x) => x !== win && !x.isDestroyed())
      if (remaining.length === 0) destroySandbox('last window closed')
    })
  }
  BrowserWindow.getAllWindows().forEach(watchClose)
  app.on('browser-window-created', (_e, created) => watchClose(created))
  readyPromise = new Promise<string>((resolve, reject) => {
    const onReady = (event: Electron.IpcMainEvent, info: { version: string }): void => {
      if (event.sender !== w.webContents) return
      cleanup()
      runtimeReady = true
      resolve(info.version)
    }
    const onFailed = (event: Electron.IpcMainEvent, message: string): void => {
      if (event.sender !== w.webContents) return
      cleanup()
      reject(new Error(`Workbench runtime failed to load: ${message}`))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Workbench runtime did not become ready in time.'))
    }, 90_000)
    const cleanup = (): void => {
      clearTimeout(timer)
      ipcMain.removeListener('workbench:ready', onReady)
      ipcMain.removeListener('workbench:failed', onFailed)
    }
    ipcMain.on('workbench:ready', onReady)
    ipcMain.on('workbench:failed', onFailed)
    w.webContents.on('render-process-gone', (_e, details) => {
      cleanup()
      reject(new Error(`Workbench sandbox crashed (${details.reason}).`))
      destroySandbox(`crashed: ${details.reason}`)
    })
    w.loadURL(`${SCHEME}://${HOST}/workbench.html`).catch((err) => {
      if (process.env.SIGMA_WORKBENCH_DEBUG) console.log('[workbench] loadURL rejected:', err, w.webContents.getURL())
      cleanup()
      reject(err instanceof Error ? err : new Error(String(err)))
    })
  })
  readyPromise.catch(() => destroySandbox('failed to start'))
  return readyPromise
}

let jobCounter = 0

/** Run Python in the sandbox. Serialized: one job at a time. */
export function runPython(input: WorkbenchJobInput): Promise<WorkbenchOutcome> {
  const run = async (): Promise<WorkbenchOutcome> => {
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, input.timeoutMs ?? DEFAULT_TIMEOUT_MS))
    let restarted = false
    // The boot is the wait between asking and the code starting, so it is
    // measured here — around ensureSandbox — and not in the page, which is not
    // even sent the job until the runtime is up.
    const askedAt = Date.now()
    const cold = !runtimeReady
    const bootSoFar = (): number => {
      const ms = cold ? Date.now() - askedAt : 0
      return ms >= BOOT_REPORT_MS ? ms : 0
    }
    try {
      await ensureSandbox()
    } catch (err) {
      // A refusal (runtime not installed) returns in a millisecond; nobody
      // waited on a sandbox, so nothing is charged to one.
      return { ok: false, stdout: '', stderr: '', result: null, files: [], durationMs: 0, bootMs: bootSoFar(), error: err instanceof Error ? err.message : String(err) }
    }
    const bootMs = bootSoFar()
    const w = win!
    const id = `job-${++jobCounter}`
    const outcome = await new Promise<WorkbenchOutcome>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        restarted = true
        destroySandbox(`timed out after ${Math.round(timeoutMs / 1000)}s`)
        resolve({
          ok: false,
          stdout: '',
          stderr: '',
          result: null,
          files: [],
          durationMs: timeoutMs,
          error: `Timed out after ${Math.round(timeoutMs / 1000)}s; the sandbox was restarted. Simplify the code or ask for less.`,
          restarted: true
        })
      }, timeoutMs)
      pending.set(id, { resolve, timer })
      if (input.bridge) {
        // v2.7: the program's tool calls come back through here. The job
        // timer is re-armed after every answered call — the budget is per
        // segment of Python between calls, since the wait for a tool is the
        // app's time, not the sandbox's.
        bridges.set(id, {
          onCall: input.bridge.onCall,
          rearm: () => {
            const p = pending.get(id)
            if (!p) return
            clearTimeout(p.timer)
            p.timer = setTimeout(() => {
              pending.delete(id)
              bridges.delete(id)
              restarted = true
              destroySandbox(`timed out after ${Math.round(timeoutMs / 1000)}s`)
              resolve({ ok: false, stdout: '', stderr: '', result: null, files: [], durationMs: timeoutMs, error: `Timed out after ${Math.round(timeoutMs / 1000)}s between tool calls; the sandbox was restarted.`, restarted: true })
            }, timeoutMs)
          }
        })
      }
      w.webContents.send('workbench:job', {
        id,
        code: input.code,
        session: input.session ?? null,
        files: (input.files ?? []).map((f) => ({ name: f.name, base64: f.data.toString('base64') })),
        ...(input.bridge ? { sdk: input.bridge.sdk } : {})
      })
    })
    bridges.delete(id)
    const final: WorkbenchOutcome = { ...outcome, bootMs, ...(restarted ? { restarted: true } : {}) }
    // v1.8: a session the sandbox has served before that did not resume means
    // its state is gone (restart, idle teardown, relaunch). Tracked across
    // sandbox lifetimes on purpose — that is exactly when it matters.
    if (input.session) {
      if (sessionsEverSeen.has(input.session) && !final.resumed) final.sessionReset = true
      sessionsEverSeen.add(input.session)
      if (sessionsEverSeen.size > 500) sessionsEverSeen.clear()
    }
    return final
  }
  const next = queue.then(run, run)
  queue = next.catch(() => undefined)
  return next
}

/** Session keys ever served, for the reset disclosure above. */
const sessionsEverSeen = new Set<string>()

/** Top-level packages the fetch script bundled (empty when only the core is present). */
export async function bundledPackages(): Promise<string[]> {
  try {
    const j = JSON.parse(await fs.readFile(join(pyodideDir(), 'workbench-packages.json'), 'utf-8')) as { requested?: string[] }
    return Array.isArray(j.requested) ? j.requested : []
  } catch {
    return []
  }
}

export async function workbenchStatus(): Promise<WorkbenchStatus> {
  if (!runtimePresent()) {
    return { available: false, version: null, warm: false, packages: [], reason: `Runtime not found at ${pyodideDir()}` }
  }
  return { available: true, version: await runtimeVersion(), warm: runtimeReady && Boolean(win && !win.isDestroyed()), packages: await bundledPackages() }
}

/** Warm the sandbox ahead of a likely job (e.g. a CSV was attached). Best effort. */
export function warmWorkbench(): void {
  ensureSandbox().then(armIdle, () => undefined)
}

export function registerWorkbenchHandlers(): void {
  ipcMain.handle('workbench:status', () => workbenchStatus())
  ipcMain.handle('workbench:warm', () => {
    warmWorkbench()
    return true
  })
}
