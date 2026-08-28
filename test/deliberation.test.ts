import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  classifyReview,
  thinkHarderNote,
  buildReviewMessages,
  buildRevisionMessages,
  describeDeliberation,
  draftWentUnreviewed,
  figuresChanged,
  numbersIn,
  pickReviewer,
  reviewFoundProblems
} from '../src/renderer/src/lib/deliberation'
import type { DeliberationRecord, ModelConfig } from '../src/renderer/src/types'

/**
 * v1.5.1 think harder — the headless rules: who reviews, what each side is
 * told, when a review warrants a revision, and how a changed figure is noticed.
 */
const sampling = { temperature: 0.3, topP: 1, maxTokens: -1, seed: null, topK: -1, minP: -1 }
const slot = (id: string, roleName: string, modelId: string): ModelConfig => ({
  id,
  modelId,
  roleName,
  systemPrompt: `You are ${roleName}.`,
  color: 'blue',
  enabled: true,
  sampling,
  contextWindow: null
})
const answerer = slot('a', 'Assistant', 'qwen3-9b')
const critic = slot('c', 'Reviewer', 'gemma-4-12b')

describe('pickReviewer', () => {
  test('a different slot when one exists', () => {
    const r = pickReviewer([answerer, critic], answerer, null)
    assert.equal(r.slot.id, 'c')
    assert.equal(r.self, false)
  })
  test('the answerer itself, labelled self, when alone', () => {
    const r = pickReviewer([answerer], answerer, null)
    assert.equal(r.slot.id, 'a')
    assert.equal(r.self, true)
  })
})

