import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRecomputeMessages,
  codeFailureFinding,
  describeCodeCheck,
  describeRecompute,
  extractPythonFence,
  figuresIn,
  isSelfContained,
  longestPythonFence,
  looksArithmetic
} from '../src/renderer/src/lib/workbenchChecks'
import { describeGroundingFindings, groundingFindingCount, revisionIsAnImprovement } from '../src/renderer/src/lib/toolGrounding'
import type { ModelConfig } from '../src/renderer/src/types'

/**
 * v1.6 Workbench verification hooks — when they fire, what they ask, and how
 * a failure becomes a finding the revision gate understands.
 */
describe('figuresIn / looksArithmetic', () => {
  test('real figures, not years or list indices', () => {
    assert.deepEqual(figuresIn('In 2025 the payment is $1,436.05 over 30 years at 6.5%: 3 items, 12500 total'), ['$1,436.05', '6.5', '12500'])
  })
  test('fires when the question gave inputs and the answer states a figure', () => {
    assert.equal(looksArithmetic('borrow 250000 at 6.5% for 30 years', 'The monthly payment is $1,580.17.'), true)
  })
  test('fires when the answer alone carries several figures', () => {
    assert.equal(looksArithmetic('what will it cost?', 'About $12.50 per unit, so $1,250.00 for 100 and $2,375.00 for 200.'), true)
  })
  test('does not fire on prose or a single mention', () => {
    assert.equal(looksArithmetic('tell me about the moon landing', 'Apollo 11 landed in 1969.'), false)
    assert.equal(looksArithmetic('how many legs does a spider have', 'Eight.'), false)
    assert.equal(looksArithmetic('what is the capital', 'Paris, population about 2.1 million.'), false)
  })
})

describe('recompute prompt', () => {
  test('asks for one program that prints label: value lines', () => {
    const slot: ModelConfig = { id: 'a', modelId: 'm', roleName: 'Assistant', systemPrompt: 'persona', color: 'blue', enabled: true, sampling: { temperature: 0.3, topP: 1, maxTokens: -1, seed: null, topK: -1, minP: -1 }, contextWindow: null }
    const m = buildRecomputeMessages(slot, 'q', 'a')
    assert.deepEqual(m.map((x) => x.role), ['system', 'user', 'assistant', 'user'])
    assert.match(m[3].content, /ONE Python code block and nothing else/)
    assert.match(m[3].content, /"label: value"/)
  })
})

describe('fences and self-containment', () => {
  test('extracts the python fence, or any fence when allowed', () => {
    assert.equal(extractPythonFence('text\n```python\nprint(1)\n```\nmore'), 'print(1)')
    assert.equal(extractPythonFence('```\nprint(2)\n```'), null)
    assert.equal(extractPythonFence('```\nprint(2)\n```', true), 'print(2)')
    assert.equal(longestPythonFence('```python\nx=1\n```\n```py\ndef f():\n    return 1\n```'), 'def f():\n    return 1')
  })
  test('code that needs the world is not checked', () => {
    assert.equal(isSelfContained('def add(a,b):\n    return a+b\nassert add(1,2)==3'), true)
    assert.equal(isSelfContained('name = input("name? ")'), false)
    assert.equal(isSelfContained('import requests\nrequests.get("x")'), false)
    assert.equal(isSelfContained('with open("data.txt") as f: pass'), false)
    assert.equal(isSelfContained('while True:\n    pass'), false)
    assert.equal(isSelfContained(''), false)
  })
})

describe('codeFailureFinding', () => {
  test("the author's errors become a finding with the last relevant line", () => {
    const f = codeFailureFinding('Traceback (most recent call last):\n  File "<exec>", line 3, in <module>\nNameError: name \'totl\' is not defined')
    assert.match(f ?? '', /^- The Python code in the answer fails when run: NameError: name 'totl' is not defined\./)
    assert.match(codeFailureFinding('AssertionError: expected 6') ?? '', /AssertionError/)
    assert.match(codeFailureFinding('  File "<exec>", line 2\n    def f(:\nSyntaxError: invalid syntax') ?? '', /SyntaxError/)
  })
  test('environmental failures are not findings', () => {
    assert.equal(codeFailureFinding("ModuleNotFoundError: No module named 'requests'"), null)
    assert.equal(codeFailureFinding("FileNotFoundError: [Errno 44] No such file or directory: 'data.csv'"), null)
    assert.equal(codeFailureFinding('EOFError: EOF when reading a line'), null)
    assert.equal(codeFailureFinding('Timed out after 20s; the sandbox was restarted.'), null)
  })
})

