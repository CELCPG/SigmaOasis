import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { combineSessions, controlOrderFrom, readSession, sessionId, sidesForPass } from '../src/main/agent/evalSession'
import { agentResultsFile } from '../src/main/agent/evalHarness'

/**
 * v4.4 (G1): the same-day control — how a run says which session it was
 * measured in and which side it was, and how the sides are ordered.
 */

describe('the same-day control: order and tags (v4.4, G1)', () => {
  test('EVAL_CONTROL: unset or 0 is no control; 1 and control-first start with the control; arm-first with the arm; anything else is refused', () => {
    assert.equal(controlOrderFrom(undefined), null)
    assert.equal(controlOrderFrom(''), null)
    assert.equal(controlOrderFrom('0'), null)
    assert.equal(controlOrderFrom('1'), 'control-first')
    assert.equal(controlOrderFrom('Control-First'), 'control-first')
    assert.equal(controlOrderFrom('arm-first'), 'arm-first')
    assert.throws(() => controlOrderFrom('yes'), /EVAL_CONTROL is 1, control-first or arm-first/)
  })

  test('the sides alternate pass by pass, ABBA, so neither always runs second', () => {
    assert.deepEqual([0, 1, 2, 3].map((p) => sidesForPass(p, 'control-first')), [
      ['control', 'arm'],
      ['arm', 'control'],
      ['control', 'arm'],
      ['arm', 'control']
    ])
    assert.deepEqual(sidesForPass(0, 'arm-first'), ['arm', 'control'])
    assert.deepEqual(sidesForPass(1, 'arm-first'), ['control', 'arm'])
  })

  test("a session id is the environment's when given, else the run's stamp; a bad one is refused", () => {
    assert.equal(sessionId(undefined, '2026-10-01T22-00-00'), '2026-10-01T22-00-00')
    assert.equal(sessionId('  ', 'stamp'), 'stamp')
    assert.equal(sessionId('4.4-night_g3', 'stamp'), '4.4-night_g3')
    assert.throws(() => sessionId('two words', 'stamp'), /EVAL_SESSION/)
    assert.throws(() => sessionId('x'.repeat(81), 'stamp'), /EVAL_SESSION/)
  })

  test("the agent results file carries the session only when there is one — an untagged run's file is 4.3's schema", () => {
    const base = { model: 'm', experiments: {}, baseUrl: 'u', shell: 'sh', startedAt: 's', passes: 1, cases: [], runs: [] }
    assert.equal('session' in agentResultsFile(base), false)
    assert.deepEqual(agentResultsFile({ ...base, session: { id: 'night', role: 'control' } }).session, { id: 'night', role: 'control' })
  })

  test("a file's sessions read back as ids and a role, from a runner's file or a merged one; anything else is untagged", () => {
    assert.deepEqual(readSession({ session: { id: 'a', role: 'arm' } }), { ids: ['a'], role: 'arm' })
    assert.deepEqual(readSession({ session: { ids: ['b', 'a', 'b'], role: 'control' } }), { ids: ['a', 'b'], role: 'control' })
    assert.equal(readSession({}), null)
    assert.equal(readSession({ session: { id: 'a', role: 'both' } }), null)
    assert.equal(readSession({ session: { ids: [], role: 'arm' } }), null)
  })

  test('combining files keeps one role and every id; an untagged part leaves the whole untagged; a control never joins its arm', () => {
    const label = (i: number): string => `f${i}`
    const c = (id: string) => ({ session: { id, role: 'control' } })
    assert.deepEqual(combineSessions([c('a'), c('b'), c('a')], label), { ids: ['a', 'b'], role: 'control' })
    assert.equal(combineSessions([c('a'), {}], label), null)
    assert.throws(() => combineSessions([c('a'), { session: { id: 'a', role: 'arm' } }], label), /f1 \(the session's arm\).*stay apart/)
  })
})
