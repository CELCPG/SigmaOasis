import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { load, resetState } from './harness'

/**
 * The curated packs checked in under packs/<id>/ (built by
 * scripts/build-packs.ts) must be installable by the shipped loader and must
 * carry provenance for every document. This is the regression net for a
 * rebuild: a source page that changed shape, an empty document, a missing
 * license, or a manifest the app can no longer read fails here, not on a
 * user's machine.
 *
 * Skipped when packs/ has no built packs (a fresh clone before the first
 * build), so the suite does not depend on network history.
 */

const lib = load<typeof import('../src/main/ipc/library')>('library')
const PACKS_DIR = join(__dirname, '..', '..', 'packs')

const packIds = existsSync(PACKS_DIR)
  ? readdirSync(PACKS_DIR).filter(
      (d) => d !== 'sources' && statSync(join(PACKS_DIR, d)).isDirectory() && existsSync(join(PACKS_DIR, d, 'manifest.json'))
    )
  : []

const root = mkdtempSync(join(tmpdir(), 'sigma-packs-'))

before(() => {
  resetState()
  rmSync(join(root, 'lib'), { recursive: true, force: true })
  lib.setLibraryDirForTests(join(root, 'lib'))
})

describe('curated packs', { skip: packIds.length === 0 ? 'no built packs in packs/' : false }, () => {
  test('there is a built pack for every source spec', () => {
    const specs = readdirSync(join(PACKS_DIR, 'sources')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
    for (const id of specs) assert.ok(packIds.includes(id), `packs/${id} not built`)
  })

  for (const id of packIds) {
    test(`${id}: manifest validates, every document exists, is substantial and carries provenance`, () => {
      const manifest = lib.validateManifest(JSON.parse(readFileSync(join(PACKS_DIR, id, 'manifest.json'), 'utf-8')))
      assert.equal(manifest.id, id)
      assert.equal(manifest.kind, 'curated')
      assert.ok(manifest.license && manifest.license !== 'unspecified', 'pack license')
      assert.ok(manifest.docs.length >= 8, `${manifest.docs.length} documents — a pack this thin is a build failure`)
      for (const d of manifest.docs) {
        const file = join(PACKS_DIR, id, 'docs', d.file)
        assert.ok(existsSync(file), `${d.id}: ${d.file} missing`)
        const text = readFileSync(file, 'utf-8')
        assert.ok(text.length >= 500, `${d.id}: only ${text.length} chars`)
        assert.match(text, /^# /, `${d.id}: no H1 for citations`)
        assert.ok(d.source && /^https?:\/\//.test(d.source), `${d.id}: no source URL`)
        assert.ok(d.license, `${d.id}: no license`)
        assert.ok(d.date, `${d.id}: no date`)
        assert.doesNotMatch(text, /Page not found|can't find the page|Page Not Found/i, `${d.id}: an error page was captured`)
      }
    })

    test(`${id}: installs and answers a lookup`, async () => {
      const summary = await lib.installPackFromDirectory(join(PACKS_DIR, id), { replace: true })
      assert.equal(summary.id, id)
      assert.ok(summary.chunks > summary.docs, 'documents chunk into more than one passage each on average')
      // The pack's own description names its subject; a lookup for it must hit.
      const words = summary.description.split(/\W+/).filter((w) => w.length > 5).slice(0, 6).join(' ')
      const out = await lib.lookupLibrary({ query: words, packId: id, topK: 3 })
      assert.equal(out.ok, true)
      assert.ok(out.passages.length > 0, `no passages for "${words}"`)
      assert.ok(out.passages.every((p) => p.source && p.license), 'passages carry provenance')
    })
  }
})
