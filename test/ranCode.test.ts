import { test, describe, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describeRun, explainRun, parseRanCode, totalWaitMs, type RanCodeOutput } from '../src/renderer/src/lib/ranCode'
import { RanCodeHeader } from '../src/renderer/src/components/RanCodeHeader'
import { startWaitClock } from '../src/renderer/src/lib/oasisRipple'
import { SANDBOX_BOOT_WAIT } from '../src/renderer/src/lib/turnPhase'
import { formatRun } from '../src/main/ipc/workbenchFormat'

/**
 * The "Ran code" block parses the run_python result text back into sections.
 * Pinned against the formatter's own output so the two cannot drift apart.
 */
const base = { ok: true, stdout: '', stderr: '', result: null, files: [] as { name: string; data: Buffer }[], durationMs: 3 }

describe('parseRanCode', () => {
  test('a successful run: duration, stdout, result, files; boilerplate dropped', () => {
    const text = formatRun({ ...base, durationMs: 1515, stdout: 'East 37907.39\nWest 37317.44\n', result: '391', files: [{ name: 'chart.png', data: Buffer.from('89504e470d0a1a0a', 'hex') }, { name: 'out.csv', data: Buffer.from('a,b\n1,2') }] }, '').output!
    const p = parseRanCode(text + '\n\nFiles available under /work: sales.csv.', true)
    assert.equal(p.durationMs, 1515)
    assert.equal(p.stdout, 'East 37907.39\nWest 37317.44')
    assert.equal(p.result, '391')
    assert.equal(p.files.length, 2)
    assert.match(p.files[0], /^chart\.png .*image — shown to the user/)
    assert.match(p.files[1], /^out\.csv/)
    assert.equal(p.error, '')
    assert.deepEqual(p.notes, ['Files available under /work: sales.csv.'])
    assert.equal(describeRun(p), 'ran in 1.5 s')
  })
  test('a failed run: stdout before the error, the traceback, no rule sentence', () => {
    const text = formatRun({ ...base, ok: false, durationMs: 40, stdout: 'partial\n', error: 'Traceback (most recent call last):\n  File "<exec>", line 2\nZeroDivisionError: division by zero' }, '').error!
    const p = parseRanCode(text, false)
    assert.equal(p.durationMs, 40)
    assert.equal(p.stdout, 'partial')
    assert.match(p.error, /ZeroDivisionError/)
    assert.ok(!p.notes.some((n) => /do not guess/.test(n)), 'the rule is not shown as a note')
    assert.equal(describeRun(p), 'failed after 40 ms')
  })
  test('the offline-package note is kept as a note', () => {
    const text = formatRun({ ...base, ok: false, error: "ModuleNotFoundError: No module named 'seaborn'" }, '').error! + '\n\nThe sandbox is offline: only the standard library and these packages are available: numpy, pandas, matplotlib. Rewrite without the missing module.'
    const p = parseRanCode(text, false)
    assert.ok(p.notes.some((n) => /numpy, pandas, matplotlib/.test(n)))
  })
  test('no output at all', () => {
    const p = parseRanCode(formatRun(base, '').output!, true)
    assert.equal(p.stdout, '')
    assert.equal(p.result, '')
    assert.deepEqual(p.notes, [])
    assert.equal(describeRun(p), 'ran in 3 ms')
  })
})

// ---- v1.11.2: constants are not computations ---------------------------------

describe('numbersLookHardcoded', () => {
  const { numbersLookHardcoded, HARDCODED_NUMBERS_NOTE } = require('../src/main/ipc/workbenchFormat') as typeof import('../src/main/ipc/workbenchFormat')

  test('a run that only prints its own literals is flagged', () => {
    // Verbatim shape from a real session: invented volatility "recomputed".
    const code = 'nvda_beta = 1.05\nxom_beta = 0.62\nprint(f"NVDA Beta: {nvda_beta:.2f}")\nprint(f"XOM Beta: {xom_beta:.2f}")'
    assert.equal(numbersLookHardcoded(code, 'NVDA Beta: 1.05\nXOM Beta: 0.62'), true)
  })

  test('numbers inside a printed string literal count as hardcoded', () => {
    const code = 'print("sales came in at 4.09M, up 3.2% YoY")'
    assert.equal(numbersLookHardcoded(code, 'sales came in at 4.09M, up 3.2% YoY'), true)
  })

  test('one genuinely derived value clears the run', () => {
    const code = 'cap = 10000\npositions = 5\nstop = 0.08\nprint(f"max loss: {cap/positions*stop:.2f}")'
    assert.equal(numbersLookHardcoded(code, 'max loss: 160.00'), false)
  })

  test('no numbers in stdout → not flagged', () => {
    assert.equal(numbersLookHardcoded('print("hello")', 'hello'), false)
  })

  test('formatRun swaps the banner on a hardcoded run and keeps it on a real one', () => {
    const { formatRun } = require('../src/main/ipc/workbenchFormat') as typeof import('../src/main/ipc/workbenchFormat')
    const base = { ok: true, stdout: '', stderr: '', result: null, files: [], durationMs: 5, restarted: false }
    const echo = formatRun({ ...base, stdout: 'TSLA daily move: 15%' } as never, 'x = 15\nprint(f"TSLA daily move: {x}%")').output!
    assert.ok(echo.includes(HARDCODED_NUMBERS_NOTE))
    assert.ok(!echo.includes('computed, not recalled'))
    const real = formatRun({ ...base, stdout: 'total: 391' } as never, 'print(f"total: {37+354}")').output!
    assert.ok(real.includes('computed, not recalled'))
  })
})

