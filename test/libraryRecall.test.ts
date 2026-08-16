import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  LIBRARY_PASSAGES_PER_TURN,
  buildLibraryContext,
  citationOf,
  shouldConsultLibrary,
  toLibraryContextItems
} from '../src/renderer/src/lib/libraryRecall'

/**
 * v1.5: the app-initiated reference lookup — when it fires and what the model
 * and the user are told. The retrieval itself is pinned in library.test.ts.
 */
describe('shouldConsultLibrary', () => {
  test('never when the tool is off for the slot', () => {
    assert.equal(shouldConsultLibrary({ enabled: false, reference: true, factual: true, offline: true }), false)
  })
  test('a reference-domain turn consults it, online or off', () => {
    assert.equal(shouldConsultLibrary({ enabled: true, reference: true, factual: false, offline: false }), true)
    assert.equal(shouldConsultLibrary({ enabled: true, reference: true, factual: false, offline: true }), true)
  })
  test('offline, any factual turn consults it — the web cannot', () => {
    assert.equal(shouldConsultLibrary({ enabled: true, reference: false, factual: true, offline: true }), true)
  })
  test('online, a merely factual turn does not — that is the web search\'s job', () => {
    assert.equal(shouldConsultLibrary({ enabled: true, reference: false, factual: true, offline: false }), false)
  })
  test('a chatty turn never does', () => {
    assert.equal(shouldConsultLibrary({ enabled: true, reference: false, factual: false, offline: true }), false)
  })
})

describe('labels', () => {
  const p = {
    packId: 'first-aid',
    packName: 'First aid',
    docId: 'fm',
    docTitle: 'FM 4-25.11',
    section: 'Burns',
    position: 0.31,
    text: 'Cool the burn.',
    score: 0.9
  }
  test('citation reads pack › doc › section · N% in', () => {
    assert.equal(citationOf(p), 'First aid › FM 4-25.11 › Burns · 31% in')
    assert.equal(citationOf({ ...p, section: '' }), 'First aid › FM 4-25.11 · 31% in')
  })
  test('strip items mirror the passages', () => {
    assert.deepEqual(toLibraryContextItems([p]), [
      { source: 'First aid › FM 4-25.11 › Burns · 31% in', score: 0.9, text: 'Cool the burn.' }
    ])
  })
  test('the turn block says why it is there, differently offline, and carries the formatted text', () => {
    const on = buildLibraryContext('[1] First aid › …', false)
    assert.match(on, /domain the local reference library covers/)
    assert.match(on, /do not fill the gap from memory/)
    assert.match(on, /\[1\] First aid/)
    const off = buildLibraryContext('[1] First aid › …', true)
    assert.match(off, /The app is offline/)
  })
  test('the per-turn cap is small', () => {
    assert.ok(LIBRARY_PASSAGES_PER_TURN >= 3 && LIBRARY_PASSAGES_PER_TURN <= 8)
  })
})
