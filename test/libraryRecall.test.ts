import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  LIBRARY_PASSAGES_PER_TURN,
  UNCITED_MARK,
  buildLibraryContext,
  citationOf,
  contextItemLabel,
  markCitedContextItems,
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
  test('strip items mirror the passages, numbered as the model was told to cite them', () => {
    // v1.13: `index` is the [n] in formatLookup, which numbers this same array
    // in this same order — without it the strip gave a reply's [1] nothing to
    // name. `url` is the locator the lookup already retrieved.
    assert.deepEqual(toLibraryContextItems([p, { ...p, section: 'Shock', source: 'https://example.org/fm' }]), [
      { source: 'First aid › FM 4-25.11 › Burns · 31% in', score: 0.9, text: 'Cool the burn.', index: 1 },
      {
        source: 'First aid › FM 4-25.11 › Shock · 31% in',
        score: 0.9,
        text: 'Cool the burn.',
        index: 2,
        url: 'https://example.org/fm'
      }
    ])
  })
  test('the strip line leads with the bracketed number the reply cites', () => {
    const [first, second] = toLibraryContextItems([p, { ...p, section: 'Shock' }])
    assert.equal(contextItemLabel(first), '[1] First aid › FM 4-25.11 › Burns · 31% in (0.90)')
    assert.match(contextItemLabel(second), /^\[2\] /)
  })
  test('a recalled item with no number (memory, attachments) is unchanged', () => {
    assert.equal(
      contextItemLabel({ source: 'note.md', score: 0.42, text: 'x' }),
      'note.md (0.42)'
    )
  })
  test('a listed passage the reply never cited is marked, a cited one is not', () => {
    const items = toLibraryContextItems([p, { ...p, section: 'Shock' }])
    const marked = markCitedContextItems(items, 'Cool it under running water [1].')
    assert.deepEqual(marked.map((i) => i.cited), [true, false])
    assert.equal(contextItemLabel(marked[0]), '[1] First aid › FM 4-25.11 › Burns · 31% in (0.90)')
    assert.equal(contextItemLabel(marked[1]), `[2] First aid › FM 4-25.11 › Shock · 31% in (0.90) ${UNCITED_MARK}`)
  })
  test('an answer that cites nothing marks every listed passage', () => {
    const marked = markCitedContextItems(toLibraryContextItems([p]), 'Run it under cool water.')
    assert.deepEqual(marked.map((i) => i.cited), [false])
  })
  test('an item that was never given a number is not accused of going uncited', () => {
    const [only] = markCitedContextItems([{ source: 'note.md', score: 0.42, text: 'x' }], 'no markers here')
    assert.equal(only.cited, undefined)
    assert.equal(contextItemLabel(only), 'note.md (0.42)')
  })
  test('a folder pack\'s local path is not offered as a link', () => {
    const [item] = toLibraryContextItems([{ ...p, source: '/Users/me/docs/lease.pdf' }])
    assert.equal(item.url, undefined)
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
