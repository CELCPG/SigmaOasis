import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLedger,
  buildLedgerContext,
  constraintsFrom,
  decisionsFrom,
  describeLedger,
  factsFromToolOutput,
  LEDGER_MIN_TURNS,
  sessionVarsFrom,
  shouldInjectLedger
} from '../src/renderer/src/lib/ledger'
import type { ChatMessage, ToolCallRecord } from '../src/renderer/src/types'

/**
 * The conversation ledger (v1.9): mechanical, from tool results and the
 * user's own words only. These pin what is recorded, what is refused, when
 * it rides a turn, and that the block is stable text.
 */

const rec = (name: string, result: string, status: ToolCallRecord['status'] = 'done'): ToolCallRecord => ({
  id: `${name}-${Math.random()}`,
  name,
  args: {},
  result,
  status
})
const user = (content: string, attachments: { name: string }[] = []): ChatMessage =>
  ({ id: `u${Math.random()}`, role: 'user', content, attachments: attachments as never, createdAt: 0 }) as ChatMessage
const assistant = (content: string, toolCalls: ToolCallRecord[] = []): ChatMessage =>
  ({ id: `a${Math.random()}`, role: 'assistant', content, toolCalls, createdAt: 0 }) as ChatMessage

describe('factsFromToolOutput', () => {
  test('captures label: value lines with numbers, money, percents, dates', () => {
    const facts = factsFromToolOutput(
      'total revenue: 139306.12\nwest share: 28.07%\ntax: $2,347.12\nstart: 2025-03-01\nrows: 400\n',
      'run_python',
      2
    )
    assert.deepEqual(
      facts.map((f) => [f.label, f.value]),
      [['total revenue', '139306.12'], ['west share', '28.07%'], ['tax', '$2,347.12'], ['start', '2025-03-01'], ['rows', '400']]
    )
    assert.ok(facts.every((f) => f.turn === 2 && f.via === 'run_python'))
  })

  test('ignores prose, headers, harness noise and non-numeric values', () => {
    const facts = factsFromToolOutput(
      'Python ran in 120 ms\nstdout:\nSession variables (persist in this conversation): df, total.\nThe answer is that West leads.\nregion: West\nnote: something\n',
      'run_python',
      1
    )
    assert.deepEqual(facts, [])
  })

  test('the last value for a repeated label wins', () => {
    const facts = factsFromToolOutput('running total: 10\nrunning total: 25\nrunning total: 42', 'run_python', 3)
    assert.deepEqual(facts.map((f) => [f.label, f.value]), [['running total', '42']])
  })
})

describe('sessionVarsFrom', () => {
  test('parses the newest session variables list; null when absent', () => {
    assert.deepEqual(sessionVarsFrom('out\n\nSession variables (persist in this conversation): df, total, west.'), ['df', 'total', 'west'])
    assert.equal(sessionVarsFrom('no session line here'), null)
  })
})

describe('constraintsFrom', () => {
  test('captures short imperative constraints with a figure or a hard word, verbatim', () => {
    const c = constraintsFrom('My budget is $2,000 for the whole trip. We must be back by Friday. I have a nut allergy.', 1)
    assert.deepEqual(
      c.map((x) => x.text),
      ['My budget is $2,000 for the whole trip.', 'We must be back by Friday.', 'I have a nut allergy.']
    )
  })

  test('questions and ordinary chat are not constraints', () => {
    assert.deepEqual(constraintsFrom('What is the total revenue?', 1), [])
    assert.deepEqual(constraintsFrom('Thanks, that helps a lot.', 1), [])
    assert.deepEqual(constraintsFrom('Can you keep it under 200 words?', 1), [])
  })
})

