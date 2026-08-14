import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  daysBetween,
  isoDate,
  longDate,
  resolveDateExpression,
  runDateCalculation
} from '../src/main/ipc/dates'

/**
 * Every case here is a date the app actually got wrong.
 *
 * Friday 14 August 2026 is the anchor because that is the day the golf-trip
 * session ran: asked for "next sat and sunday" it produced August 24 (a
 * Monday) in one step and August 14 — that same Friday — in the answer, having
 * web-searched for a day of the week rather than calling the clock tool that
 * was on the turn.
 */
const FRIDAY = new Date(2026, 7, 14, 12, 0, 0) // 2026-08-14, a Friday
const resolve = (expr: string, from = FRIDAY): string | null => {
  const r = resolveDateExpression(expr, from)
  return r ? isoDate(r.date) : null
}

describe('resolveDateExpression · the measured failures', () => {
  test('"next saturday" is the Saturday of next week, not tomorrow', () => {
    // The trip was for "next sat and sunday". 22nd/23rd, not the 15th and not
    // the 24th (a Monday, which one step actually produced).
    assert.equal(resolve('next saturday'), '2026-08-22')
    assert.equal(resolve('next sunday'), '2026-08-23')
  })

  test('"this saturday" is the coming one', () => {
    assert.equal(resolve('this saturday'), '2026-08-15')
  })

  test('both readings are reported, because English means both', () => {
    const r = resolveDateExpression('next saturday', FRIDAY)
    assert.ok(r?.ambiguity, 'expected the alternative reading to be stated')
    assert.match(r!.ambiguity!, /2026-08-15/)
  })

  test('October 1st 2026 is a Thursday — the six-step-plan question', () => {
    assert.equal(resolve('october 1 2026'), '2026-10-01')
    assert.equal(resolve('october 1st, 2026'), '2026-10-01')
    assert.equal(resolve('2026-10-01'), '2026-10-01')
    assert.equal(resolve('1 october 2026'), '2026-10-01')
    const r = resolveDateExpression('2026-10-01', FRIDAY)!
    assert.match(longDate(r.date), /^Thursday, 1 October 2026$/)
  })

  test('"tomorrow" resolves — the route session never did', () => {
    assert.equal(resolve('tomorrow'), '2026-08-15')
    assert.equal(resolve('today'), '2026-08-14')
    assert.equal(resolve('yesterday'), '2026-08-13')
  })
})

describe('resolveDateExpression · spans and relatives', () => {
  test('counted offsets in both directions', () => {
    assert.equal(resolve('in 3 days'), '2026-08-17')
    assert.equal(resolve('in 2 weeks'), '2026-08-28')
    assert.equal(resolve('3 days ago'), '2026-08-11')
    assert.equal(resolve('1 month'), '2026-09-14')
  })

  test('a weekend is a span, not a day', () => {
    const r = resolveDateExpression('this weekend', FRIDAY)!
    assert.equal(isoDate(r.date), '2026-08-15')
    assert.equal(isoDate(r.until!), '2026-08-16')
  })

  test('"last friday" goes back a week when today is Friday', () => {
    // Not today. "Last Friday" said on a Friday means the previous one.
    assert.equal(resolve('last friday'), '2026-08-07')
  })

  test('a bare weekday resolves forwards', () => {
    assert.equal(resolve('monday'), '2026-08-17')
  })
})

describe('resolveDateExpression · refusals', () => {
  test('nonsense is refused rather than guessed', () => {
    assert.equal(resolve('sometime soonish'), null)
    assert.equal(resolve(''), null)
  })

  test('an impossible date is refused, not rolled into the next month', () => {
    // new Date(2026, 1, 31) silently becomes 3 March. That is how a booking
    // ends up on a day nobody chose.
    assert.equal(resolve('2026-02-31'), null)
    assert.equal(resolve('february 30 2026'), null)
  })

  test('a leap day is fine in a leap year and refused otherwise', () => {
    assert.equal(resolve('2028-02-29'), '2028-02-29')
    assert.equal(resolve('2026-02-29'), null)
  })
})

describe('daysBetween', () => {
  test('counts whole days regardless of clock time', () => {
    assert.equal(daysBetween(new Date(2026, 7, 14, 23, 59), new Date(2026, 7, 15, 0, 1)), 1)
  })

  test('survives a DST boundary', () => {
    // US DST ends 1 November 2026. Anchoring at midnight makes this 6 or 8.
    assert.equal(daysBetween(new Date(2026, 9, 29, 12), new Date(2026, 10, 5, 12)), 7)
  })

  test('is signed', () => {
    assert.equal(daysBetween(new Date(2026, 7, 20, 12), new Date(2026, 7, 14, 12)), -6)
  })
})

describe('runDateCalculation', () => {
  test('no expression answers "what is today"', () => {
    const out = runDateCalculation({ operation: 'resolve' }, FRIDAY)
    assert.ok(out.ok)
    assert.match(out.output!, /Friday, 14 August 2026/)
  })

  test('the output carries the weekday, the ISO form and the distance', () => {
    const out = runDateCalculation({ operation: 'resolve', expression: 'next saturday' }, FRIDAY)
    assert.match(out.output!, /Saturday, 22 August 2026/)
    assert.match(out.output!, /ISO: 2026-08-22/)
    assert.match(out.output!, /in 8 day\(s\)/)
    assert.match(out.output!, /Weekend: yes/)
  })

  test('an unreadable expression fails with the forms it does understand', () => {
    const out = runDateCalculation({ operation: 'resolve', expression: 'whenever' }, FRIDAY)
    assert.equal(out.ok, false)
    assert.match(out.error!, /next Saturday/)
    assert.match(out.error!, /Ask the user rather than guessing/)
  })

  test('difference spans two phrases', () => {
    const out = runDateCalculation(
      { operation: 'difference', from: 'today', to: '2026-10-01' },
      FRIDAY
    )
    assert.ok(out.ok, out.error)
    assert.match(out.output!, /48 day\(s\)/)
    assert.match(out.output!, /forwards/)
  })

  test('relative_to re-anchors "tomorrow" to a stated day', () => {
    const out = runDateCalculation(
      { operation: 'resolve', expression: 'tomorrow', relative_to: '2026-12-31' },
      FRIDAY
    )
    assert.match(out.output!, /ISO: 2027-01-01/)
  })

  test('an unknown operation says which ones exist', () => {
    const out = runDateCalculation({ operation: 'interpolate' }, FRIDAY)
    assert.equal(out.ok, false)
    assert.match(out.error!, /"resolve" or "difference"/)
  })
})
