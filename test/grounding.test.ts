import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildGroundingBlock,
  buildSearchContext,
  buildSearchQuery,
  buildTurnContext,
  consultedSources,
  looksFactual,
  looksReference,
  withGrounding,
  withToolCallPreamble,
  BREVITY_RULES,
  TURN_CONTEXT_HEADER,
  TOOL_PREAMBLE_INSTRUCTION
} from '../src/renderer/src/lib/grounding'
import type { ToolCallRecord } from '../src/renderer/src/types'

/**
 * Grounding's one structural guarantee: the decision to verify is mechanical,
 * not the model's. These tests pin the heuristic's shape — factual lookups
 * trigger an app-run search, creative/coding work does not — and the rule
 * that only a *successful* source-tool call clears the unverified flag.
 */

describe('looksFactual', () => {
  test('the confabulation case: band/album questions are factual', () => {
    assert.equal(looksFactual('tell me about the band Phish and their key albums'), true)
    assert.equal(looksFactual("What are Radiohead's key albums and sound shifts?"), true)
    assert.equal(looksFactual('How did their live shows change after the Billy Budd tour?'), true)
  })

  test('questions about named entities are factual', () => {
    assert.equal(looksFactual('Who is the CEO of Tesla?'), true)
    assert.equal(looksFactual('When was the first iPhone released?'), true)
    assert.equal(looksFactual('Tell me about Ada Lovelace'), true)
  })

  test('current-events and market words are factual', () => {
    assert.equal(looksFactual("what's the latest on the election"), true)
    assert.equal(looksFactual('current price of bitcoin'), true)
  })

  test('creative and coding requests do not trigger a search', () => {
    assert.equal(looksFactual('write a poem about Spring'), false)
    assert.equal(looksFactual('write a short story about a band on tour'), false)
    assert.equal(looksFactual('fix this bug in my parse function'), false)
    assert.equal(looksFactual('refactor this code to use async await'), false)
  })

  test('casual chat and tiny messages do not trigger a search', () => {
    assert.equal(looksFactual('hello'), false)
    assert.equal(looksFactual('thanks, that helps a lot'), false)
    assert.equal(looksFactual('how do I center a div'), false)
  })
})