describe('buildLedger', () => {
  test('derives facts from tool results only — never from assistant prose', () => {
    const l = buildLedger([
      user('total revenue please', [{ name: 'sales.csv' }]),
      assistant('The total is 999999.99 (from memory).', [rec('run_python', 'total revenue: 139306.12\nSession variables (persist in this conversation): df, total.')]),
      user('and west?'),
      assistant('West is 39103.24', [rec('run_python', 'west revenue: 39103.24')])
    ])
    assert.deepEqual(l.facts.map((f) => [f.label, f.value, f.turn]), [['total revenue', '139306.12', 1], ['west revenue', '39103.24', 2]])
    assert.deepEqual(l.files, [{ name: 'sales.csv', turn: 1 }])
    assert.deepEqual(l.sessionVars, ['df', 'total'])
    assert.equal(l.turns, 2)
    // The assistant's 999999.99 never appears anywhere in the ledger.
    assert.ok(!JSON.stringify(l).includes('999999'))
  })

  test('a later fact with the same label supersedes; errored and running tools contribute nothing', () => {
    const l = buildLedger([
      user('q1'),
      assistant('', [rec('run_python', 'total: 100')]),
      user('q2'),
      assistant('', [rec('run_python', 'total: 250'), rec('run_python', 'other: 7', 'error'), rec('run_python', 'pending: 1', 'running')])
    ])
    assert.deepEqual(l.facts.map((f) => [f.label, f.value, f.turn]), [['total', '250', 2]])
  })

  test('non-fact tools (web_search, memory) never contribute facts', () => {
    const l = buildLedger([user('q'), assistant('', [rec('web_search', 'price: $9.99\nrating: 4.5')])])
    assert.deepEqual(l.facts, [])
  })
})

describe('shouldInjectLedger / buildLedgerContext', () => {
  const longConvo = (n: number): ChatMessage[] => {
    const msgs: ChatMessage[] = []
    for (let i = 1; i <= n; i++) {
      msgs.push(user(`question ${i}`))
      msgs.push(assistant('', i === 1 ? [rec('run_python', 'total: 42')] : []))
    }
    return msgs
  }

  test('rides only from LEDGER_MIN_TURNS user turns and only when non-empty', () => {
    assert.equal(shouldInjectLedger(buildLedger(longConvo(LEDGER_MIN_TURNS - 1))), false)
    assert.equal(shouldInjectLedger(buildLedger(longConvo(LEDGER_MIN_TURNS))), true)
    const emptyLong: ChatMessage[] = []
    for (let i = 0; i < 6; i++) emptyLong.push(user('hi'), assistant('hello'))
    assert.equal(shouldInjectLedger(buildLedger(emptyLong)), false)
  })

  test('the block carries exact values with tool and turn, and the do-not-restate rule', () => {
    const l = buildLedger([
      user('budget is $500 max', [{ name: 'a.csv' }]),
      assistant('', [rec('run_python', 'total: 139306.12\nSession variables (persist in this conversation): df.')]),
      user('q2'), assistant(''), user('q3'), assistant(''), user('q4'), assistant('')
    ])
    const block = buildLedgerContext(l)
    assert.match(block, /Conversation ledger/)
    assert.match(block, /do not recompute or restate them from memory/)
    assert.match(block, /- total: 139306\.12 — run_python, turn 1/)
    assert.match(block, /- a\.csv \(turn 1; available at \/work\/a\.csv\)/)
    assert.match(block, /\(turn 1\) budget is \$500 max/)
    assert.match(block, /session variables still defined: df/)
    assert.equal(describeLedger(l), '📒 Ledger: 1 computed fact, 1 file, 1 constraint, 1 session variable from 4 turns')
  })

  test('the block is byte-stable for the same conversation', () => {
    const msgs = longConvo(5)
    assert.equal(buildLedgerContext(buildLedger(msgs)), buildLedgerContext(buildLedger(msgs)))
  })
})

