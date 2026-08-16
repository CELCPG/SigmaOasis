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

  // ---- analyze_file's profiler on real files ----------------------------------
  console.log('\nanalyze_file: mechanical profile of CSV / JSON / XLSX')
  const prof = require('../src/main/ipc/workbenchProfile') as typeof import('../src/main/ipc/workbenchProfile')
  const csv = 'date,region,amount,note\n2025-01-03,West,12.50,ok\n2025-01-04,East,7,\n2025-01-04,East,7,\n2025-02-10,West,1249.99,big\n2025-03-01,North,N/A,\n'
  r = await wb.runPython({ code: prof.profileScript('sales.csv', null), files: [{ name: 'sales.csv', data: Buffer.from(csv) }] })
  let p = prof.parseProfile(r.stdout)
  check('CSV: rows/columns/duplicates', Boolean(p) && p!.rows === 5 && p!.columns === 4 && p!.duplicateRows === 1, JSON.stringify(p).slice(0, 300) + (r.error ?? ''))
  const amount = p?.profile?.find((c) => c.name === 'amount')
  check('CSV: numeric column typed with stats and a null counted', amount?.type === 'number' && amount.nulls === 1 && amount.max === 1249.99 && Math.abs((amount.sum ?? 0) - 1276.49) < 0.001, JSON.stringify(amount))
  const date = p?.profile?.find((c) => c.name === 'date')
  check('CSV: dates detected with range', date?.type === 'date' && date.min === '2025-01-03' && date.max === '2025-03-01', JSON.stringify(date))
  const region = p?.profile?.find((c) => c.name === 'region')
  check('CSV: text column with distinct + top', region?.type === 'text' && region.distinct === 3 && region.top?.length === 3 && region.top.every(([, n]) => n >= 1), JSON.stringify(region))
  const text = prof.formatProfile(p!)
  check('CSV: the report reads as facts and carries the rule', /5 data row\(s\) × 4 column\(s\)/.test(text) && /do not eyeball/.test(text), text.slice(0, 200))

  r = await wb.runPython({ code: prof.profileScript('recs.json', null), files: [{ name: 'recs.json', data: Buffer.from(JSON.stringify([{ id: 1, name: 'a', score: 3.5 }, { id: 2, name: 'b', score: 4 }, { id: 3, name: 'c', score: null }])) }] })
  p = prof.parseProfile(r.stdout)
  check('JSON records → table with types', Boolean(p) && p!.kind === 'json' && p!.rows === 3 && p!.profile?.find((c) => c.name === 'score')?.nulls === 1, JSON.stringify(p).slice(0, 300) + (r.error ?? ''))

  // A minimal valid XLSX built by hand: two sheets, shared strings, numbers.
  const xlsxFiles: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Q3" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4"><si><t>item</t></si><si><t>qty</t></si><si><t>widget</t></si><si><t>gadget</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>10</v></c></row><row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>32</v></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>memo</t></is></c></row></sheetData></worksheet>'
  }
  // Store-only zip writer (no compression), enough for zipfile to read.
  const zipStore = (entries: Record<string, string>): Buffer => {
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
    const crc32 = (buf: Buffer): number => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
    const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0
    for (const [name, content] of Object.entries(entries)) {
      const data = Buffer.from(content, 'utf-8'); const nameB = Buffer.from(name); const crc = crc32(data)
      const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameB.length, 26); lh.writeUInt16LE(0, 28)
      const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42)
      locals.push(lh, nameB, data); centrals.push(ch, nameB); offset += lh.length + nameB.length + data.length
    }
    const cd = Buffer.concat(centrals); const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6); eocd.writeUInt16LE(centrals.length / 2, 8); eocd.writeUInt16LE(centrals.length / 2, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20)
    return Buffer.concat([...locals, cd, eocd])
  }
  const xlsx = zipStore(xlsxFiles)
  r = await wb.runPython({ code: prof.profileScript('book.xlsx', null), files: [{ name: 'book.xlsx', data: xlsx }] })
  p = prof.parseProfile(r.stdout)
  check('XLSX: first sheet parsed with shared strings and numbers', Boolean(p) && p!.kind === 'xlsx' && p!.sheet === 'Q3' && p!.rows === 2 && p!.profile?.find((c) => c.name === 'qty')?.sum === 42, JSON.stringify(p).slice(0, 400) + (r.error ?? '') + r.stderr)
  check('XLSX: sibling sheets are listed', Boolean(p?.sheets) && p!.sheets!.join(',') === 'Q3,Notes', JSON.stringify(p?.sheets))
  r = await wb.runPython({ code: prof.profileScript('book.xlsx', 'Notes'), files: [{ name: 'book.xlsx', data: xlsx }] })
  p = prof.parseProfile(r.stdout)
  check('XLSX: a named sheet, inline strings', Boolean(p) && p!.sheet === 'Notes' && p!.columns === 1 && (p!.head?.[0]?.[0] === 'memo'), JSON.stringify(p).slice(0, 300))
  r = await wb.runPython({ code: prof.profileScript('book.xlsx', 'Nope'), files: [{ name: 'book.xlsx', data: xlsx }] })
  p = prof.parseProfile(r.stdout)
  check('XLSX: a missing sheet is a readable error naming the sheets', Boolean(p?.error) && /sheets: Q3, Notes/.test(p!.error!), JSON.stringify(p))

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
