import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { load, resetState, state } from './harness'

/**
 * The Almanac's foundation: pack format, install, load, hybrid lookup with
 * citations, persisted vectors, and the bounds. Everything here is offline —
 * the only "network" is the harness's fake loopback embedder.
 */

const lib = load<typeof import('../src/main/ipc/library')>('library')

const root = mkdtempSync(join(tmpdir(), 'sigma-library-'))
let counter = 0

/** Write a pack source directory and return its path. */
function writePack(
  id: string,
  docs: { id: string; title: string; text: string; file?: string; source?: string; date?: string; license?: string }[],
  overrides: Record<string, unknown> = {}
): string {
  const dir = join(root, `src-${id}-${counter++}`)
  mkdirSync(join(dir, 'docs'), { recursive: true })
  const manifest = {
    formatVersion: 1,
    id,
    name: `Pack ${id}`,
    description: 'test pack',
    version: '1',
    license: 'Public domain',
    kind: 'curated',
    docs: docs.map((d) => ({
      id: d.id,
      title: d.title,
      file: d.file ?? `${d.id}.md`,
      source: d.source,
      date: d.date,
      license: d.license
    })),
    ...overrides
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  for (const d of docs) writeFileSync(join(dir, 'docs', d.file ?? `${d.id}.md`), d.text)
  return dir
}

const FIRST_AID = `# First Aid Basics

## Bleeding

Apply firm direct pressure to the wound with a clean cloth. Elevate the limb above the heart if no fracture is suspected. Do not remove a dressing that has soaked through; add another on top.

## Burns

Cool a burn under cool running water for at least twenty minutes. Do not apply ice, butter or ointment. Cover loosely with a sterile, non-fluffy dressing.

## Choking

For a conscious adult who cannot cough, speak or breathe, give five back blows between the shoulder blades, then five abdominal thrusts. Alternate until the object is expelled.
`

const FINANCE = `# Compound growth

Money left in an account earning interest grows by the interest rate each period, applied to the new balance. The doctor's remuneration in the example doubles roughly every ten years at seven percent.

# Emergency fund

Keep three to six months of essential expenses in cash you can reach within a day.
`

beforeEach(() => {
  resetState()
  rmSync(join(root, 'lib'), { recursive: true, force: true })
  lib.setLibraryDirForTests(join(root, 'lib'))
})

describe('manifest validation', () => {
  test('a good manifest is normalized', () => {
    const m = lib.validateManifest({
      formatVersion: 1,
      id: 'first-aid',
      name: ' First aid ',
      docs: [{ id: 'fm', title: 'FM', file: 'fm.md' }]
    })
    assert.equal(m.name, 'First aid')
    assert.equal(m.kind, 'curated')
    assert.equal(m.docs[0].chars, 0)
    assert.equal(m.license, 'unspecified')
  })
  test('rejects wrong version, bad ids, traversal file names, duplicate docs', () => {
    assert.throws(() => lib.validateManifest({ formatVersion: 2, id: 'a-b', name: 'x', docs: [{ id: 'd', file: 'd.md' }] }), /format version/)
    assert.throws(() => lib.validateManifest({ formatVersion: 1, id: 'Bad Id', name: 'x', docs: [{ id: 'd', file: 'd.md' }] }), /Invalid pack id/)
    assert.throws(() => lib.validateManifest({ formatVersion: 1, id: 'ok-id', name: 'x', docs: [{ id: 'd', file: '../etc/passwd.md' }] }), /invalid file name/)
    assert.throws(() => lib.validateManifest({ formatVersion: 1, id: 'ok-id', name: 'x', docs: [{ id: 'd', file: 'd.exe' }] }), /invalid file name/)
    assert.throws(() => lib.validateManifest({ formatVersion: 1, id: 'ok-id', name: 'x', docs: [{ id: 'd', file: 'd.md' }, { id: 'd', file: 'e.md' }] }), /Duplicate/)
    assert.throws(() => lib.validateManifest({ formatVersion: 1, id: 'ok-id', name: 'x', docs: [] }), /no documents/)
  })
})

describe('install and list', () => {
  test('installs a pack by copying it, and lists it with counts', async () => {
    const src = writePack('first-aid', [{ id: 'basics', title: 'First Aid Basics', text: FIRST_AID, source: 'https://example.gov/fa', date: '2002' }])
    const summary = await lib.installPackFromDirectory(src)
    assert.equal(summary.id, 'first-aid')
    assert.equal(summary.docs, 1)
    assert.ok(summary.chunks >= 1)
    assert.equal(summary.embeddedChunks, 0)
    assert.ok(existsSync(join(root, 'lib', 'first-aid', 'manifest.json')))
    assert.ok(existsSync(join(root, 'lib', 'first-aid', 'docs', 'basics.md')))
    // The source can be deleted afterwards; the library keeps its copy.
    rmSync(src, { recursive: true, force: true })
    const listed = await lib.listPacks()
    assert.deepEqual(listed.map((p) => p.id), ['first-aid'])
    const written = JSON.parse(readFileSync(join(root, 'lib', 'first-aid', 'manifest.json'), 'utf-8'))
    assert.ok(written.docs[0].chars > 100, 'chars are filled at install')
  })

  test('refuses a duplicate id unless replacing', async () => {
    const src = writePack('dup', [{ id: 'a', title: 'A', text: 'alpha text here' }])
    await lib.installPackFromDirectory(src)
    await assert.rejects(lib.installPackFromDirectory(src), /already installed/)
    const again = await lib.installPackFromDirectory(src, { replace: true })
    assert.equal(again.id, 'dup')
  })

  test('a manifest naming a missing document is refused whole', async () => {
    const src = writePack('missing', [{ id: 'a', title: 'A', text: 'alpha' }])
    rmSync(join(src, 'docs', 'a.md'))
    await assert.rejects(lib.installPackFromDirectory(src), /missing/)
    assert.ok(!existsSync(join(root, 'lib', 'missing')), 'nothing half-installed')
  })

  test('remove deletes the directory and forgets the pack', async () => {
    await lib.installPackFromDirectory(writePack('gone', [{ id: 'a', title: 'A', text: 'alpha' }]))
    assert.deepEqual((await lib.removePack('gone')), { removed: true })
    assert.ok(!existsSync(join(root, 'lib', 'gone')))
    assert.deepEqual(await lib.listPacks(), [])
    assert.deepEqual(await lib.removePack('../escape'), { removed: false })
  })
})

describe('lookup', () => {
  test('finds the right section and cites pack › document › section', async () => {
    await lib.installPackFromDirectory(
      writePack('first-aid', [{ id: 'basics', title: 'First Aid Basics', text: FIRST_AID, source: 'https://example.gov/fa', license: 'Public domain' }])
    )
    const out = await lib.lookupLibrary({ query: 'how long should I cool a burn under water', topK: 3 })
    assert.equal(out.ok, true)
    assert.ok(out.passages.length > 0)
    const top = out.passages[0]
    assert.equal(top.packId, 'first-aid')
    assert.equal(top.docTitle, 'First Aid Basics')
    assert.match(top.text, /twenty minutes/)
    assert.equal(top.source, 'https://example.gov/fa')
    // v1.7 section-aware chunking: the burn answer lives in its own "Burns"
    // chunk and is cited as such. (Before, the whole small document was one
    // chunk labelled by its first inner heading — a burn question came back
    // citing "Bleeding".)
    assert.equal(top.section, 'Burns')
    assert.match(lib.citationOf(top), /^Pack first-aid › First Aid Basics › Burns · \d+% in$/)
    const text = lib.formatLookup(out, 'burn')
    assert.match(text, /\[1\] Pack first-aid › First Aid Basics/)
    assert.match(text, /source: https:\/\/example\.gov\/fa/)
    assert.match(text, /quote figures, dosages and steps/)
  })

  test('searches across packs and can be scoped to one', async () => {
    await lib.installPackFromDirectory(writePack('first-aid', [{ id: 'basics', title: 'First Aid Basics', text: FIRST_AID }]))
    await lib.installPackFromDirectory(writePack('finance', [{ id: 'growth', title: 'Growth', text: FINANCE }]))
    const all = await lib.lookupLibrary({ query: 'emergency fund months of expenses', topK: 2 })
    assert.equal(all.passages[0].packId, 'finance')
    const scoped = await lib.lookupLibrary({ query: 'emergency fund months of expenses', packId: 'first-aid', topK: 2 })
    assert.ok(scoped.passages.every((p) => p.packId === 'first-aid'))
    const missing = await lib.lookupLibrary({ query: 'x', packId: 'nope' })
    assert.equal(missing.ok, false)
    assert.match(missing.error ?? '', /No pack "nope"/)
  })

  test('an empty library and an empty query are honest, not errors', async () => {
    const empty = await lib.lookupLibrary({ query: 'anything' })
    assert.equal(empty.ok, true)
    assert.deepEqual(empty.passages, [])
    assert.ok(empty.notes.some((n) => /empty/.test(n)))
    assert.match(lib.formatLookup(empty, 'anything'), /do not invent a reference/)
    const blank = await lib.lookupLibrary({ query: '  ' })
    assert.equal(blank.ok, false)
  })

  test('is keyword-only until embedded, hybrid after — and semantic finds a synonym', async () => {
    await lib.installPackFromDirectory(writePack('finance', [{ id: 'growth', title: 'Growth', text: FINANCE }]))
    // "physician salary" shares no vocabulary with "doctor's remuneration"; the
    // fake embedder folds those synonyms, BM25 cannot.
    const before = await lib.lookupLibrary({ query: 'physician salary', topK: 1 })
    assert.equal(before.mode, 'keyword')
    assert.equal(before.passages.length, 0)

    const job = await lib.embedPack('finance')
    assert.equal(job.ok, true, job.error)
    assert.equal(job.embedded, job.total)
    assert.ok(existsSync(join(root, 'lib', 'finance', 'index.json')))

    const after = await lib.lookupLibrary({ query: 'physician salary', topK: 1 })
    assert.equal(after.mode, 'hybrid')
    assert.match(after.passages[0]?.text ?? '', /remuneration/)
  })

  test('persisted vectors survive a reload and are ignored for a different model', async () => {
    await lib.installPackFromDirectory(writePack('finance', [{ id: 'growth', title: 'Growth', text: FINANCE }]))
    await lib.embedPack('finance')
    // Simulate a restart: drop RAM state, keep the disk.
    lib.setLibraryDirForTests(join(root, 'lib'))
    const [pack] = await lib.listPacks()
    assert.equal(pack.embeddedChunks, pack.chunks)
    assert.equal(pack.embeddingModel, 'fake-embed')
    // A different embedding model: vectors are not used, retrieval stays keyword.
    state.settings = { ...state.settings, memory: { autoContext: true, topK: 3, embeddingModel: 'other-model' } }
    lib.setLibraryDirForTests(join(root, 'lib'))
    const [again] = await lib.listPacks()
    assert.equal(again.embeddedChunks, 0)
    assert.equal(again.embeddingModel, null)
  })

  test('embedding failure keeps keyword retrieval working and reports the error', async () => {
    await lib.installPackFromDirectory(writePack('first-aid', [{ id: 'basics', title: 'First Aid Basics', text: FIRST_AID }]))
    state.failEmbeddings = true
    const job = await lib.embedPack('first-aid')
    assert.equal(job.ok, false)
    assert.equal(job.embedded, 0)
    const out = await lib.lookupLibrary({ query: 'back blows abdominal thrusts', topK: 1 })
    assert.equal(out.mode, 'keyword')
    assert.match(out.passages[0].text, /back blows/)
  })
})

describe('user packs from a folder', () => {
  test('builds a pack from md/txt files, snapshots them, cites the original path', async () => {
    const folder = join(root, 'my-notes')
    mkdirSync(join(folder, 'sub'), { recursive: true })
    writeFileSync(join(folder, 'router.md'), '# Router\n\nThe router reboot procedure: hold reset for ten seconds.')
    writeFileSync(join(folder, 'sub', 'warranty.txt'), 'The washing machine warranty runs until March 2027.')
    writeFileSync(join(folder, 'photo.jpg'), 'not text')
    const summary = await lib.createPackFromFolder(folder, { name: 'Home notes' })
    assert.equal(summary.kind, 'user')
    assert.equal(summary.docs, 2)
    assert.match(summary.id, /^home-notes-[0-9a-f]{6}$/)
    const out = await lib.lookupLibrary({ query: 'washing machine warranty', topK: 1 })
    assert.match(out.passages[0].text, /March 2027/)
    assert.equal(out.passages[0].source, join(folder, 'sub', 'warranty.txt'))
    assert.equal(out.passages[0].docTitle, 'warranty')
    // Snapshot: editing the source does not change the library.
    writeFileSync(join(folder, 'sub', 'warranty.txt'), 'changed')
    const again = await lib.lookupLibrary({ query: 'washing machine warranty', topK: 1 })
    assert.match(again.passages[0].text, /March 2027/)
  })

  test('an empty folder is refused', async () => {
    const folder = join(root, 'empty-folder')
    mkdirSync(folder, { recursive: true })
    await assert.rejects(lib.createPackFromFolder(folder), /No \.md, \.txt or \.pdf/)
  })
})

describe('bundled curated packs (v1.7.1)', () => {
  // Two levels up: tests compile into .test-build/test/, not test/.
  const repoPacks = join(__dirname, '..', '..', 'packs')

  test('lists the real bundled tranche with install state', async () => {
    lib.setBundledPacksDirForTests(repoPacks)
    try {
      const bundled = await lib.listBundledPacks()
      assert.ok(bundled.length >= 7, `expected the 7-pack tranche, got ${bundled.length}`)
      assert.ok(bundled.every((b) => !b.installed), 'nothing is installed in a fresh library')
      assert.ok(bundled.some((b) => b.id === 'first-aid'))
      // sources/ is build specs, never a pack.
      assert.ok(!bundled.some((b) => b.id === 'sources'))
    } finally {
      lib.setBundledPacksDirForTests(null)
    }
  })

  test('installs a bundled pack, reports it installed, and serves lookups', async () => {
    lib.setBundledPacksDirForTests(repoPacks)
    try {
      const summary = await lib.installBundledPack('first-aid')
      assert.equal(summary.kind, 'curated')
      assert.ok(summary.docs > 0)
      const bundled = await lib.listBundledPacks()
      const fa = bundled.find((b) => b.id === 'first-aid')
      assert.equal(fa?.installed, true)
      assert.equal(fa?.installedVersion, fa?.version)
      const out = await lib.lookupLibrary({ query: 'how long to cool a burn under running water', topK: 2 })
      assert.equal(out.passages.length > 0, true)
      assert.equal(out.passages[0].packId, 'first-aid')
      // Re-install replaces in place rather than erroring.
      const again = await lib.installBundledPack('first-aid')
      assert.equal(again.docs, summary.docs)
    } finally {
      lib.setBundledPacksDirForTests(null)
    }
  })

  test('refuses an unknown or invalid id, and an empty dir lists nothing', async () => {
    lib.setBundledPacksDirForTests(repoPacks)
    try {
      await assert.rejects(lib.installBundledPack('no-such-pack'), /No bundled pack/)
      await assert.rejects(lib.installBundledPack('../escape'), /Invalid pack id/)
    } finally {
      lib.setBundledPacksDirForTests(null)
    }
    lib.setBundledPacksDirForTests(join(root, 'no-bundled-dir'))
    try {
      assert.deepEqual(await lib.listBundledPacks(), [])
    } finally {
      lib.setBundledPacksDirForTests(null)
    }
  })
})

describe('section-aware chunking (v1.7)', () => {
  const headingsOf = (text: string): { offset: number; title: string }[] => {
    const out: { offset: number; title: string }[] = []
    const re = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) out.push({ offset: m.index, title: m[2].trim() })
    return out
  }

  test('no chunk spans a heading boundary, and offsets are faithful', () => {
    const text = [
      '# Water',
      '',
      'Intro paragraph about water needs. '.repeat(20).trim(),
      '',
      '### Boiling',
      '',
      'Bring water to a rolling boil for one full minute. Let it cool before drinking.',
      '',
      '### Chlorination',
      '',
      'Add bleach and let stand for 30 minutes. '.repeat(30).trim(),
      '',
      '## Storage',
      '',
      'Replace stored water every six months.'
    ].join('\n')
    const headings = headingsOf(text)
    const chunks = lib.chunkDocumentSections(text, headings)
    assert.ok(chunks.length >= 4)
    for (const c of chunks) {
      assert.equal(text.slice(c.offset, c.offset + c.text.length), c.text, 'offset must locate the chunk text exactly')
      const end = c.offset + c.text.length
      for (const h of headings) {
        assert.ok(!(c.offset < h.offset && h.offset < end), `chunk [${c.offset},${end}) crosses heading "${h.title}" at ${h.offset}`)
      }
    }
    // The tiny Boiling section is its own crisp chunk, not blended into a neighbor.
    const boiling = chunks.find((c) => c.text.includes('rolling boil'))
    assert.ok(boiling)
    assert.match(boiling.text, /^### Boiling/)
    assert.ok(!boiling.text.includes('30 minutes'), 'boiling must not blend into chlorination')
  })

  test('a document with no headings chunks exactly as before', () => {
    const text = 'A sentence about nothing in particular. '.repeat(80).trim()
    const plain = lib.chunkDocumentSections(text, [])
    assert.ok(plain.length > 1)
    assert.equal(plain[0].offset, 0)
    for (const c of plain) assert.equal(text.slice(c.offset, c.offset + c.text.length), c.text)
  })

  test('one passage per section: twins from one section do not crowd out other sections', async () => {
    // One long section that chunks into several near-twin pieces sharing the
    // query vocabulary, plus two short sections that each hold a distinct fact.
    const doc = [
      '# Poisoning',
      '',
      '## What not to do',
      '',
      ('Do not make the person sick. Poisoning cases must never be treated by inducing vomiting. ' +
        'In a poisoning emergency stay calm and keep the poisoning victim still. ').repeat(18).trim(),
      '',
      '## Call 999 if',
      '',
      'Call 999 in a poisoning emergency if the person is unconscious or struggling to breathe.',
      '',
      '## Aftercare',
      '',
      'After a poisoning emergency keep the person under observation until help arrives.'
    ].join('\n')
    await lib.installPackFromDirectory(writePack('poison', [{ id: 'poisoning', title: 'Poisoning', text: doc }]))
    const out = await lib.lookupLibrary({ query: 'poisoning emergency what should I do', topK: 3 })
    assert.equal(out.passages.length, 3)
    const sections = out.passages.map((p) => p.section)
    assert.equal(new Set(sections).size, 3, `sections must be distinct, got ${sections.join(' / ')}`)
    assert.ok(sections.includes('Call 999 if'), `the 999 section must not be crowded out (got ${sections.join(' / ')})`)
  })

  test('one passage per section: a single-section corpus still fills topK', async () => {
    const doc = ['# Only topic', '', ('One long section about generator safety and carbon monoxide. ').repeat(60).trim()].join('\n')
    await lib.installPackFromDirectory(writePack('gen', [{ id: 'gen', title: 'Generators', text: doc }]))
    const out = await lib.lookupLibrary({ query: 'generator safety carbon monoxide', topK: 3 })
    assert.equal(out.passages.length, 3, 'displaced same-section chunks must return when nothing else exists')
  })

  test('lookup surfaces the small answering section over a wordy neighbor', async () => {
    const WATER = [
      '# Water treatment',
      '',
      '### Boiling',
      '',
      'Boiling is the safest method of treating water. Bring water to a rolling boil for one full minute.',
      '',
      '### Chlorination',
      '',
      ('You can use household liquid bleach to kill microorganisms in water. Add bleach to the water, stir and ' +
        'let the water stand for 30 minutes. The water should have a slight bleach odor. ').repeat(6).trim()
    ].join('\n')
    await lib.installPackFromDirectory(writePack('prep', [{ id: 'water', title: 'Water', text: WATER }]))
    const out = await lib.lookupLibrary({ query: 'rolling boil water minute', topK: 1 })
    assert.match(out.passages[0].text, /rolling boil/)
    assert.equal(out.passages[0].section, 'Boiling')
    assert.ok(!out.passages[0].text.includes('30 minutes'))
  })
})

describe('user packs · update from folder (v1.7)', () => {
  let n = 0
  /** A fresh folder with two documents; returns paths and the created pack. */
  async function tracked(): Promise<{ folder: string; id: string }> {
    const folder = join(root, `tracked-${n++}`)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'boiler.md'), '# Boiler\n\nThe boiler pilot light relights by holding the ignition button for thirty seconds.')
    writeFileSync(join(folder, 'lease.txt'), 'The lease permits subletting with sixty days written notice to the landlord.')
    const summary = await lib.createPackFromFolder(folder, { name: 'Home papers' })
    return { folder, id: summary.id }
  }
  const indexOf = (id: string): { embeddingModel: string; docs: Record<string, { chunkCount: number; vectors: string }> } =>
    JSON.parse(readFileSync(join(root, 'lib', id, 'index.json'), 'utf-8'))

  test('records the source folder and per-document stat', async () => {
    const { folder, id } = await tracked()
    const manifest = JSON.parse(readFileSync(join(root, 'lib', id, 'manifest.json'), 'utf-8'))
    assert.equal(manifest.sourceFolder, folder)
    for (const d of manifest.docs) {
      assert.equal(typeof d.sourceMtime, 'number')
      assert.equal(typeof d.sourceSize, 'number')
    }
  })

  test('update reflects edits; unchanged documents keep their vectors, edited ones lose them', async () => {
    const { folder, id } = await tracked()
    await lib.embedPack(id)
    const before = indexOf(id)
    assert.equal(Object.keys(before.docs).length, 2)

    writeFileSync(join(folder, 'lease.txt'), 'The lease permits subletting with ninety days written notice to the landlord.')
    const r = await lib.updatePackFromFolder(id)
    assert.equal(r.pack.docs, 2)
    assert.ok(r.carriedChunks > 0, 'the unchanged boiler doc must carry its vectors')
    assert.ok(r.missingChunks > 0, 'the edited lease must need re-embedding')
    const after = indexOf(id)
    assert.deepEqual(Object.keys(after.docs), ['boiler'])
    assert.equal(after.docs.boiler.vectors, before.docs.boiler.vectors)

    // The library serves the new text at once (keyword), and the summary is honest.
    const out = await lib.lookupLibrary({ query: 'subletting written notice landlord', topK: 1 })
    assert.match(out.passages[0].text, /ninety days/)
    const [pack] = await lib.listPacks()
    assert.equal(pack.embeddedChunks, r.carriedChunks)
    // Finishing the embed only has to pay for the edited document.
    const job = await lib.embedPack(id)
    assert.equal(job.ok, true, job.error)
    assert.equal(job.embedded, job.total)
  })

  test('a renamed file keeps its vectors — matching is by content, not name', async () => {
    const { folder, id } = await tracked()
    await lib.embedPack(id)
    rmSync(join(folder, 'lease.txt'))
    writeFileSync(join(folder, 'rental-agreement.txt'), 'The lease permits subletting with sixty days written notice to the landlord.')
    const r = await lib.updatePackFromFolder(id)
    assert.equal(r.missingChunks, 0, 'identical text under a new name must not need re-embedding')
    const after = indexOf(id)
    assert.ok(after.docs['rental-agreement'], 'vectors live under the new doc id')
    const out = await lib.lookupLibrary({ query: 'subletting written notice landlord', topK: 1 })
    assert.equal(out.passages[0].docTitle, 'rental-agreement')
  })

  test('added and removed files are reflected', async () => {
    const { folder, id } = await tracked()
    rmSync(join(folder, 'boiler.md'))
    writeFileSync(join(folder, 'warranty.txt'), 'The dishwasher warranty covers parts and labour for two years from delivery.')
    const r = await lib.updatePackFromFolder(id)
    assert.equal(r.pack.docs, 2)
    const found = await lib.lookupLibrary({ query: 'dishwasher warranty parts labour', topK: 1 })
    assert.match(found.passages[0].text, /two years/)
    const gone = await lib.lookupLibrary({ query: 'boiler pilot light ignition', topK: 1 })
    assert.equal(gone.passages.length, 0)
  })

  test('refusals: curated packs, untracked packs, a vanished folder', async () => {
    await lib.installPackFromDirectory(writePack('first-aid', [{ id: 'basics', title: 'B', text: FIRST_AID }]))
    await assert.rejects(lib.updatePackFromFolder('first-aid'), /curated pack/)
    // A pre-v1.7 user pack: strip sourceFolder from the manifest.
    const { folder, id } = await tracked()
    const mPath = join(root, 'lib', id, 'manifest.json')
    const m = JSON.parse(readFileSync(mPath, 'utf-8'))
    delete m.sourceFolder
    writeFileSync(mPath, JSON.stringify(m))
    lib.setLibraryDirForTests(join(root, 'lib'))
    await assert.rejects(lib.updatePackFromFolder(id), /before folder tracking/)
    // Tracked, but the folder is gone.
    const second = await tracked()
    rmSync(second.folder, { recursive: true })
    await assert.rejects(lib.updatePackFromFolder(second.id), /no longer exists/)
    void folder
  })

  test('freshness: fresh after create; edits, additions and removals are counted', async () => {
    const { folder, id } = await tracked()
    assert.deepEqual(await lib.checkPackFreshness(id), {
      supported: true, fresh: true, missingFolder: false, added: 0, removed: 0, changed: 0, examples: []
    })
    writeFileSync(join(folder, 'lease.txt'), 'A different lease text entirely, with a different length.')
    writeFileSync(join(folder, 'new-doc.md'), '# New\n\nA new document.')
    rmSync(join(folder, 'boiler.md'))
    const report = await lib.checkPackFreshness(id)
    assert.equal(report.fresh, false)
    assert.equal(report.changed, 1)
    assert.equal(report.added, 1)
    assert.equal(report.removed, 1)
    assert.ok(report.examples.length > 0)
    // After an update the report is clean again.
    await lib.updatePackFromFolder(id)
    assert.equal((await lib.checkPackFreshness(id)).fresh, true)
  })

  test('freshness: unsupported for curated packs, missing folder is named', async () => {
    await lib.installPackFromDirectory(writePack('first-aid', [{ id: 'basics', title: 'B', text: FIRST_AID }]))
    assert.equal((await lib.checkPackFreshness('first-aid')).supported, false)
    const { folder, id } = await tracked()
    rmSync(folder, { recursive: true })
    const report = await lib.checkPackFreshness(id)
    assert.equal(report.supported, true)
    assert.equal(report.missingFolder, true)
    assert.equal(report.fresh, false)
  })
})

