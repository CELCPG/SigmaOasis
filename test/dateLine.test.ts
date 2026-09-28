import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './harness'
import { buildGroundingBlock, localDateLine } from '../src/renderer/src/lib/grounding'

/**
 * v3.0: the day a model is told it is.
 *
 * Measured on qwen3.8-9b on 2026-09-28, a Monday: asked the date or the time,
 * it answered "Sunday" three times out of three and "Tuesday" once — including
 * straight after get_current_datetime had read the clock, because neither the
 * tool nor the system prompt said which weekday it was and the model worked it
 * out for itself. And the prompt's date was the UTC date, which from 8 PM on
 * the US east coast is already tomorrow.
 */

describe('the date line in the system prompt', () => {
  test('is the local calendar day with its weekday', () => {
    assert.equal(localDateLine(new Date(2026, 8, 28, 12, 0)), '2026-09-28 (Monday)')
    assert.equal(localDateLine(new Date(2026, 0, 1, 9, 0)), '2026-01-01 (Thursday)')
  })

  test('late in the evening it is still today, whatever the UTC date is', () => {
    // 23:30 local is the next day in UTC anywhere west of Greenwich.
    assert.match(localDateLine(new Date(2026, 8, 28, 23, 30)), /^2026-09-28 \(Monday\)$/)
  })

  test('rides the grounding block', () => {
    assert.match(buildGroundingBlock(new Date(2026, 8, 28, 21, 0)), /Today's date is 2026-09-28 \(Monday\)\./)
  })
})

describe('get_current_datetime', () => {
  const { calculatorHandlers } = load<typeof import('../src/main/ipc/toolHandlers/calculators')>('toolHandlers/calculators')

  test('names the weekday and the zone, so nothing is left for the model to compute', async () => {
    const r = await calculatorHandlers.get_current_datetime({}, { sender: {} as never })
    assert.ok(r.ok)
    const weekday = new Date().toLocaleDateString('en-US', { weekday: 'long' })
    assert.ok(r.output?.startsWith(weekday), `leads with the weekday: ${r.output}`)
    assert.match(r.output ?? '', /\(ISO: \d{4}-\d{2}-\d{2}T/)
  })
})