describe('factsFromToolOutput · analyze_file profiles (v1.9)', () => {
  test('per-column stats become `<column> <stat>: <value>` facts', () => {
    const profile = [
      'Profile of /work/expenses.csv — delimited text (","-separated): 180 data row(s) × 3 column(s).',
      '',
      'Columns:',
      '- date: date · 180 non-null · from 2025-01-01 to 2025-06-28',
      '- category: text · 180 non-null · 5 distinct · top: "travel" ×45',
      '- amount: number · 180 non-null · min 14.41 · max 897.61 · mean 468.2479 · median 501.32 · sum 84,284.63',
      '',
      'First 5 row(s):'
    ].join('\n')
    const facts = factsFromToolOutput(profile, 'analyze_file', 1)
    assert.deepEqual(
      facts.map((f) => [f.label, f.value]),
      [['amount min', '14.41'], ['amount max', '897.61'], ['amount mean', '468.2479'], ['amount median', '501.32'], ['amount sum', '84,284.63']]
    )
    assert.ok(facts.every((f) => f.via === 'analyze_file'))
  })
  test('text and date columns contribute nothing; the profile header is not a fact', () => {
    const facts = factsFromToolOutput('- date: date · 180 non-null · from 2025-01-01 to 2025-06-28\n- category: text · 5 distinct', 'analyze_file', 1)
    assert.deepEqual(facts, [])
  })
  test('the measured case: a total read off the profile is in the ledger', () => {
    const l = buildLedger([
      user('total please', [{ name: 'expenses.csv' }]),
      assistant('total: 84,284.63', [rec('analyze_file', '- amount: number · 180 non-null · min 14.41 · max 897.61 · mean 468.2479 · median 501.32 · sum 84,284.63')])
    ])
    assert.ok(l.facts.some((f) => f.label === 'amount sum' && f.value === '84,284.63'))
  })
})

describe('shouldInjectLedger · session floor (v1.8.1)', () => {
  test('with session variables the ledger rides from the second user turn', () => {
    const l = buildLedger([
      user('load it', [{ name: 'sales.csv' }]),
      assistant('', [rec('run_python', 'total: 139306.12\nSession variables (persist in this conversation): df, total.')]),
      user('and west?')
    ])
    assert.equal(l.turns, 2)
    assert.equal(shouldInjectLedger(l), true)
    const block = buildLedgerContext(l)
    assert.match(block, /session variables still defined: df, total/)
    assert.match(block, /do not read the data file again unless a variable you need is missing/)
  })
  test('without session variables the ordinary floor still applies', () => {
    const l = buildLedger([user('q1'), assistant('', [rec('finance_calculator', 'payment: 1436.05')]), user('q2')])
    assert.equal(shouldInjectLedger(l), false)
  })
})

describe('decisions (v1.8.1)', () => {
  test('captures choices verbatim; requests and questions are not decisions', () => {
    const d = decisionsFrom("Let's use the median for this. Go with the West region cut. Can you compute the mean? Please show me option 2.", 3)
    assert.deepEqual(d.map((x) => x.text), ["Let's use the median for this.", 'Go with the West region cut.'])
  })
  test('a later decision on the same subject supersedes the earlier one', () => {
    const l = buildLedger([
      user('Use the median for the summary.'), assistant(''),
      user('unrelated'), assistant(''),
      user('Actually, use the mean for the summary instead.'), assistant('')
    ])
    assert.deepEqual(l.decisions.map((x) => [x.text, x.turn]), [['Actually, use the mean for the summary instead.', 3]])
  })
  test('decisions on different subjects both stand, in order', () => {
    const l = buildLedger([user('Use the median.'), assistant(''), user('Go with the West region.'), assistant('')])
    assert.deepEqual(l.decisions.map((x) => x.text), ['Use the median.', 'Go with the West region.'])
  })
  test('the block lists decisions with the latest-stands rule, and describeLedger counts them', () => {
    const l = buildLedger([
      user('Use the median.'), assistant('', [rec('run_python', 'x: 1')]),
      user('q2'), assistant(''), user('q3'), assistant(''), user('q4'), assistant('')
    ])
    const block = buildLedgerContext(l)
    assert.match(block, /Decisions the user made \(latest on a subject stands\):\n- \(turn 1\) Use the median\./)
    assert.match(describeLedger(l), /1 decision/)
  })
})