describe('grounding block', () => {
  test('carries the date and the verify-or-say-unknown rule', () => {
    const block = buildGroundingBlock(new Date('2026-07-31T12:00:00Z'))
    assert.match(block, /Today's date is 2026-07-31/)
    assert.match(block, /Never invent a plausible-sounding title/)
    assert.match(block, /flag the premise/)
  })

  test('withGrounding appends rather than replaces the slot persona', () => {
    const out = withGrounding('You are a helpful assistant.', new Date('2026-07-31T12:00:00Z'))
    assert.ok(out.startsWith('You are a helpful assistant.'))
    assert.match(out, /Grounding rules:/)
  })
})

describe('search context', () => {
  test('labels results as untrusted and says what to do when they fall short', () => {
    const ctx = buildSearchContext('Phish albums', 'result one\nresult two')
    assert.match(ctx, /"Phish albums"/)
    assert.match(ctx, /untrusted external content/)
    assert.match(ctx, /result one/)
  })

  test('buildSearchQuery flattens and caps the user message', () => {
    assert.equal(buildSearchQuery('a\nb   c'), 'a b c')
    assert.ok(buildSearchQuery('x'.repeat(500)).length <= 241 + 1)
  })
})

describe('buildSearchQuery · anchoring a follow-up', () => {
  const previous = 'best all-terrain pet stroller for a large dog'

  test('a short continuer is anchored to the previous message', () => {
    // Sent alone, this query comes back about gold bullion.
    assert.equal(
      buildSearchQuery('lets go with the gold one', previous),
      `${previous} — lets go with the gold one`
    )
  })

  test('an ordinal back-reference is anchored', () => {
    assert.equal(
      buildSearchQuery('what about the second one?', previous),
      `${previous} — what about the second one?`
    )
    assert.equal(buildSearchQuery('number 2 please', previous), `${previous} — number 2 please`)
  })

  test('a self-contained question is NOT anchored just for containing a pronoun', () => {
    // "it" appears in ordinary standalone questions constantly. Anchoring on
    // it prepends an unrelated topic and doubles what reaches the provider.
    const q = 'how tall is the Eiffel Tower and when was it built?'
    assert.equal(buildSearchQuery(q, previous), q)
  })

  test('a long message is never anchored, however it opens', () => {
    const q =
      'and now that I have compared them, which of these car seats has the best crash test rating in Europe?'
    assert.equal(buildSearchQuery(q, previous), q)
  })

  test('a weak continuer only counts in a terse message', () => {
    assert.equal(buildSearchQuery('and the price?', previous), `${previous} — and the price?`)
    const longer = 'now explain how regenerative braking recovers energy'
    assert.equal(buildSearchQuery(longer, previous), longer)
  })

  test('with no previous message there is nothing to anchor to', () => {
    assert.equal(buildSearchQuery('and the price?'), 'and the price?')
    assert.equal(buildSearchQuery('and the price?', '   '), 'and the price?')
  })

  test('the combined query still respects the length cap', () => {
    const long = 'y'.repeat(500)
    assert.ok(buildSearchQuery('and the price?', long).length <= 241 + 1)
  })
})

describe('consultedSources', () => {
  const rec = (name: string, status: ToolCallRecord['status']): ToolCallRecord => ({
    id: name,
    name,
    args: {},
    status
  })

  test('only a successful source-tool call counts', () => {
    assert.equal(consultedSources([rec('web_search', 'done')]), true)
    assert.equal(consultedSources([rec('fetch_webpage', 'done')]), true)
    assert.equal(consultedSources([rec('deep_research', 'done')]), true)
    // v1.5: an installed reference document is a source the model can quote.
    assert.equal(consultedSources([rec('reference_lookup', 'done')]), true)
    // v1.6: computed numbers have the computation as their source.
    assert.equal(consultedSources([rec('run_python', 'done')]), true)
    assert.equal(consultedSources([rec('finance_calculator', 'done')]), true)
  })

  test('failed, pending, and non-source tools leave the turn unverified', () => {
    assert.equal(consultedSources([rec('web_search', 'error')]), false)
    assert.equal(consultedSources([rec('web_search', 'running')]), false)
    assert.equal(consultedSources([rec('memory_search', 'done')]), false)
    assert.equal(consultedSources([rec('read_file', 'done')]), false)
    assert.equal(consultedSources([]), false)
  })
})

describe('withToolCallPreamble (Layer 1d)', () => {
  test('non-reasoning models get the one-sentence instruction', () => {
    const out = withToolCallPreamble('You are helpful.', 'llama-3.1-8b-instruct')
    assert.ok(out.endsWith(TOOL_PREAMBLE_INSTRUCTION))
    assert.equal(out.startsWith('You are helpful.'), true)
  })

  test('reasoning models do not — their CoT already covers it', () => {
    assert.equal(withToolCallPreamble('You are helpful.', 'qwen3-8b'), 'You are helpful.')
    assert.equal(
      withToolCallPreamble('You are helpful.', 'google/gemma-4-12b-qat'),
      'You are helpful.'
    )
  })

  test('the instruction asks for the reason and the expectation, in one sentence', () => {
    assert.match(TOOL_PREAMBLE_INSTRUCTION, /one sentence/)
    assert.match(TOOL_PREAMBLE_INSTRUCTION, /why it is needed/)
    assert.match(TOOL_PREAMBLE_INSTRUCTION, /expect back/)
  })
})

/**
 * v1.5: the per-turn additions moved out of the system prompt so the prompt
 * prefix stops changing at token zero on every turn. What this pins is the
 * part that has to hold for that to be worth anything — a turn with nothing
 * to add must leave the message byte-identical — plus the disclosure that
 * keeps injected search results from reading as the user's own instructions.
 */
/**
 * v1.5: the two domains where the v1.4 badge was silent and the cost of being
 * wrong was highest. Both are drawn from measured sessions — a suspected black
 * widow bite the model never verified, and a deck load it got backwards.
 */
describe('looksFactual — harm-shaped domains', () => {
  const factual = [
    'he says he feels dizzy, what do i do',
    'my brother was bit by a spider',
    'is aspirin contraindicated after a black widow bite',
    'what dosage of ibuprofen is safe',
    'how much psf can my joists carry',
    'do i need a permit for a load-bearing wall',
    'what amperage breaker for this circuit'
  ]
  for (const text of factual) {
    test(`"${text}" earns a source`, () => {
      assert.equal(looksFactual(text), true)
    })
  }

  test('a creative request that mentions a symptom is still creative', () => {
    assert.equal(looksFactual('write a story about a snake bite'), false)
  })
})

describe('BREVITY_RULES', () => {
  test('ride every turn, alongside the grounding block', () => {
    const out = withGrounding('You are helpful.')
    assert.ok(out.includes(BREVITY_RULES))
    assert.ok(out.includes(buildGroundingBlock()))
  })

  test('name the numbered-menu ending specifically', () => {
    // The measured pattern: every turn closing with "explore 1, 2, or 3?",
    // which turns a conversation into one-word replies and a prefill each.
    assert.match(BREVITY_RULES, /numbered menu/i)
  })

  test('ask for the answer first', () => {
    assert.match(BREVITY_RULES, /lead with the answer/i)
  })
})

describe('buildTurnContext', () => {
  test('a turn with nothing to add changes nothing', () => {
    assert.equal(buildTurnContext([]), null)
  })

  test('blank blocks do not count as something to add', () => {
    assert.equal(buildTurnContext(['', '   ', '\n']), null)
  })

  test('the block says the notes are not the user speaking', () => {
    const out = buildTurnContext(['Search results: …'])
    assert.ok(out)
    assert.ok(out.includes(TURN_CONTEXT_HEADER))
    assert.match(TURN_CONTEXT_HEADER, /not part of the user/i)
    assert.match(TURN_CONTEXT_HEADER, /instruction/i)
  })

  test('it appends — the user\'s own message keeps its start', () => {
    const out = buildTurnContext(['note'])
    assert.ok(out?.startsWith('\n\n'))
  })

  test('every block survives', () => {
    const out = buildTurnContext(['memory recall', 'search results', 'pricing note'])
    assert.ok(out?.includes('memory recall'))
    assert.ok(out?.includes('search results'))
    assert.ok(out?.includes('pricing note'))
  })
})

/**
 * v1.4.6. The NYC route session: a turn naming five retail chains and asking
 * for a route between them read as non-factual, so nothing searched and the
 * reply could never be flagged. It opened by asserting a chain had "closed
 * permanently between 2019–2024" — no tool call — and substituted a company
 * that went bankrupt in 2020.
 */
describe('looksFactual — places and businesses', () => {
  const factual = [
    'tomorrow i need to plan a route in NYC for sales and merchendising of Seggiano products',
    'is Citarella still open in Manhattan',
    'what are the store locations for whole foods in brooklyn',
    'give me addresses for morton williams',
    'did Dean & DeLuca go out of business',
    'store hours for the chelsea location'
  ]
  for (const text of factual) {
    test(`"${text.slice(0, 46)}…" earns a source`, () => {
      assert.equal(looksFactual(text), true)
    })
  }

  const notFactual = [
    // "open" and "closed" are ordinary words; only the paired forms count.
    'open the config file and change the port',
    'the issue is closed, what should i do next',
    'plan a birthday party for twelve people',
    'write me a poem about the open road'
  ]
  for (const text of notFactual) {
    test(`"${text.slice(0, 46)}…" is left alone`, () => {
      assert.equal(looksFactual(text), false)
    })
  }
})

describe('grounding block · offline (v1.5)', () => {
  test('online names web_search first and mentions the library for reference domains', () => {
    const block = buildGroundingBlock(new Date('2026-08-16T12:00:00Z'))
    assert.match(block, /verify it with web_search/)
    assert.match(block, /reference_lookup/)
    assert.doesNotMatch(block, /OFFLINE/)
  })
  test('offline replaces the web rule with the library and permission to say "cannot verify"', () => {
    const block = buildGroundingBlock(new Date('2026-08-16T12:00:00Z'), { offline: true })
    assert.match(block, /You are OFFLINE/)
    assert.match(block, /reference_lookup/)
    assert.match(block, /cannot verify it while offline/)
    assert.doesNotMatch(block, /verify it with web_search/)
    // The rest of the rules are unchanged.
    assert.match(block, /Never invent a plausible-sounding title/)
    assert.match(block, /flag the premise/)
  })
  test('withGrounding threads the option through', () => {
    assert.match(withGrounding('persona', new Date(), { offline: true }), /You are OFFLINE/)
    assert.doesNotMatch(withGrounding('persona', new Date()), /You are OFFLINE/)
  })
})

describe('looksReference (v1.5)', () => {
  const yes = [
    'how do I treat a second-degree burn?',
    'I just burned my hand on a pan, what should I do?',
    'she scalded her arm with tea',
    'what is the standard deduction for a married couple',
    'can my landlord keep my deposit for normal wear',
    'what goes in a hurricane emergency kit',
    'how long can cooked chicken stay in the fridge',
    'my faucet is leaking under the sink, where do I start',
    'is it safe to run a generator in the garage',
    'what does the first aid manual say about choking',
    'according to my notes, what is the router password',
    'symptoms of carbon monoxide poisoning',
    'should I contribute to a roth or traditional ira'
  ]
  const no = [
    'write a poem about the sea',
    'fix this bug in my python function',
    'what album did Radiohead release in 2007',
    'hi',
    'summarize our conversation so far',
    'plan a trip to Lisbon in June'
  ]
  for (const t of yes) test(`yes: ${t}`, () => assert.equal(looksReference(t), true))
  for (const t of no) test(`no: ${t}`, () => assert.equal(looksReference(t), false))
})
