import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load, resetState, state } from './harness'
import { wasDeclined } from '../src/shared/tools/outcomes'

/**
 * v2.8: propose_patch. The model proposes, the reader decides on the diff,
 * the file is written only on Apply; the record carries the diff either way.
 */

const { fileHandlers } = load<typeof import('../src/main/ipc/toolHandlers/files')>('toolHandlers/files')

describe('propose_patch', () => {
  let dir = ''
  let seen: { path: string; isNew: boolean; diff: string }[] = []
  const ctx = (approve: boolean) => ({
    sender: {} as never,
    reviewPatch: async (r: { path: string; isNew: boolean; diff: string }) => {
      seen.push(r)
      return approve
    }
  })

  beforeEach(() => {
    resetState()
    seen = []
    dir = mkdtempSync(join(tmpdir(), 'sigma-patch-'))
    state.settings.workingDirectory = dir
    writeFileSync(join(dir, 'app.ts'), 'const limit = 5\nexport const name = "x"\n')
  })

  test('an applied edit writes the file and the result carries the diff and the counts', async () => {
    const r = await fileHandlers.propose_patch({ path: 'app.ts', edits: [{ search: 'const limit = 5', replace: 'const limit = 10' }] }, ctx(true))
    assert.ok(r.ok, r.error)
    assert.equal(readFileSync(join(dir, 'app.ts'), 'utf-8'), 'const limit = 10\nexport const name = "x"\n')
    assert.match(r.output ?? '', /^Applied to .*app\.ts: \+1 −1 in 1 hunk\.\n\n--- /)
    assert.match(r.output ?? '', /-const limit = 5\n\+const limit = 10/)
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.isNew, false)
  })

  test('a discarded patch writes nothing and says it was declined, diff attached', async () => {
    const r = await fileHandlers.propose_patch({ path: 'app.ts', edits: [{ search: 'const limit = 5', replace: 'const limit = 10' }] }, ctx(false))
    assert.equal(r.ok, false)
    assert.ok(wasDeclined(r.error ?? ''))
    assert.match(r.error ?? '', /\+const limit = 10/)
    assert.equal(readFileSync(join(dir, 'app.ts'), 'utf-8'), 'const limit = 5\nexport const name = "x"\n')
  })

  test('a new file is proposed as all additions, and written only on Apply', async () => {
    const r = await fileHandlers.propose_patch({ path: 'notes.md', content: '# Notes\n\n- one\n' }, ctx(true))
    assert.ok(r.ok)
    assert.match(r.output ?? '', /new file, 3 lines/)
    assert.equal(seen[0]!.isNew, true)
    assert.equal(readFileSync(join(dir, 'notes.md'), 'utf-8'), '# Notes\n\n- one\n')
    const d = await fileHandlers.propose_patch({ path: 'other.md', content: 'x\n' }, ctx(false))
    assert.equal(d.ok, false)
    assert.ok(!existsSync(join(dir, 'other.md')))
  })

  test('a bad edit is refused before any review; no change means no review', async () => {
    const bad = await fileHandlers.propose_patch({ path: 'app.ts', edits: [{ search: 'nope', replace: 'x' }] }, ctx(true))
    assert.equal(bad.ok, false)
    assert.match(bad.error ?? '', /not found/)
    const same = await fileHandlers.propose_patch({ path: 'app.ts', content: 'const limit = 5\nexport const name = "x"\n' }, ctx(true))
    assert.ok(same.ok)
    assert.match(same.output ?? '', /No change/)
    assert.equal(seen.length, 0)
    const neither = await fileHandlers.propose_patch({ path: 'app.ts' }, ctx(true))
    assert.equal(neither.ok, false)
  })

  test('the working-directory boundary still applies (the registry turns the throw into a readable error)', async () => {
    await assert.rejects(() => fileHandlers.propose_patch({ path: '/etc/hosts', content: 'x' }, ctx(true)), /outside the working directory/)
    assert.equal(seen.length, 0)
    rmSync(dir, { recursive: true, force: true })
  })
})
