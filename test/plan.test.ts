import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { load, resetState, state } from './harness'

const plan = load<typeof import('../src/main/ipc/plan')>('plan')

const { generatePlan } = plan

const TWO_STEPS = JSON.stringify({
  steps: [
    { title: 'Find flights', detail: 'Search for round-trip flights under $900.' },
    { title: 'Draft itinerary', detail: 'Use the flight options to draft a 3-day itinerary.' }
  ]
})

beforeEach(() => {
  resetState()
})

describe('generatePlan (v0.9 plan mode)', () => {
  test('a clean JSON plan is parsed into steps', async () => {
    state.completions.push(TWO_STEPS)
    const steps = await generatePlan('Plan a weekend in Paris', 'fake-chat', 6)
    assert.equal(steps?.length, 2)
    assert.equal(steps?.[0]?.title, 'Find flights')
  })

  test('the planner prompt demands self-contained, checkable steps', async () => {
    state.completions.push(TWO_STEPS)
    await generatePlan('Plan a weekend in Paris', 'fake-chat', 6)
    const prompt = state.completionPrompts[0] ?? ''
    assert.match(prompt, /self-contained/)
    assert.match(prompt, /at most 6/)
  })

  test('prose-wrapped JSON still parses (small models ignore "JSON only")', async () => {
    state.completions.push(`Here is the plan you asked for:\n\`\`\`json\n${TWO_STEPS}\n\`\`\`\nHope this helps!`)
    const steps = await generatePlan('Plan a weekend in Paris', 'fake-chat', 6)
    assert.equal(steps?.length, 2)
  })

  test('a server without structured output gets a retry without the schema', async () => {
    state.completionOnce400 = true
    state.completions.push(TWO_STEPS)
    const steps = await generatePlan('Plan a weekend in Paris', 'fake-chat', 6)
    assert.equal(steps?.length, 2)
    // First request carried the schema constraint; the retry must not.
    const first = state.completionBodies[0] ?? {}
    const retry = state.completionBodies[1] ?? {}
    assert.ok('response_format' in first)
    assert.ok(!('response_format' in retry) || JSON.stringify(retry.response_format).includes('json_object'))
  })

  test('garbage output returns null — the caller falls back to answering directly', async () => {
    state.completions.push('I cannot help with that, sorry!')
    const steps = await generatePlan('Plan a weekend in Paris', 'fake-chat', 6)
    assert.equal(steps, null)
  })

  test('maxSteps caps whatever the model returned', async () => {
    state.completions.push(
      JSON.stringify({
        steps: [
          { title: 'One', detail: 'First.' },
          { title: 'Two', detail: 'Second.' },
          { title: 'Three', detail: 'Third.' }
        ]
      })
    )
    const steps = await generatePlan('Multi-part task', 'fake-chat', 2)
    assert.equal(steps?.length, 2)
  })

  test('steps missing a title or detail are dropped; all-dropped means null', async () => {
    state.completions.push(
      JSON.stringify({ steps: [{ title: '', detail: 'no title' }, { detail: 42 }] })
    )
    const steps = await generatePlan('Anything', 'fake-chat', 6)
    assert.equal(steps, null)
  })
})
