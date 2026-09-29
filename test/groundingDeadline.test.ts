import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { checkToolGrounding, undisclosedToolRuns } from '../src/renderer/src/lib/toolGrounding'
import type { ToolCallRecord } from '../src/renderer/src/types'

/**
 * v4.0.1: the grounding pass returns.
 *
 * Measured on the first live reply to carry a table. Asked for the weather,
 * a 35B fetched AccuWeather's hourly page and answered with eight rows under
 * `|------|------|------------|------|----------|`. The reply was complete;
 * the window then sat at 100% CPU until it was killed, twice, and saved
 * nothing. The heading pattern three checks share tried every way of
 * splitting that row between its repeats — 2^n of them — before giving the
 * line up.
 *
 * A pattern that backtracks cannot be interrupted from inside the process it
 * runs in, so a test that calls it directly does not fail on a regression: it
 * never finishes. Each case below runs in a child under a deadline instead.
 */

/** The reply as the model wrote it. */
const WEATHER_REPLY = [
  "Here's the weather for **Richmond, VA** today (Tuesday, September 29, 2026):",
  '',
  '| Time | Temp | Conditions | Wind | Humidity |',
  '|------|------|------------|------|----------|',
  '| 8 AM | 64° | Cloudy | N 5 mph | 86% |',
  '| 4 PM | 76° | Partly sunny | N 5 mph | 60% |',
  '',
  '**Key details:**',
  '- **High:** ~76 °F / **Low:** ~63 °F'
].join('\n')

const rec = (name: string, result: string): ToolCallRecord => ({ id: name, name, args: {}, status: 'done', result })

const DEADLINE_MS = 5000

/** Run the whole pass on `reply` in a child process; null when it did not come back. */
function passIn(reply: string): number | null {
  const script =
    `const g = require(${JSON.stringify(join(__dirname, '..', 'src', 'renderer', 'src', 'lib', 'toolGrounding.js'))});` +
    `const t = Date.now();` +
    `g.checkToolGrounding(${JSON.stringify(reply)}, [{ id: 'a', name: 'fetch_webpage', args: {}, status: 'done', result: 'Page: x\\nURL: https://example.com/\\n\\n64° Cloudy' }], 'weather today');` +
    `process.stdout.write(String(Date.now() - t))`
  const out = spawnSync(process.execPath, ['-e', script], { timeout: DEADLINE_MS, encoding: 'utf8' })
  if (out.error || out.status !== 0) return null
  return Number(out.stdout)
}

describe('the grounding pass returns (v4.0.1)', () => {
  test('on the reply that held the window: a table under a separator row', () => {
    const ms = passIn(WEATHER_REPLY)
    assert.notEqual(ms, null, `the pass did not return in ${DEADLINE_MS} ms`)
    assert.ok(ms! < 1000, `the pass took ${ms} ms`)
  })

  const furniture: Record<string, string> = {
    'a wide separator row': `|${'------|'.repeat(14)}`,
    'an aligned separator row': `${'| :--- | ---: | :---: '.repeat(8)}|`,
    'a horizontal rule': '-'.repeat(120),
    'a run of emphasis': '*_'.repeat(60),
    'a run of quote marks': '> '.repeat(80),
    'a run of heading marks': '#'.repeat(120)
  }
  for (const [name, line] of Object.entries(furniture)) {
    test(`and on ${name}`, () => {
      const ms = passIn(`Some text.\n\n${line}\n\nMore text.`)
      assert.notEqual(ms, null, `the pass did not return in ${DEADLINE_MS} ms`)
      assert.ok(ms! < 1000, `the pass took ${ms} ms`)
    })
  }

  test('the heading it looks for is still every heading it found before', () => {
    const ran = [rec('reference_lookup', 'passages')]
    for (const heading of ['Tools used:', '**Tools I used**', '### Tools called', '> - **tools we ran**', '| Tools used |', '  __tool used:__']) {
      assert.deepEqual(undisclosedToolRuns(`An answer.\n\n${heading}\n\n| Document |\n|---|\n| FDA checklist |`, ran), ['reference_lookup'], heading)
    }
    // …and a sentence that merely contains the words is still not one.
    assert.deepEqual(undisclosedToolRuns('The tools used were mentioned above.', ran), [])
    assert.deepEqual(undisclosedToolRuns('Stools used in the workshop.', ran), [])
  })

  test('the pass still reports on a reply with a table in it', () => {
    const report = checkToolGrounding(`${WEATHER_REPLY}\n\nSee https://invented.example/richmond for more.`, [rec('fetch_webpage', 'Page: x\nURL: https://example.com/\n\n64° Cloudy')], 'weather today')
    assert.deepEqual(report?.links, ['https://invented.example/richmond'])
  })
})
