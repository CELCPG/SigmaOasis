/**
 * The Workbench round-trip in Electron proper: a real sandboxed window loads
 * Pyodide from the app scheme and runs Python. Self-skips when the runtime is
 * not fetched (scripts/fetch-pyodide.sh) so a fresh clone's suite still runs.
 *
 * What is pinned: stdout and last-expression capture, tracebacks as failures
 * the model can read, files written under /work coming back, fresh globals per
 * job, that the sandbox cannot reach the network or the disk, and that a
 * runaway job is killed and the next job still works.
 */
import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

process.env.SIGMA_PYODIDE_DIR = process.env.SIGMA_PYODIDE_DIR || join(__dirname, '..', '..', 'resources', 'pyodide')
process.env.SIGMA_WORKBENCH_PRELOAD = process.env.SIGMA_WORKBENCH_PRELOAD || join(__dirname, '..', 'src', 'preload', 'workbench.js')

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

async function main(): Promise<void> {
  if (!existsSync(join(process.env.SIGMA_PYODIDE_DIR!, 'pyodide.asm.wasm'))) {
    console.log('skipping Workbench checks: runtime not fetched (bash scripts/fetch-pyodide.sh)')
    app.exit(0)
    return
  }
  // Loaded after the env is set so pyodideDir()/preloadPath() see it.
  const wb = require('../src/main/ipc/workbench') as typeof import('../src/main/ipc/workbench')
  const fmt = require('../src/main/ipc/workbenchFormat') as typeof import('../src/main/ipc/workbenchFormat')

  console.log('\nWorkbench: sandboxed Python round-trip')
  const t0 = Date.now()
  let r = await wb.runPython({ code: 'print("hello from python")\n17 * 23' })
  console.log(`  (cold start + first job: ${Date.now() - t0} ms)`)
  check('runs and captures stdout', r.ok && /hello from python/.test(r.stdout), JSON.stringify(r).slice(0, 300))
  check('returns the last expression', r.result === '391', String(r.result))
  const status = await wb.workbenchStatus()
  check('reports the runtime version and a warm sandbox', status.available && Boolean(status.version) && status.warm, JSON.stringify(status))

  r = await wb.runPython({ code: 'x = 1/0' })
  check('a Python error is ok:false with the traceback', !r.ok && /ZeroDivisionError/.test(r.error ?? ''), r.error)
  const f = fmt.formatRun(r, 'x = 1/0')
  check('formatRun tells the model not to guess', !f.ok && /do not guess/.test(f.error ?? ''))

  r = await wb.runPython({ code: 'print(x)' })
  check('globals are fresh per job (previous x is gone)', !r.ok && /NameError/.test(r.error ?? ''), r.error)

  r = await wb.runPython({
    code: 'import csv\nrows=list(csv.reader(open("in.csv")))\nprint(len(rows))\nopen("out.txt","w").write("done")\nimport json; json.dump({"a":1}, open("o.json","w"))',
    files: [{ name: 'in.csv', data: Buffer.from('a,b\n1,2\n3,4\n') }]
  })
  check('input files appear under /work and outputs come back', r.ok && /^3/m.test(r.stdout) && r.files.some((x) => x.name === 'out.txt' && x.data.toString() === 'done'), JSON.stringify({ stdout: r.stdout, files: r.files.map((x) => x.name), err: r.error }))
  const ff = fmt.formatRun(r, '')
  check('formatRun inlines small text outputs', ff.ok && /out\.txt/.test(ff.output ?? '') && /done/.test(ff.output ?? ''))

  // /home/pyodide exists inside the virtual FS (Emscripten's default home);
  // what must be absent are the host's directories.
  r = await wb.runPython({ code: 'import os\nprint(sorted(os.listdir("/work")))\nprint(os.path.exists("/Users"), os.path.exists("/Applications"), os.path.exists("/etc/passwd"), os.path.exists("C:/Windows"))' })
  check('/work is emptied between jobs and the real disk is not mounted', r.ok && /\[\]/.test(r.stdout) && /False False False False/.test(r.stdout), r.stdout)

  r = await wb.runPython({
    code: 'import urllib.request\ntry:\n    urllib.request.urlopen("http://127.0.0.1:1234/v1/models", timeout=5)\n    print("REACHED")\nexcept Exception as e:\n    print("blocked:", type(e).__name__)'
  })
  check('the sandbox cannot reach the network (not even loopback)', !/REACHED/.test(r.stdout), r.stdout + (r.error ?? ''))

  r = await wb.runPython({ code: 'from js import fetch\nimport asyncio\nasync def go():\n    try:\n        await fetch("https://example.com/")\n        print("REACHED")\n    except Exception as e:\n        print("blocked:", type(e).__name__)\nawait go()' })
  check('nor via the JS bridge', !/REACHED/.test(r.stdout), r.stdout + (r.error ?? ''))

  const t1 = Date.now()
  r = await wb.runPython({ code: 'while True: pass', timeoutMs: 3000 })
  check('a runaway job is killed at its budget and reported', !r.ok && r.restarted === true && /Timed out/.test(r.error ?? ''), `${r.error} after ${Date.now() - t1} ms`)
  r = await wb.runPython({ code: 'print(2+2)' })
  check('the next job works after the restart', r.ok && /^4/m.test(r.stdout), JSON.stringify(r).slice(0, 200))

  console.log(`\n${'='.repeat(58)}`)
  if (failures.length === 0) {
    console.log(`ALL ${passed} WORKBENCH CHECKS PASSED`)
    app.exit(0)
  } else {
    console.log(`${passed} passed, ${failures.length} FAILED:`)
    for (const x of failures) console.log(`  - ${x}`)
    app.exit(1)
  }
}

// Scheme registration must precede ready.
require('../src/main/ipc/workbench').registerWorkbenchScheme()
app.on('window-all-closed', () => undefined)
app.whenReady().then(() =>
  main().catch((err) => {
    console.error('WORKBENCH CHECK ERROR:', err)
    app.exit(1)
  })
)
