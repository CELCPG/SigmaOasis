import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load, resetState } from './harness'
import { buildZim } from './zimFixture'

/**
 * v2.8: a ZIM file as a pack. Registered where it is; a lookup searches the
 * file's title index for the query's words, opens the articles it finds,
 * chunks them by section and ranks them beside the library's own passages —
 * with the passage's source naming the file and the article.
 */

const lib = load<typeof import('../src/main/ipc/library')>('library')

const ARTICLES = [
  { url: 'Burn', title: 'Burn', html: '<h1>Burn</h1><p>A burn is an injury to skin caused by heat.</p><h2>Treatment</h2><p>Cool the burn under cool running water for at least twenty minutes. Do not apply ice or butter.</p>' },
  { url: 'Nosebleed', title: 'Nosebleed', html: '<h1>Nosebleed</h1><p>Sit up, lean forward and pinch the soft part of the nose for ten minutes.</p>' },
  { url: 'Stroke', title: 'Stroke', html: '<h1>Stroke</h1><p>Face drooping, arm weakness, speech difficulty: time to call emergency services.</p>' }
]

describe('a ZIM pack in the library', () => {
  let dir = ''
  before(async () => {
    resetState()
    dir = mkdtempSync(join(tmpdir(), 'sigma-zimpack-'))
    lib.setLibraryDirForTests(join(dir, 'library'))
    writeFileSync(join(dir, 'firstaid.zim'), buildZim(ARTICLES, { compression: 'zstd', metadata: { Title: 'Tiny first aid', Description: 'three articles', Date: '2026-09' } }))
  })
  after(async () => {
    await lib.removePack('zim-firstaid')
    lib.setLibraryDirForTests(null)
    rmSync(dir, { recursive: true, force: true })
  })

  test('registering a file makes a pack named from the file, pointing at it, copying nothing', async () => {
    const summary = await lib.registerZimPack(join(dir, 'firstaid.zim'))
    assert.equal(summary.id, 'zim-firstaid')
    assert.equal(summary.kind, 'zim')
    assert.equal(summary.name, 'Tiny first aid')
    assert.equal(summary.description, 'three articles')
    assert.equal(summary.version, '2026-09')
    assert.equal(summary.zimPath, join(dir, 'firstaid.zim'))
    assert.equal(summary.docs, 7) // three articles and four metadata entries (Title, Language, Description, Date)
    assert.equal(summary.chars, 0)
    assert.equal(summary.chunks, 0)
  })

  test('a lookup opens the articles the title index finds and cites the file and the article', async () => {
    // The library's relevance floor wants two strong query terms in a passage;
    // a three-sentence fixture article has few words, so the query names two.
    const r = await lib.lookupLibrary({ query: 'burn under running water', topK: 3 })
    assert.ok(r.ok, r.error)
    assert.ok(r.passages.length >= 1, JSON.stringify(r.notes))
    const top = r.passages[0]!
    assert.equal(top.packId, 'zim-firstaid')
    assert.equal(top.packName, 'Tiny first aid')
    assert.equal(top.docId, 'Burn')
    assert.equal(top.source, 'firstaid.zim#Burn')
    assert.match(top.text, /running water/)
    assert.ok(r.passages.every((p) => p.docId !== 'Stroke'))
    // the model sees the citation line the library always prints
    const formatted = lib.formatLookup(r, 'burn under running water')
    assert.match(formatted, /\[1\] Tiny first aid › Burn/)
    assert.match(formatted, /source: firstaid\.zim#Burn/)
  })

  test('a query no title matches contributes nothing, and says so as any empty lookup does', async () => {
    const r = await lib.lookupLibrary({ query: 'quantum chromodynamics lattice', topK: 3 })
    assert.ok(r.ok)
    assert.equal(r.passages.length, 0)
  })

  test('the pack lists beside the others and removal leaves the file where it was', async () => {
    const packs = await lib.listPacks()
    assert.ok(packs.some((p) => p.id === 'zim-firstaid' && p.kind === 'zim'))
    const { removed } = await lib.removePack('zim-firstaid')
    assert.equal(removed, true)
    assert.ok(!(await lib.listPacks()).some((p) => p.id === 'zim-firstaid'))
    assert.ok(require('node:fs').existsSync(join(dir, 'firstaid.zim')))
    // register again so `after` has something to remove without error
    await lib.registerZimPack(join(dir, 'firstaid.zim'))
  })
})