describe('code findings in the grounding report', () => {
  test('count, describe, and the gate', () => {
    const before = { figures: [], links: [], checkedAgainst: ['run_python'], code: ['- The Python code in the answer fails when run: NameError: name \'x\' is not defined. Fix the code so it runs; do not describe the fix instead of making it.'] }
    assert.equal(groundingFindingCount(before), 1)
    assert.match(describeGroundingFindings(before), /fails when run: NameError/)
    assert.equal(revisionIsAnImprovement(before, null), true)
    assert.equal(revisionIsAnImprovement(before, { ...before }), false)
  })
})

describe('disclosure lines', () => {
  test('recompute and code check summaries', () => {
    assert.match(describeRecompute({ ran: true, ok: true }).summary, /Recomputed the stated figures/)
    assert.match(describeRecompute({ ran: false, ok: false, note: 'no program' }).summary, /skipped — no program/)
    assert.equal(describeCodeCheck({ ran: true, ok: true }).ok, true)
    assert.match(describeCodeCheck({ ran: true, ok: false, finding: '- The Python code in the answer fails when run: NameError: name \'x\' is not defined. Fix the code so it runs; do not describe the fix instead of making it.' }).summary, /it fails: NameError: name 'x' is not defined\.$/)
    assert.match(describeCodeCheck({ ran: true, ok: false, revisedRuns: true }).summary, /the revised code runs/)
  })
})

describe('extractRecomputeProgram', () => {
  const { extractRecomputeProgram } = require('../src/renderer/src/lib/workbenchChecks') as typeof import('../src/renderer/src/lib/workbenchChecks')
  test('fence wins; raw code accepted; prose refused', () => {
    assert.equal(extractRecomputeProgram('```python\nprint(1)\n```'), 'print(1)')
    assert.equal(extractRecomputeProgram('base = 28450\ntax = base * 0.0825\nprint(f"tax: {tax:.2f}")\nprint(f"total: {base + tax + 1200:.2f}")'), 'base = 28450\ntax = base * 0.0825\nprint(f"tax: {tax:.2f}")\nprint(f"total: {base + tax + 1200:.2f}")')
    assert.equal(extractRecomputeProgram('The total is $31,997.12 because tax is 8.25%.'), null)
    assert.equal(extractRecomputeProgram(''), null)
  })
})

describe('revisionDropsAllFigures', () => {
  const { revisionDropsAllFigures } = require('../src/renderer/src/lib/workbenchChecks') as typeof import('../src/renderer/src/lib/workbenchChecks')
  test('a quantitative answer revised into a disclaimer is refused, length regardless', () => {
    assert.equal(revisionDropsAllFigures('Total: $31,796.25.', 'I cannot verify any of those numbers without more information, and I should not guess at them; if you share the actual figures I will recalculate everything precisely.'), true)
    assert.equal(revisionDropsAllFigures('Total: $31,796.25.', 'Total: $31,997.12.'), false)
    assert.equal(revisionDropsAllFigures('No figures here.', 'Still none.'), false)
  })
})

describe('recompute reference and echo guard', () => {
  const { buildRecomputeReference, revisionEchoesScaffolding, RECOMPUTE_REFERENCE_HEADER } = require('../src/renderer/src/lib/workbenchChecks') as typeof import('../src/renderer/src/lib/workbenchChecks')
  test('the reference carries only the label: value lines', () => {
    const ref = buildRecomputeReference('base price: $28,450\nsales tax: $2347.12\ntotal out the door: $31997.12')
    assert.match(ref, /^Correct values, recomputed by running Python/)
    assert.match(ref, /sales tax: \$2347\.12/)
    assert.match(ref, /corrected answer text only/)
  })
  test('a revision that pasted the scaffolding is caught; a clean one passes', () => {
    assert.equal(revisionEchoesScaffolding(`${RECOMPUTE_REFERENCE_HEADER}\nPython ran in 3 ms.\nstdout: …`), true)
    assert.equal(revisionEchoesScaffolding('The total out the door is $31,997.12 ($28,450 + $2,347.12 tax + $1,200 fee).'), false)
  })
})