describe('bounds', () => {
  test('a document over the per-document cap is refused at install', async () => {
    const src = writePack('big', [{ id: 'huge', title: 'Huge', text: 'x'.repeat(lib.MAX_DOC_CHARS + 1) }])
    await assert.rejects(lib.installPackFromDirectory(src), /longer than/)
  })
  test('stats reflect what is loaded', async () => {
    await lib.installPackFromDirectory(writePack('first-aid', [{ id: 'basics', title: 'B', text: FIRST_AID }]))
    await lib.lookupLibrary({ query: 'burn' })
    const stats = lib.libraryStats()
    assert.equal(stats.packs, 1)
    assert.equal(stats.docs, 1)
    assert.ok(stats.chunks >= 1)
    assert.ok(stats.chars > 100)
  })
})

describe('relevance floor', () => {
  test('a question with no real overlap returns nothing, not a lone 1.00', async () => {
    await lib.installPackFromDirectory(writePack('first-aid', [{ id: 'basics', title: 'First Aid Basics', text: FIRST_AID }]))
    const out = await lib.lookupLibrary({ query: 'how much change from twenty dollars ignoring tax', topK: 3 })
    assert.equal(out.ok, true)
    assert.deepEqual(out.passages, [])
    assert.ok(out.notes.some((n) => /closely enough|No passage/.test(n)))
  })
  test('a real match still comes through', async () => {
    await lib.installPackFromDirectory(writePack('first-aid', [{ id: 'basics', title: 'First Aid Basics', text: FIRST_AID }]))
    const out = await lib.lookupLibrary({ query: 'running water burn', topK: 3 })
    assert.ok(out.passages.length > 0)
  })
})
