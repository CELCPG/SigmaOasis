import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { projectInstructionsBlock, slotRulesBlock } from '../src/renderer/src/lib/projectContext'
import { withGrounding } from '../src/renderer/src/lib/grounding'

/**
 * v2.7: persona and rules as two fields. The rules ride the system prompt
 * right after the persona and before a project's instructions — three stable
 * layers in the cached prefix — and the grounding block still comes last.
 */

describe('slot standing rules', () => {
  test('absent or blank rules add nothing', () => {
    assert.equal(slotRulesBlock(undefined), '')
    assert.equal(slotRulesBlock({}), '')
    assert.equal(slotRulesBlock({ rules: '   \n' }), '')
  })

  test('rules become a block that names itself and asks to be followed every turn', () => {
    const block = slotRulesBlock({ rules: 'Never guess a price; search.' })
    assert.match(block, /^\n\nStanding rules for this role — follow them on every turn:\nNever guess a price; search\.$/)
  })

  test('the three layers keep their order: persona, rules, project, then grounding', () => {
    const persona = 'You are a careful assistant.'
    const rules = slotRulesBlock({ rules: 'Give figures with their source.' })
    const project = projectInstructionsBlock({ id: 'p', name: 'Kitchen', instructions: 'Metric units.', files: [], recall: false } as never)
    const prompt = withGrounding(persona + rules + project, new Date('2026-09-03T00:00:00Z'), { offline: false })
    const i = (s: string): number => prompt.indexOf(s)
    assert.ok(i(persona) === 0)
    assert.ok(i('Standing rules for this role') > i(persona))
    assert.ok(i('Standing instructions for every chat in this project') > i('Standing rules for this role'))
    assert.ok(i("Today's date is") > i('Standing instructions for every chat in this project'))
  })
})