describe('messages', () => {
  test('review asks for problems, not a rewrite, and names the author', () => {
    const m = buildReviewMessages(critic, 'What is 17 × 23?', 'It is 381.', 'Assistant', false)
    assert.equal(m[0].role, 'system')
    assert.match(m[0].content, /You are Reviewer\./)
    assert.match(m[0].content, /Do not rewrite it/)
    assert.match(m[1].content, /Assistant's draft answer/)
    assert.match(m[1].content, /It is 381\./)
  })
  test('self-review says so', () => {
    const m = buildReviewMessages(answerer, 'q', 'd', 'Assistant', true)
    assert.match(m[0].content, /read it as a strict reviewer, not as its author/)
    assert.match(m[1].content, /Your draft answer/)
  })
  test('revision carries question, draft and review and forbids mentioning the review', () => {
    const m = buildRevisionMessages(answerer, 'q', 'draft text', '1. 17 × 23 is 391, not 381.')
    assert.deepEqual(m.map((x) => x.role), ['system', 'user', 'assistant', 'user'])
    assert.equal(m[2].content, 'draft text')
    assert.match(m[3].content, /do not mention the review/)
    assert.match(m[3].content, /391, not 381/)
  })
})

describe('reviewFoundProblems', () => {
  test('the sentinel and short all-clears mean no', () => {
    assert.equal(reviewFoundProblems('No substantive problems.'), false)
    assert.equal(reviewFoundProblems('no substantive problems'), false)
    assert.equal(reviewFoundProblems('Looks good.'), false)
    assert.equal(reviewFoundProblems(''), false)
  })
  test('a numbered list means yes', () => {
    assert.equal(reviewFoundProblems('1. 17 × 23 is 391, not 381.\n2. The unit is missing.'), true)
  })
})

describe('figures', () => {
  test('numbersIn reads decimals, separators and percentages', () => {
    assert.deepEqual(numbersIn('12,500 at 4.5% over 30 years is 1,024.'), ['12500', '4.5%', '30', '1024'])
  })
  test('figuresChanged reports both directions', () => {
    const d = figuresChanged('The answer is 381.', 'The answer is 391.')
    assert.deepEqual(d, { added: ['391'], removed: ['381'] })
    assert.deepEqual(figuresChanged('same 42', 'same 42'), { added: [], removed: [] })
  })
})

describe('describeDeliberation', () => {
  const base: DeliberationRecord = {
    reviewerRole: 'Reviewer',
    reviewerModelId: 'gemma',
    self: false,
    status: 'done',
    draft: 'd',
    review: 'r',
    revised: true,
    createdAt: 1
  }
  test('states reviewer and outcome; labels self-review', () => {
    assert.equal(describeDeliberation(base), '🧠 Deliberated — reviewed by Reviewer, revised.')
    assert.equal(describeDeliberation({ ...base, revised: false }), '🧠 Deliberated — reviewed by Reviewer: no substantive problems found; draft kept.')
    assert.match(describeDeliberation({ ...base, self: true }), /reviewed its own draft, revised/)
    assert.match(describeDeliberation({ ...base, note: 'Figures changed: 381 → 391.' }), /Figures changed: 381 → 391/)
    assert.match(describeDeliberation({ ...base, status: 'reviewing' }), /in progress/)
    assert.match(describeDeliberation({ ...base, status: 'error', note: 'boom' }), /failed: boom/)
  })
})

/**
 * v1.9.2: a reviewer that returned nothing must never be reported as a
 * reviewer that approved the draft. Both states leave the draft standing and
 * both make reviewFoundProblems false — only one of them read the draft, and
 * the line the user reads is the only place that difference can survive.
 */
describe('a review that never came back', () => {
  const unreviewed: DeliberationRecord = {
    reviewerRole: 'Researcher',
    reviewerModelId: 'gemma',
    self: false,
    status: 'done',
    draft: 'It is 381.',
    review: '',
    revised: false,
    createdAt: 1
  }

  test('classifyReview separates nothing-came-back from a genuine all-clear', () => {
    assert.equal(classifyReview(''), 'none')
    assert.equal(classifyReview('   \n\t '), 'none')
    assert.equal(classifyReview('No substantive problems.'), 'clear')
    assert.equal(classifyReview('1. 17 × 23 is 391, not 381.'), 'problems')
  })

  test('an empty review is disclosed as no review, never as "no problems found"', () => {
    for (const review of ['', ' ', '\n\t \n']) {
      const line = describeDeliberation({ ...unreviewed, review })
      assert.doesNotMatch(line, /no substantive problems/i, `must not vouch for ${JSON.stringify(review)}`)
      assert.doesNotMatch(line, /reviewed by/i, 'must not claim the draft was reviewed')
      assert.doesNotMatch(line, /^🧠 Deliberated/, 'must not read as a completed deliberation')
      assert.match(line, /review request to Researcher/)
      assert.match(line, /came back empty/)
      assert.match(line, /no reviewer read this draft/)
    }
  })

  test('a self-review that returned nothing says so too', () => {
    const line = describeDeliberation({ ...unreviewed, self: true })
    assert.doesNotMatch(line, /no substantive problems/i)
    assert.doesNotMatch(line, /reviewed its own draft/i)
    assert.match(line, /the self-review request came back empty; no reviewer read this draft/)
  })

  test('a failed review is not an approval either', () => {
    const line = describeDeliberation({ ...unreviewed, status: 'error', note: 'stream closed' })
    assert.doesNotMatch(line, /no substantive problems/i)
    assert.match(line, /failed: stream closed/)
    assert.match(line, /no reviewer read this draft/)
  })

  test('a review that did come back and found nothing still reports the all-clear', () => {
    assert.equal(
      describeDeliberation({ ...unreviewed, review: 'No substantive problems.' }),
      '🧠 Deliberated — reviewed by Researcher: no substantive problems found; draft kept.'
    )
  })

  /**
   * v1.17.3. Round 9: *"`run.json` records `errorCount: 0, errors: []` on a
   * turn where the reviewer request was answered with an immediately-closed
   * empty stream."* The screen said `⚠️ Not deliberated`; the RECORD said
   * `status: 'done'`. The screen was re-deriving the failure from an empty
   * `review` string, and nothing that reads the record could learn it.
   *
   * `draftWentUnreviewed` is the one predicate now — it gates the disclosure's
   * tooltip, the retry control AND where the line renders, so they cannot drift
   * apart again.
   */
  describe('the record, not just the screen (v1.17.3)', () => {
    test('a reviewer that returned nothing is a failure in the record', () => {
      // The status the transport now writes for an empty 200.
      const record = { ...unreviewed, status: 'unreviewed' as const }
      assert.equal(draftWentUnreviewed(record), true)
      assert.doesNotMatch(describeDeliberation(record), /no substantive problems/i)
    })

    test('an old record with status "done" and no review is still caught', () => {
      // Records written before the status existed must still read as failures:
      // the predicate falls back to the review text rather than trusting a
      // status that predates the distinction.
      assert.equal(draftWentUnreviewed({ ...unreviewed, status: 'done', review: '' }), true)
    })

    test('a thrown pass is a failure too', () => {
      assert.equal(draftWentUnreviewed({ ...unreviewed, status: 'error', note: 'x' }), true)
    })

    /** The true negatives: a pass that ran must not be reported as a failure. */
    test('a real review — all-clear or with problems — is not a failure', () => {
      assert.equal(
        draftWentUnreviewed({ ...unreviewed, review: 'No substantive problems.' }),
        false
      )
      assert.equal(
        draftWentUnreviewed({ ...unreviewed, review: '1. 17 × 23 is 391.', revised: true }),
        false
      )
    })

    test('a pass still running is not yet a failure', () => {
      assert.equal(draftWentUnreviewed({ ...unreviewed, status: 'reviewing', review: '' }), false)
      assert.equal(draftWentUnreviewed({ ...unreviewed, status: 'revising', review: '' }), false)
    })
  })

  /**
   * Round 11, FR3 (`.h2h-runs/B10/FR3-20260827-224622`). The last line of the
   * bubble read `⚠️ Not deliberated — the review request to Researcher came
   * back empty; the draft was not checked.` Above it, in order: `🧮 Recomputed
   * the stated figures in Python`, `Covered 1 of the 3 measurements`, `Checked
   * against: run_python`. Reading downward — the only way it is read — an
   * unreviewed reply arrived as a checked one, and "not checked" landed
   * directly under a line saying the figures WERE checked.
   *
   * Two faults, and this build calls them both by name. The word: three passes
   * on that screen check something and none of them is this one, so this one
   * says "reviewed" and leaves "checked" to them. The order: a warning that
   * arrives after the reassurance it contradicts has already been misread.
   *
   * Not the rank. Round 10 settled that a warning carries one ink and
   * provenance another; promoting these lines to match would spend exactly the
   * contrast that distinction runs on.
   */
  describe('a review that did not happen says so in its own words, and first', () => {
    const bubble = readFileSync(
      join(__dirname, '..', '..', 'src', 'renderer', 'src', 'components', 'MessageBubble.tsx'),
      'utf-8'
    )
    const at = (needle: string): number => {
      const i = bubble.indexOf(needle)
      assert.ok(i > 0, `MessageBubble no longer contains ${needle}`)
      return i
    }
    const UNREVIEWED_SLOT = '{message.deliberation && draftWentUnreviewed(message.deliberation) && ('
    const REVIEWED_SLOT = '{message.deliberation && !draftWentUnreviewed(message.deliberation) && ('
    const CHECKS = '{!isStreaming && message.checks && message.checks.length > 0 && ('
    const GROUNDING = '<GroundingWarning report={message.grounding} />'

    test('no deliberation line borrows the word the figure checks use', () => {
      for (const record of [
        unreviewed,
        { ...unreviewed, self: true },
        { ...unreviewed, status: 'unreviewed' as const },
        { ...unreviewed, status: 'error' as const, note: 'stream closed' },
        { ...unreviewed, status: 'reviewing' as const },
        { ...unreviewed, status: 'revising' as const },
        { ...unreviewed, review: 'No substantive problems.' },
        { ...unreviewed, review: '1. 17 × 23 is 391.', revised: true }
      ]) {
        assert.doesNotMatch(
          describeDeliberation(record),
          /check/i,
          `measured: "the draft was not checked" under "🧮 Recomputed the stated figures in Python" — ${describeDeliberation(record)}`
        )
      }
    })

    test('it still says plainly that nothing reviewed the draft', () => {
      assert.match(describeDeliberation(unreviewed), /no reviewer read this draft/)
      assert.match(
        describeDeliberation({ ...unreviewed, status: 'error', note: 'stream closed' }),
        /no reviewer read this draft/
      )
    })

    test('the unreviewed line renders above every line that describes a check', () => {
      assert.ok(at(UNREVIEWED_SLOT) < at(CHECKS), 'it must precede the 🧮 and 🧪 lines')
      assert.ok(at(UNREVIEWED_SLOT) < at(GROUNDING), 'and the "Checked against" footer inside the banner')
    })

    test('a review that DID happen stays where provenance lives', () => {
      // The true negative for the move: this pass runs after the tail and can
      // revise the text those checks read, so a line saying it succeeded must
      // not sit above them claiming to describe what they saw.
      assert.ok(at(REVIEWED_SLOT) > at(CHECKS))
      assert.ok(at(REVIEWED_SLOT) > at(GROUNDING))
    })

    test('the line is rendered from one predicate, in two mutually exclusive slots', () => {
      assert.equal(
        (bubble.match(/<DeliberationLine record=\{message\.deliberation\} \/>/g) ?? []).length,
        2,
        'exactly two slots — a bubble that showed the line twice would be its own contradiction'
      )
    })

    test('the warning keeps a warning’s rank and does not take provenance’s', () => {
      // Round 10's contrast work: `text-ink-warn` is the finding rank,
      // `text-ink-tertiary` the provenance rank. Moving this line must not
      // promote the quiet ones to be heard over it.
      const banner = bubble.slice(at('function GroundingWarning'), at('function DeliberationLine'))
      assert.match(banner, /Checked against: \{report\.checkedAgainst/)
      assert.ok(
        /\{coverage !== '' && <div className="mt-1 text-ink-tertiary">/.test(banner),
        'the coverage line must stay at the provenance rank'
      )
      assert.ok(
        banner.includes('<div className="mt-1 text-ink-tertiary">\n        Checked against:'),
        'the "Checked against" footer must stay at the provenance rank'
      )
    })
  })
})

describe('thinkHarderNote (v1.9.1)', () => {
  test('a reasoning model gets the measured note; a non-reasoning model gets none', () => {
    for (const id of ['qwen3.8-9b', 'deepseek-r1-distill-8b', 'google/gemma-4-12b-qat']) {
      const note = thinkHarderNote(id)
      assert.ok(note, `${id} should carry the note`)
      assert.match(note!, /already reasons before answering/)
      assert.match(note!, /changed no answer across 14 reasoning problems/)
      assert.match(note!, /1\.7x/)
    }
    // v1.9.1: measured on mistral-7b-instruct-v0.3 — the class that does not
    // deliberate internally is where the pass actually pays.
    for (const id of ['mistralai/mistral-7b-instruct-v0.3', 'llama-3.1-8b-instruct']) {
      const note = thinkHarderNote(id)
      assert.ok(note, `${id} should carry the non-reasoning note`)
      assert.match(note!, /answers without deliberating first/)
      assert.match(note!, /quarter of wrong answers/)
      assert.match(note!, /breaking none/)
      assert.match(note!, /Worth it/)
    }
    // An unrecognised model is not evidence: claim nothing.
    assert.equal(thinkHarderNote(''), null)
    assert.equal(thinkHarderNote('   '), null)
  })

  test('the note says the feature stays available, not that it is useless', () => {
    const note = thinkHarderNote('qwen3.8-9b')!
    assert.match(note, /still here/)
    assert.doesNotMatch(note, /useless|pointless|never/i)
  })
})
