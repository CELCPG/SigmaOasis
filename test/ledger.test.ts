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

  test('a later fact with the same label supersedes; errored and running tools establish no facts', () => {
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
    assert.equal(describeLedger(l), '📒 Ledger as this turn began: 1 computed fact, 1 file, 1 constraint, 1 session variable from 4 turns')
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

/**
 * Round 12, task TTU2, both arms, twice over: the disclosure line under a
 * reply counted one session variable fewer than the `run_python` block a few
 * lines above it named. The fixtures below are those two runs' own strings.
 *
 * Neither number was arithmetic. The line is built by `ledgerProvider` from
 * every message EXCEPT the reply being written — it has to be, because its
 * job is to be handed to the model before the model answers — and it is then
 * printed at the bottom of that same reply, under the run whose output made
 * the list longer. The two count different moments, so the line says which
 * moment it counts.
 */
describe('the disclosure and the session list it is read beside (round 12, TTU2)', () => {
  /** .h2h-runs/B12/TTU2-20260828-151045 — turn 1's run, verbatim. */
  const B12_TURN1 = `Python ran in 7 ms.

stdout:
First 500 prime numbers:
  First prime:  2
  Last prime:   3571
  Sum of first 500 primes: 824693

Session variables (persist in this conversation): generate_primes, prime_sum, primes.`
  /** The same run's turn 2: the app-initiated check, which raised. */
  const B12_TURN2_FAILED = `The code failed.

Traceback (most recent call last):
  File "<exec>", line 13, in <module>
TypeError: 'float' object cannot be interpreted as an integer

Session variables (persist in this conversation): generate_primes, is_prime, prime_sum, primes.`

  /** .h2h-runs/A12/TTU2-20260828-155621 — turn 1, then turn 2's check run. */
  const A12_TURN1 = `Python ran in 29 ms.

stdout:
Found 1229 prime numbers up to 9973.
The first 500 primes: [2, 3, 5, 7, 11]...[9967, 9973]

Sum of the first 500 prime numbers:
5,736,396

Session variables (persist in this conversation): is_prime, primes.`
  const A12_TURN2 = `Python ran in 138 ms.

stdout:
Total primes found: 1229
First prime: 2, 500th prime: 3571

Sum of the first 500 prime numbers:
824,693

Session variables (persist in this conversation): is_prime, primes, total.`

  /** The conversation as the provider sees it: everything but the in-flight reply. */
  const before = (turn1: string, turn2Q: string): ChatMessage[] => [
    user('Run this in Python and show me the output: the sum of the first 500 prime numbers.'),
    assistant('The sum of the first 500 prime numbers is 824,693.', [rec('run_python', turn1)]),
    user(turn2Q)
  ]

  test('B12: the ledger holds turn 1’s three names — the fourth is one this reply defined', () => {
    const l = buildLedger(before(B12_TURN1, 'Now sum the first 500 of them.'))
    assert.deepEqual(l.sessionVars, ['generate_primes', 'prime_sum', 'primes'])
    assert.deepEqual(sessionVarsFrom(B12_TURN2_FAILED), ['generate_primes', 'is_prime', 'prime_sum', 'primes'])
    // The name the two lists differ by is `is_prime` — the middle of a sorted
    // list of four. No fencepost, no cap, no slice reaches only that one.
    assert.deepEqual(
      sessionVarsFrom(B12_TURN2_FAILED)!.filter((v) => !l.sessionVars.includes(v)),
      ['is_prime']
    )
  })

  test('A12: three named above, two in the ledger, and the difference is this reply’s own `total`', () => {
    const l = buildLedger(before(A12_TURN1, 'Run this in Python and show me the output: the sum of the first 500 prime numbers.'))
    assert.deepEqual(l.sessionVars, ['is_prime', 'primes'])
    assert.deepEqual(
      sessionVarsFrom(A12_TURN2)!.filter((v) => !l.sessionVars.includes(v)),
      ['total']
    )
  })

  test('so the line names the moment it counts, in both arms', () => {
    const b12 = describeLedger(buildLedger(before(B12_TURN1, 'Now sum the first 500 of them.')))
    const a12 = describeLedger(buildLedger(before(A12_TURN1, 'Run it again please.')))
    assert.equal(b12, '📒 Ledger as this turn began: 3 computed facts, 3 session variables from 2 turns')
    assert.equal(a12, '📒 Ledger as this turn began: 2 session variables from 2 turns')
    // The shipped line, which read as a count of the state on screen.
    assert.doesNotMatch(b12, /^📒 Ledger: /)
    assert.doesNotMatch(a12, /^📒 Ledger: /)
  })

  test('the moment is named even when nothing this turn changed the session', () => {
    const l = buildLedger(before(A12_TURN1, 'And what was the largest one?'))
    assert.match(describeLedger(l), /^📒 Ledger as this turn began: /)
  })

  /**
   * The second exclusion, found in B12's own turn: both of its runs raised,
   * so `status` was 'error' and the ledger read neither — while the sandbox
   * had kept `is_prime`, and said so on the error path, because a session
   * keeps its globals through an exception. The session list is the sandbox
   * reporting what it holds, not a figure the run computed, so it is read
   * whether the run finished or raised. Facts stay gated on a finished run.
   */
  test('a run that raised still reports the session it left behind', () => {
    const l = buildLedger([
      user('Run this in Python and show me the output: the sum of the first 500 prime numbers.'),
      assistant('done', [rec('run_python', B12_TURN1)]),
      user('Now sum the first 500 of them.'),
      assistant('The sum is 824,693.', [rec('run_python', B12_TURN2_FAILED, 'error')]),
      user('And the largest?')
    ])
    assert.deepEqual(l.sessionVars, ['generate_primes', 'is_prime', 'prime_sum', 'primes'])
    assert.match(describeLedger(l), /4 session variables from 3 turns/)
  })

  test('but a failed run establishes no facts', () => {
    const l = buildLedger([
      user('q1'),
      assistant('', [rec('run_python', 'total: 139306.12\nSession variables (persist in this conversation): df.', 'error')]),
      user('q2')
    ])
    assert.deepEqual(l.facts, [])
    assert.deepEqual(l.sessionVars, ['df'])
  })

  test('a running call contributes nothing at all — there is no result yet', () => {
    const l = buildLedger([
      user('q1'),
      assistant('', [rec('run_python', '', 'running')]),
      user('q2')
    ])
    assert.deepEqual(l.sessionVars, [])
  })

  /**
   * The line summarises the block the app hands the model, and that block is
   * the only list of these entries there is. Every count in the line must be
   * the length of the list printed under its own heading — otherwise the line
   * is unreconcilable against the one thing it does describe.
   */
  test('every count in the line is the length of the list the block prints', () => {
    const l = buildLedger([
      user('budget is $500 max', [{ name: 'a.csv' }]),
      assistant('', [rec('run_python', 'total: 139306.12\nwest: 28.07%\nSession variables (persist in this conversation): df, total.')]),
      user("Let's use the median."),
      assistant('', [rec('finance_calculator', 'payment: 1436.05')]),
      user('q3'),
      assistant(''),
      user('q4')
    ])
    const line = describeLedger(l)
    const block = buildLedgerContext(l)
    const under = (heading: RegExp): number => {
      const lines = block.split('\n')
      const at = lines.findIndex((x) => heading.test(x))
      assert.ok(at >= 0, `block has no heading ${heading}`)
      let n = 0
      for (let i = at + 1; i < lines.length && lines[i].startsWith('- '); i++) n++
      return n
    }
    const counted = (noun: RegExp): number => {
      const m = new RegExp(`(\\d+) ${noun.source}`).exec(line)
      return m ? Number(m[1]) : 0
    }
    assert.equal(counted(/computed facts?/), under(/^Computed facts/))
    assert.equal(counted(/files?\b/), under(/^Files attached:/))
    assert.equal(counted(/constraints?/), under(/^Constraints the user stated:/))
    assert.equal(counted(/decisions?/), under(/^Decisions the user made/))
    const named = /Python session variables still defined: ([^.]+)\./.exec(block)
    assert.ok(named)
    assert.equal(counted(/session variables?/), named![1].split(', ').length)
  })
})
