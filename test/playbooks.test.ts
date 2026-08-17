import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { PLAYBOOKS, buildPlaybookContext, selectPlaybook } from '../src/renderer/src/lib/playbooks'
import { referenceDomains } from '../src/renderer/src/lib/grounding'

/**
 * v1.5 playbooks: which method a turn gets, and what the model is told. The
 * texts themselves are product copy reviewed like code; these pin the
 * selection rules and the shape a small model relies on (short, numbered).
 */
describe('playbook catalogue shape', () => {
  test('every playbook is short and numbered-ready', () => {
    for (const p of Object.values(PLAYBOOKS)) {
      assert.ok(p.steps.length >= 3 && p.steps.length <= 5, `${p.id}: ${p.steps.length} steps`)
      const words = p.steps.join(' ').split(/\s+/).length
      assert.ok(words <= 130, `${p.id}: ${words} words — small models tune out essays`)
      assert.ok(p.name.length <= 32, `${p.id}: name too long for the strip`)
    }
  })
  test('the block frames the method and numbers the steps', () => {
    const block = buildPlaybookContext(PLAYBOOKS['first-aid'])
    assert.match(block, /"First aid" playbook/)
    assert.match(block, /\n1\. If anything suggests a life-threatening emergency/)
    assert.match(block, /\n4\. End with when to seek professional care/)
  })
})

describe('referenceDomains', () => {
  test('orders by consequence and can return several', () => {
    assert.deepEqual(referenceDomains('my landlord says the mold in the bathroom is my problem'), ['home', 'legal'])
    assert.deepEqual(referenceDomains('he was bitten by a snake and now has a rash'), ['first-aid', 'health'])
    assert.deepEqual(referenceDomains('write a poem about burns'), [])
    assert.deepEqual(referenceDomains('hi'), [])
  })
})

describe('selectPlaybook', () => {
  const pick = (text: string, attachmentNames?: string[]): string | null =>
    selectPlaybook({ text, attachmentNames })?.id ?? null

  test('reference domains, most consequential first', () => {
    assert.equal(pick('I just burned my hand on a pan, what should I do?'), 'first-aid')
    assert.equal(pick('can I take ibuprofen with my blood pressure medications'), 'health')
    assert.equal(pick('is this wall load-bearing, the joists run the other way'), 'building')
    assert.equal(pick('a hurricane is coming, what should I do first'), 'preparedness')
    assert.equal(pick('how long can cooked rice stay in the fridge'), 'food')
    assert.equal(pick('the faucet under my sink is leaking'), 'home')
    assert.equal(pick('should I put money in a roth ira this year'), 'finance')
    assert.equal(pick('my landlord wants to keep the deposit, what are my rights'), 'legal')
    // Two domains: the injury wins over the symptom.
    assert.equal(pick('she was bitten and now has a fever'), 'first-aid')
  })

  test('a bare "what does the manual say" gets the library, not a method', () => {
    assert.equal(pick('what does the manual say about the reset button?'), null)
  })

  test('data, code, comparison and planning', () => {
    assert.equal(pick('what is the average order value per month in this'), 'data-analysis')
    assert.equal(pick('what do you make of this file', ['sales.csv']), 'data-analysis')
    assert.equal(pick('here is the stack trace, why does it crash\nTraceback (most recent call last)'), 'coding')
    assert.equal(pick('write me a function that parses ISO dates'), 'coding')
    assert.equal(pick('which is better for a small apartment, a heat pump or baseboard heaters'), 'compare')
    assert.equal(pick('plan my week so I finish the report by Friday'), 'planning')
  })

  test('chat and creative turns get nothing', () => {
    assert.equal(pick('thanks, that was helpful'), null)
    assert.equal(pick('write a poem about the sea'), null)
    assert.equal(pick('tell me a joke'), null)
    assert.equal(pick('what album did Radiohead release in 2007'), null)
  })

  test('a reference domain beats a data or code signal in the same message', () => {
    assert.equal(pick('analyze this data: my medications and their side effects', ['meds.csv']), 'health')
  })
})

describe('data-analysis playbook · sessions (v1.8.1)', () => {
  test('tells the model run_python state persists and to check the session variables first', () => {
    const steps = PLAYBOOKS['data-analysis'].steps.join('\n')
    assert.match(steps, /keeps its variables between calls/)
    assert.match(steps, /Session variables/)
    // The wording the eval's stateless arm strips must be recognizable.
    assert.equal(PLAYBOOKS['data-analysis'].steps.filter((s) => /keeps its variables/.test(s)).length, 1)
  })
})
