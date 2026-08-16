import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  ATTACHMENT_PASSAGES_PER_TURN,
  attachmentInlineNote,
  buildAttachmentContext,
  indexedAttachmentRefs,
  toAttachmentContextItems
} from '../src/renderer/src/lib/attachmentRecall'
import type { Attachment, ChatMessage } from '../src/renderer/src/types'

/**
 * v1.4.8: the renderer half of long-attachment retrieval. What is pinned here
 * is what the model is told — the labelling that stops a small model from
 * apologizing for, or inventing, the part of a document it was not given —
 * and which attachments a turn retrieves from.
 */

function file(overrides: Partial<Attachment>): Attachment {
  return { id: 'a1', kind: 'file', name: 'doc.pdf', mimeType: 'application/pdf', sizeBytes: 1, ...overrides }
}

function msg(role: 'user' | 'assistant', attachments?: Attachment[]): ChatMessage {
  return { id: `${role}-${Math.random()}`, role, content: 'x', createdAt: 1, attachments }
}

describe('attachmentInlineNote', () => {
  test('a whole file has no note', () => {
    assert.equal(attachmentInlineNote({ truncated: false }), '')
  })
  test('an indexed file states its size and where the rest comes from', () => {
    const note = attachmentInlineNote({ truncated: true, indexed: true, totalChars: 123456 })
    assert.match(note, /123,456 characters in total/)
    assert.match(note, /only the opening is shown/)
    assert.match(note, /never guess/)
  })
  test('a truncated-but-unindexed file keeps the old wording', () => {
    assert.equal(attachmentInlineNote({ truncated: true }), ' — truncated')
  })
})

describe('indexedAttachmentRefs', () => {
  test('collects indexed files across messages, once each, in order', () => {
    const a = file({ id: 'a', name: 'a.txt', indexed: true, sourcePath: '/tmp/a.txt' })
    const b = file({ id: 'b', name: 'b.txt', indexed: true })
    const plain = file({ id: 'c', name: 'c.txt' })
    const image: Attachment = { id: 'i', kind: 'image', name: 'i.png', mimeType: 'image/png', sizeBytes: 1, indexed: true }
    const refs = indexedAttachmentRefs({
      messages: [msg('user', [a, plain]), msg('assistant'), msg('user', [b, a, image])]
    })
    assert.deepEqual(refs, [
      { id: 'a', name: 'a.txt', sourcePath: '/tmp/a.txt' },
      { id: 'b', name: 'b.txt', sourcePath: undefined }
    ])
  })
  test('no indexed attachments → no refs', () => {
    assert.deepEqual(indexedAttachmentRefs({ messages: [msg('user', [file({})])] }), [])
  })
})

describe('buildAttachmentContext', () => {
  const passage = { attachmentId: 'a', name: 'doc.pdf', text: 'The timeout is thirty seconds.', position: 0.42, score: 0.9 }

  test('nothing to say → null, so the turn is untouched', () => {
    assert.equal(buildAttachmentContext([], []), null)
  })
  test('passages are labelled with name, position and relevance and fenced with the anti-invention rule', () => {
    const block = buildAttachmentContext([passage], [])!
    assert.match(block, /doc\.pdf · 42% in · relevance 0\.9/)
    assert.match(block, /thirty seconds/)
    assert.match(block, /do not invent document content/)
  })
  test('notes ride along even without passages', () => {
    const block = buildAttachmentContext([], ['"gone.txt" could not be re-read'])!
    assert.match(block, /Note: "gone\.txt" could not be re-read/)
  })
  test('the bubble items mirror what was sent', () => {
    assert.deepEqual(toAttachmentContextItems([passage]), [
      { source: 'doc.pdf · 42% in', score: 0.9, text: 'The timeout is thirty seconds.' }
    ])
  })
  test('the per-turn cap is small enough to fit a small context window', () => {
    assert.ok(ATTACHMENT_PASSAGES_PER_TURN >= 3 && ATTACHMENT_PASSAGES_PER_TURN <= 8)
  })
})

describe('v1.6 file refs for the Workbench', () => {
  const { attachmentFileRefs, tabularAttachmentsOnTurn } = require('../src/renderer/src/lib/attachmentRecall') as typeof import('../src/renderer/src/lib/attachmentRecall')
  test('every file with a path, latest wins on a name clash', () => {
    const a1 = file({ id: '1', name: 'sales.csv', sourcePath: '/tmp/old/sales.csv' })
    const a2 = file({ id: '2', name: 'sales.csv', sourcePath: '/tmp/new/sales.csv' })
    const noPath = file({ id: '3', name: 'notes.md' })
    const img: Attachment = { id: 'i', kind: 'image', name: 'x.png', mimeType: 'image/png', sizeBytes: 1, sourcePath: '/tmp/x.png' }
    const refs = attachmentFileRefs({ messages: [msg('user', [a1, noPath, img]), msg('user', [a2])] })
    assert.deepEqual(refs, [{ name: 'sales.csv', sourcePath: '/tmp/new/sales.csv' }])
  })
  test('tabular attachments on the latest user turn only', () => {
    const earlier = file({ id: '1', name: 'old.csv', sourcePath: '/tmp/old.csv' })
    const now = [file({ id: '2', name: 'q3.xlsx', sourcePath: '/tmp/q3.xlsx', dataFile: true }), file({ id: '3', name: 'notes.txt', sourcePath: '/tmp/n.txt' })]
    assert.deepEqual(tabularAttachmentsOnTurn({ messages: [msg('user', [earlier]), msg('assistant'), msg('user', now)] }), ['q3.xlsx'])
  })
  test('labels: data files say where they live; tabular text says it is also under /work', () => {
    assert.match(attachmentInlineNote({ truncated: false, dataFile: true, name: 'q3.xlsx' }), /\/work\/q3\.xlsx/)
    assert.match(attachmentInlineNote({ truncated: false, name: 'sales.csv' }), /also available to run_python and analyze_file at \/work\/sales\.csv/)
    assert.equal(attachmentInlineNote({ truncated: false, name: 'notes.txt' }), '')
  })
})
