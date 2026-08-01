import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildGroundingBlock,
  buildSearchContext,
  buildSearchQuery,
  consultedSources,
  looksFactual,
  withGrounding
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
  })

  test('failed, pending, and non-source tools leave the turn unverified', () => {
    assert.equal(consultedSources([rec('web_search', 'error')]), false)
    assert.equal(consultedSources([rec('web_search', 'running')]), false)
    assert.equal(consultedSources([rec('memory_search', 'done')]), false)
    assert.equal(consultedSources([rec('read_file', 'done')]), false)
    assert.equal(consultedSources([]), false)
  })
})
