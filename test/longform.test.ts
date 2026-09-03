import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from './harness'
import { looksLikeDocumentAsk } from '../src/renderer/src/lib/playbooks'
import { requiredSectionsPresent, sectionsOf, summarizeLongform, wordCount } from '../src/renderer/src/lib/answerEval'
import type { LongformCaseResult } from '../src/renderer/src/lib/answerEval'

/**
 * v2.6: the document-shaped request and the mechanical rubric the longform
 * suite scores with. The outline path itself talks to a model; what is pinned
 * here is the gate that sends a request to it and the scorer that judges it.
 */

describe('a document-shaped request', () => {
  test('an explicit length of 800 words or more, or a named form with its sections, qualifies', () => {
    assert.ok(looksLikeDocumentAsk('Write a 1,500-word guide to composting. Sections: What to add, Turning.'))
    assert.ok(looksLikeDocumentAsk('Produce a 1200-word explainer on home networks'))
    assert.ok(looksLikeDocumentAsk('Draft a grant proposal with the sections: Need, Goals, Budget narrative.'))
    assert.ok(looksLikeDocumentAsk('Write a report for a general reader, with the sections titled Before, During, After'))
  })

  test('a short piece, a question, or a form with no sections does not', () => {
    assert.ok(!looksLikeDocumentAsk('Write a 300-word summary of this article'))
    assert.ok(!looksLikeDocumentAsk('What is the capital of Peru?'))
    assert.ok(!looksLikeDocumentAsk('Write me a short essay about autumn'))
    assert.ok(!looksLikeDocumentAsk('Plan a trip to Lisbon'))
  })

  test('every longform fixture is a document ask, with sections and a length', () => {
    const dir = join(__dirname, '..', '..', 'test', 'fixtures', 'longform')
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    assert.equal(files.length, 12)
    for (const f of files) {
      const fx = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as { prompt: string; sections: string[]; minWords: number }
      assert.ok(looksLikeDocumentAsk(fx.prompt), f)
      assert.ok(fx.sections.length >= 5 && fx.minWords >= 800, f)
    }
  })
})

describe('the outline a request already contains', () => {
  const { outlineFromRequest, sectionBudget, targetWordsOf } = load<typeof import('../src/main/ipc/outline')>('outline')

  test('listed sections become the outline, in order, with the title read off the ask', () => {
    const o = outlineFromRequest('Write a 1,500-word beginner\'s guide to starting a vegetable garden. Use these section headings: Planning, Soil, Choosing crops, Watering, Pests, Harvest.')
    assert.deepEqual(o?.sections.map((s) => s.heading), ['Planning', 'Soil', 'Choosing crops', 'Watering', 'Pests', 'Harvest'])
    assert.equal(o?.title, "Beginner's guide to starting a vegetable garden")
    const p = outlineFromRequest('Draft a 1,200-word onboarding handbook for a new remote employee. Sections: First day, Tools and access, Communication norms, First 30 days, Who to ask.')
    assert.deepEqual(p?.sections.map((s) => s.heading), ['First day', 'Tools and access', 'Communication norms', 'First 30 days', 'Who to ask'])
    const q = outlineFromRequest('Write a 1,200-word twelve-week half-marathon plan. Sections: Principles, Weeks 1-4, Weeks 5-8, Weeks 9-12, Race week, Injury prevention.')
    assert.equal(q?.sections.length, 6)
  })

  test('no listed sections, or too few, means the model plans', () => {
    assert.equal(outlineFromRequest('Write a 1,500-word explainer on securing a home network.'), null)
    assert.equal(outlineFromRequest('Write a guide with sections: One, Two.'), null)
  })

  test('every longform fixture yields its outline without a model', () => {
    const dir = join(__dirname, '..', '..', 'test', 'fixtures', 'longform')
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const fx = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as { prompt: string; sections: string[] }
      const o = outlineFromRequest(fx.prompt)
      assert.ok(o, f)
      assert.equal(o!.sections.length, fx.sections.length, f)
    }
  })

  test('the section budget follows the requested length and is told to the section', () => {
    assert.equal(targetWordsOf('Write a 1,500-word guide'), 1500)
    assert.equal(targetWordsOf('Write a guide'), 1200)
    assert.deepEqual(sectionBudget(1500, 6), { words: 250, maxTokens: 550 })
    assert.deepEqual(sectionBudget(300, 6), { words: 80, maxTokens: 220 })
    assert.deepEqual(sectionBudget(4000, 3), { words: 1333, maxTokens: 800 })
  })
})

describe('the longform rubric', () => {
  const reply = [
    '# Composting at home',
    '',
    '## What to add',
    'Greens and browns, in roughly equal measure. Coffee grounds count as green.',
    '',
    '**What to leave out**',
    'Meat, dairy and oils attract rats and slow the pile.',
    '',
    '## Turning',
    'Turn the pile every week or two so air reaches the middle.'
  ].join('\n')

  test('sections are markdown headings or bold lines, with the text under each', () => {
    const s = sectionsOf(reply)
    assert.deepEqual(
      s.map((x) => x.heading),
      ['Composting at home', 'What to add', 'What to leave out', 'Turning']
    )
    assert.match(s[1]!.text, /Coffee grounds/)
    assert.equal(s[0]!.text.trim(), '')
  })

  test('required sections are matched by containment, case-insensitively, and the missing ones named', () => {
    const r = requiredSectionsPresent(['what to add', 'what to leave out', 'balance', 'turning'], sectionsOf(reply).map((s) => s.heading))
    assert.deepEqual(r.found, ['what to add', 'what to leave out', 'turning'])
    assert.deepEqual(r.missing, ['balance'])
    assert.equal(wordCount(reply), 45)
  })

  test('the summary counts complete, long enough, truncated and distinct per arm', () => {
    const arm = (over: Partial<LongformCaseResult['arms']['bare']> = {}) => ({
      words: 1300,
      sectionsFound: 6,
      sectionsOf: 6,
      missing: [],
      redundancy: 0.6,
      truncated: false,
      ms: 60000,
      reply: '',
      ...over
    })
    const results: LongformCaseResult[] = [
      { file: 'a', prompt: '', minWords: 1200, arms: { bare: arm(), outline: arm() } },
      { file: 'b', prompt: '', minWords: 1200, arms: { bare: arm({ sectionsFound: 4, missing: ['x', 'y'], words: 700, truncated: true, redundancy: 0.9 }), outline: arm() } },
      { file: 'c', prompt: '', minWords: 1200, arms: { bare: arm({ error: 'boom' }) } }
    ]
    const s = summarizeLongform(results)
    assert.deepEqual(s.arms.bare!.ran, { hit: 2, of: 3 })
    assert.deepEqual(s.arms.bare!.complete, { hit: 1, of: 2 })
    assert.deepEqual(s.arms.bare!.longEnough, { hit: 1, of: 2 })
    assert.deepEqual(s.arms.bare!.truncated, { hit: 1, of: 2 })
    assert.deepEqual(s.arms.bare!.distinct, { hit: 1, of: 2 })
    assert.deepEqual(s.arms.outline!.complete, { hit: 2, of: 2 })
    assert.equal(s.arms.outline!.seconds, 60)
  })
})
