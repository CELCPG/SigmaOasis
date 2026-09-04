import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ZimFile, contentNamespace, htmlToText } from '../src/main/ipc/zim'
import { buildZim } from './zimFixture'

/**
 * v2.8: the ZIM reader, against files the test built itself — one
 * uncompressed, one zstd — so the header, the two pointer lists, redirects,
 * metadata, the cluster/blob arithmetic and the title search are all read
 * from bytes and not from a mock.
 */

const ARTICLES = [
  { url: 'Burn', title: 'Burn', html: '<html><body><h1>Burn</h1><p>A burn is an injury to skin. Cool the burn under running water for 20 minutes.</p><h2>Treatment</h2><p>Do not apply ice or butter.</p></body></html>' },
  { url: 'Burn_(disambiguation)', title: 'Burn (disambiguation)', html: '<p>Burn may refer to several things.</p>' },
  { url: 'Nosebleed', title: 'Nosebleed', html: '<p>Pinch the soft part of the nose for 10 minutes &amp; lean forward.</p>' },
  { url: 'Epistaxis', title: 'Epistaxis', html: '', redirectTo: 'Nosebleed' },
  { url: 'Anaphylaxis', title: 'Anaphylaxis', html: '<p>Use an adrenaline auto-injector &#8211; then call emergency services.</p><script>alert(1)</script>' }
]

describe('the ZIM reader', () => {
  let dir = ''
  let plain: ZimFile
  let zstd: ZimFile
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sigma-zim-'))
    writeFileSync(join(dir, 'plain.zim'), buildZim(ARTICLES, { metadata: { Title: 'Tiny first aid', Description: 'five articles' } }))
    writeFileSync(join(dir, 'zstd.zim'), buildZim(ARTICLES, { compression: 'zstd', metadata: { Title: 'Tiny first aid (zstd)' } }))
    plain = await ZimFile.open(join(dir, 'plain.zim'))
    zstd = await ZimFile.open(join(dir, 'zstd.zim'))
  })
  after(async () => {
    await plain.close()
    await zstd.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('the header and metadata read back; a non-ZIM is refused by its magic', async () => {
    assert.equal(plain.header.majorVersion, 6)
    // five articles plus the M entries: Title, Language, Description
    assert.equal(plain.header.entryCount, ARTICLES.length + 3)
    assert.equal(contentNamespace(plain.header), 'C')
    assert.equal(await plain.metadata('Title'), 'Tiny first aid')
    assert.equal(await plain.metadata('Description'), 'five articles')
    assert.equal(await plain.metadata('Nope'), null)
    writeFileSync(join(dir, 'not.zim'), Buffer.from('hello world, definitely not a zim file, padded out to eighty bytes and then some more'))
    await assert.rejects(() => ZimFile.open(join(dir, 'not.zim')), /Not a ZIM file/)
  })

  test('an article is found by url, its HTML becomes text with headings kept', async () => {
    for (const z of [plain, zstd]) {
      const e = await z.findByUrl('C', 'Burn')
      assert.ok(e)
      assert.equal(e!.mimetype, 'text/html')
      const { title, text } = await z.articleText(e!)
      assert.equal(title, 'Burn')
      assert.match(text, /^# Burn\n\nA burn is an injury to skin\. Cool the burn under running water for 20 minutes\.\n\n## Treatment\n\nDo not apply ice or butter\.$/)
    }
  })

  test('a redirect resolves to its target; entities decode; scripts are dropped', async () => {
    const e = await zstd.findByUrl('C', 'Epistaxis')
    assert.ok(e && e.redirectIndex !== undefined)
    const { title, text } = await zstd.articleText(e!)
    assert.equal(title, 'Nosebleed')
    assert.match(text, /nose for 10 minutes & lean forward/)
    const a = await plain.articleText((await plain.findByUrl('C', 'Anaphylaxis'))!)
    assert.match(a.text, /auto-injector – then call/)
    assert.ok(!a.text.includes('alert'))
  })

  test('a title prefix search returns the matches in title order, within the namespace', async () => {
    const hits = await plain.searchTitles('Burn', 'C', 10)
    assert.deepEqual(hits.map((h) => h.title), ['Burn', 'Burn (disambiguation)'])
    assert.deepEqual((await zstd.searchTitles('Nose', 'C')).map((h) => h.title), ['Nosebleed'])
    assert.deepEqual(await zstd.searchTitles('Zzz', 'C'), [])
    // metadata lives in M and never surfaces as an article
    assert.deepEqual(await plain.searchTitles('Title', 'C'), [])
  })

  test('htmlToText keeps lists and paragraphs readable', () => {
    assert.equal(htmlToText('<ul><li>one</li><li>two</li></ul><p>done</p>'), '- one\n- two\n\ndone')
  })
})