// ---- v1.12.4: the boot the block used to swallow -------------------------------

/**
 * Measured, TTU2 run-1 — a capture of the shipped build, the same prompt twice
 * in one session (.h2h-runs/judge-r3/TTU2/run-1):
 *
 *   turn 0, cold   header: "⚡ Ran Python  ran in 6 ms"    turn end 41840 ms
 *   turn 1, warm   header: "⚡ Ran Python  ran in 20 ms"   turn end 25483 ms
 *
 * The cold turn is the one that loaded the runtime, and it is displayed as more
 * than three times FASTER than the warm one, because durationMs is stopwatched
 * inside the sandbox page and the host does not send it the job until the
 * runtime is up. The load is charged to nobody.
 *
 * Nor was it named while it happened: grepping both transcripts for
 * sandbox|warm|first run|starting|boot|initializ|one-time|cold returns only the
 * after-the-event "Ran the Python in this reply in the sandbox".
 *
 * BOOT_MS is a stand-in for a several-second boot. Its value is the gap between
 * the two turns' first-visible times (11973 − 3364 ms) — the right order of
 * magnitude, but not a measurement of the boot: the capture reports no boot at
 * all, which is the bug. A real Pyodide load is timed and asserted against in
 * test/workbenchCheck.ts, which prints the cold and warm headers side by side.
 */
const BOOT_MS = 8609
const COLD_RUN_MS = 6
const WARM_RUN_MS = 20

const primes = { ok: true, stdout: 'Sum of the first 500 prime numbers: 854405\n', stderr: '', result: null, files: [] as { name: string; data: Buffer }[] }

function ran(durationMs: number, bootMs?: number): RanCodeOutput {
  return parseRanCode(formatRun({ ...primes, durationMs, ...(bootMs ? { bootMs } : {}) }, 'print(sum(primes))').output!, true)
}

function header(props: Partial<Parameters<typeof RanCodeHeader>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(RanCodeHeader, {
      status: 'running' as const,
      parsed: null,
      booting: false,
      waitedMs: 0,
      open: true,
      onToggle: () => undefined,
      ...props
    })
  ).replace(/<!-- -->/g, '')
}

/** The header's status text — what is on screen, not what a tooltip would say. */
function labelOf(html: string): string {
  const m = html.match(/<span class="text-ink-tertiary">([^<]*)<\/span>/)
  assert.ok(m, `no status span in ${html}`)
  return m![1]
}

/** The largest duration the header states, in ms — what a reader compares. */
function largestStatedMs(text: string): number {
  let max = 0
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s)\b/g)) {
    max = Math.max(max, Number(m[1]) * (m[2] === 's' ? 1000 : 1))
  }
  return max
}

