import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { load, resetState, state } from './harness'

/**
 * v1.4.8: long attachments are indexed and retrieved per turn instead of cut
 * at 20,000 characters. These pin the whole path — a long file loads as
 * head-inline + indexed, retrieval finds a passage far past the old cut, the
 * document survives a research-index clear-by-TTL, and a restart is recovered
 * from the source path.
 */

const attachments = load<typeof import('../src/main/ipc/attachments')>('attachments')
const index = load<typeof import('../src/main/ipc/attachmentIndex')>('attachmentIndex')
const research = load<typeof import('../src/main/ipc/researchIndex')>('researchIndex')

const dir = mkdtempSync(join(tmpdir(), 'sigma-attach-'))

function write(name: string, text: string): string {
  const path = join(dir, name)
  writeFileSync(path, text)
  return path
}

/** ~60,000 chars of filler with one distinctive paragraph deep inside. */
function longDocument(): string {
  const filler = 'The committee met on the usual schedule and reviewed routine matters without incident. '
  const parts: string[] = []
  while (parts.join('').length < 45_000) parts.push(filler)
  parts.push(
    '\n\nAppendix C: the retry timeout for the payment gateway is thirty seconds, after which the request is abandoned and logged.\n\n'
  )
  while (parts.join('').length < 60_000) parts.push(filler)
  return parts.join('')
}

beforeEach(() => {
  resetState()
  research.clearResearchIndex()
})

describe('loading a long text attachment', () => {
  test('a short file is inlined whole', async () => {
    const path = write('short.txt', 'hello world')
    const { attachments: loaded } = await attachments.loadAttachmentPaths([path])
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].textContent, 'hello world')
    assert.equal(loaded[0].truncated, false)
    assert.equal(loaded[0].indexed, undefined)
  })

  test('a long file keeps its opening inline and is indexed', async () => {
    const path = write('long.txt', longDocument())
    const { attachments: loaded } = await attachments.loadAttachmentPaths([path])
    assert.equal(loaded.length, 1)
    const a = loaded[0]
    assert.equal(a.truncated, true)
    assert.equal(a.indexed, true)
    assert.equal(a.sourcePath, path)
    assert.equal(a.totalChars, longDocument().length)
    assert.ok((a.textContent ?? '').length <= 6_000, 'only the head is inlined')
    assert.ok(!(a.textContent ?? '').includes('Appendix C'), 'the deep passage is not in the head')
    assert.equal(index.isAttachmentIndexed(a.id), true)
    assert.equal(research.researchIndexStats().pinnedDocs, 1)
  })
})