describe('a cold run says what it is waiting on, while it waits', () => {
  test('the boot is named on screen for every second of it', () => {
    mock.timers.enable({ apis: ['setInterval', 'Date'] })
    try {
      // The only input is time passing: no chunk, no keystroke, no result.
      const frames: string[] = []
      const stop = startWaitClock((ms) => frames.push(header({ booting: true, waitedMs: ms })))
      for (let second = 0; second < 8; second++) mock.timers.tick(1_000)
      stop()

      assert.equal(frames.length, 8, 'one repaint per second of the boot')
      for (const [i, f] of frames.entries()) {
        const seen = labelOf(f)
        assert.match(seen, /Starting the Python sandbox/, `second ${i + 1} does not name the sandbox start: "${seen}"`)
        assert.match(seen, /one-time for this session/, `second ${i + 1} does not say the cost is one-time: "${seen}"`)
        assert.ok(!/running…/.test(seen), `second ${i + 1} claims Python is running before the runtime exists: "${seen}"`)
      }
      assert.match(labelOf(frames[0]), /· 1s/)
      assert.match(labelOf(frames[7]), /· 8s/, 'the wait is counted, so eight seconds does not look like one')
      assert.notEqual(frames[7], frames[0], 'the screen moves on its own during the boot')
      assert.match(frames[0], /data-run-state="booting"/)
    } finally {
      mock.timers.reset()
    }
  })

  test('the label is the turn’s own named-wait vocabulary, not a second one', () => {
    const seen = labelOf(header({ booting: true, waitedMs: 3_000 }))
    assert.ok(seen.includes(SANDBOX_BOOT_WAIT.label), seen)
    assert.ok(seen.includes(SANDBOX_BOOT_WAIT.detail), seen)
  })

  test('a warm run is not told a boot is happening', () => {
    const f = header({ booting: false, waitedMs: 3_000 })
    assert.ok(!/sandbox/i.test(labelOf(f)), 'a warm run must not claim a runtime start')
    assert.match(labelOf(f), /running…/)
    assert.match(f, /data-run-state="running"/)
  })
})

describe('the reported time never ranks a cold call above a warm one', () => {
  test('TTU2: 8.6 s + 6 ms must not read as faster than 20 ms', () => {
    const cold = ran(COLD_RUN_MS, BOOT_MS)
    const warm = ran(WARM_RUN_MS)
    const coldText = describeRun(cold)
    const warmText = describeRun(warm)

    // The inversion itself, asserted before anything else: whatever the header
    // says, the slower call must not state the smaller figure.
    assert.ok(
      largestStatedMs(coldText) > largestStatedMs(warmText),
      `the cold header "${coldText}" still reads as faster than the warm one "${warmText}"`
    )
    assert.ok(
      totalWaitMs(cold)! > totalWaitMs(warm)!,
      `total wait: cold ${totalWaitMs(cold)} ms vs warm ${totalWaitMs(warm)} ms`
    )

    assert.equal(coldText, 'started the sandbox in 8.6 s, then ran in 6 ms')
    assert.equal(warmText, 'ran in 20 ms', 'the warm header is untouched')
    assert.equal(cold.bootMs, BOOT_MS, 'the boot survives the trip through the result text')
    assert.equal(warm.bootMs, null, 'a warm run reports no boot')
    assert.equal(cold.durationMs, COLD_RUN_MS)
    assert.equal(totalWaitMs(cold), BOOT_MS + COLD_RUN_MS)
    assert.equal(totalWaitMs(warm), WARM_RUN_MS)
  })

  test('the rendered header carries both figures, and its tooltip the total', () => {
    const cold = ran(COLD_RUN_MS, BOOT_MS)
    const f = header({ status: 'done', parsed: cold, booting: false })
    assert.equal(labelOf(f), 'started the sandbox in 8.6 s, then ran in 6 ms')
    assert.match(explainRun(cold), /^8\.6 s in all/)
    assert.match(explainRun(cold), /one-time cost this run happened to be first to pay/)
    assert.match(explainRun(ran(WARM_RUN_MS)), /^Python the model wrote/)
  })

  test('a cold run that fails still reports what it paid to fail', () => {
    const text = formatRun({ ...primes, ok: false, durationMs: 3, bootMs: BOOT_MS, error: 'ZeroDivisionError: division by zero' }, 'x = 1/0').error!
    const p = parseRanCode(text, false)
    assert.equal(p.bootMs, BOOT_MS)
    assert.equal(describeRun(p), 'started the sandbox in 8.6 s, then failed after 3 ms')
    assert.ok(!p.notes.some((n) => /sandbox started/.test(n)), 'the boot is a figure, not small print')
  })

  test('the model is told the cost is one-time, so it cannot read it as this code being slow', () => {
    const out = formatRun({ ...primes, durationMs: COLD_RUN_MS, bootMs: BOOT_MS }, 'print(1)').output!
    assert.match(out, /The sandbox started for this run: 8609 ms \(one-time; later runs in this conversation skip it\)\./)
    assert.match(out, /Python ran in 6 ms\./)
    assert.ok(!formatRun({ ...primes, durationMs: WARM_RUN_MS }, 'print(1)').output!.includes('The sandbox started'))
  })
})