describe('retrieving from indexed attachments', () => {
  test('finds a passage far past the old 20K cut', async () => {
    const path = write('deep.txt', longDocument())
    const { attachments: loaded } = await attachments.loadAttachmentPaths([path])
    const a = loaded[0]
    const outcome = await index.retrieveAttachmentPassages(
      [{ id: a.id, name: a.name, sourcePath: a.sourcePath }],
      'what is the retry timeout for the payment gateway?',
      3
    )
    assert.equal(outcome.ok, true)
    assert.ok(outcome.passages.length > 0)
    const hit = outcome.passages.find((p) => p.text.includes('thirty seconds'))
    assert.ok(hit, `expected the appendix passage, got: ${outcome.passages.map((p) => p.text.slice(0, 60))}`)
    assert.ok(hit!.position > 0.5, 'the passage sits deep in the document')
    assert.equal(hit!.name, 'deep.txt')
  })

  test('works keyword-only when embeddings are unavailable', async () => {
    state.failEmbeddings = true
    const path = write('kw.txt', longDocument())
    const { attachments: loaded } = await attachments.loadAttachmentPaths([path])
    const a = loaded[0]
    const outcome = await index.retrieveAttachmentPassages(
      [{ id: a.id, name: a.name }],
      'payment gateway retry timeout',
      3
    )
    assert.ok(outcome.passages.some((p) => p.text.includes('thirty seconds')))
    assert.ok(outcome.notes.some((n) => /keyword-only/i.test(n)))
  })

  test('re-indexes from the source path after the index is gone (restart)', async () => {
    const path = write('restart.txt', longDocument())
    const { attachments: loaded } = await attachments.loadAttachmentPaths([path])
    const a = loaded[0]
    research.clearResearchIndex()
    assert.equal(index.isAttachmentIndexed(a.id), false)
    const outcome = await index.retrieveAttachmentPassages(
      [{ id: a.id, name: a.name, sourcePath: path }],
      'payment gateway retry timeout',
      3
    )
    assert.ok(outcome.passages.some((p) => p.text.includes('thirty seconds')))
    assert.equal(index.isAttachmentIndexed(a.id), true)
  })

  test('a missing source file degrades to a note, never a throw', async () => {
    const outcome = await index.retrieveAttachmentPassages(
      [{ id: 'gone', name: 'gone.txt', sourcePath: join(dir, 'does-not-exist.txt') }],
      'anything',
      3
    )
    assert.equal(outcome.ok, true)
    assert.equal(outcome.passages.length, 0)
    assert.ok(outcome.notes.some((n) => n.includes('gone.txt')))
  })

  test('an empty query retrieves nothing', async () => {
    const outcome = await index.retrieveAttachmentPassages([{ id: 'x', name: 'x' }], '   ', 3)
    assert.deepEqual(outcome.passages, [])
  })

  test('formatting carries name, position and relevance', () => {
    const text = index.formatAttachmentPassages([
      { attachmentId: 'a', name: 'doc.pdf', text: 'body', position: 0.42, score: 0.9 }
    ])
    assert.match(text, /doc\.pdf · 42% into the document · relevance 0\.9/)
    assert.match(text, /body/)
  })
})

describe('pinned documents in the research index', () => {
  test('a pinned document is not evicted by fetched pages filling the index', () => {
    index.indexAttachment({ id: 'pin', name: 'pin.txt', text: 'x'.repeat(30_000), kind: 'text' })
    for (let i = 0; i < 40; i++) {
      research.indexPage({
        key: `https://example.com/${i}`,
        url: `https://example.com/${i}`,
        title: `p${i}`,
        text: 'page text '.repeat(200),
        truncated: false
      })
    }
    assert.equal(index.isAttachmentIndexed('pin'), true)
    const stats = research.researchIndexStats()
    assert.equal(stats.pinnedDocs, 1)
    assert.ok(stats.pages <= 32)
  })
})

describe('v1.6 tabular text attachments', () => {
  test('a long CSV inlines only its head, is not indexed, and keeps its path', async () => {
    resetState()
    const rows = ['date,region,amount', ...Array.from({ length: 800 }, (_, i) => `2025-01-01,West,${i}`)].join('\n')
    const path = write('big.csv', rows)
    const { attachments: loaded } = await attachments.loadAttachmentPaths([path])
    const a = loaded[0]
    assert.equal(a.tabular, true)
    assert.equal(a.truncated, true)
    assert.equal(a.indexed, false)
    assert.equal(a.sourcePath, path)
    assert.equal(a.totalChars, rows.length)
    assert.ok((a.textContent ?? '').split('\n').length <= 25)
    assert.match(a.textContent ?? '', /^date,region,amount/)
  })
  test('a small CSV is inlined whole but still carries its path', async () => {
    const path = write('small.csv', 'a,b\n1,2\n')
    const { attachments: loaded } = await attachments.loadAttachmentPaths([path])
    assert.equal(loaded[0].textContent, 'a,b\n1,2\n')
    assert.equal(loaded[0].sourcePath, path)
    assert.equal(loaded[0].tabular, undefined)
  })
  test('an xlsx attaches as a data file with no inline text', async () => {
    const path = write('book.xlsx', 'PK not really a workbook')
    const { attachments: loaded } = await attachments.loadAttachmentPaths([path])
    assert.equal(loaded[0].dataFile, true)
    assert.equal(loaded[0].textContent, undefined)
    assert.equal(loaded[0].sourcePath, path)
  })
})
