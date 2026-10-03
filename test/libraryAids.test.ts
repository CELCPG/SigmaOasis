import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { scoreLibrary } from '../src/renderer/src/lib/answerEval'
import {
  AIDS_KINDS,
  LIBRARY_SUITES,
  headroom,
  isSection,
  kindsFrom,
  librarySuiteFrom,
  sourceRank,
  splitRanks,
  type AidsCaseFields
} from '../src/main/agent/evalLibrarySuites'
import { load } from './harness'

/**
 * v4.5 (H5): the library-aids suite. It exists because re-rank and the sample answer run only for
 * a question inside the high-stakes domains, and 5 of the library suite's 28 are (4.4's G5
 * measured both as SAME-WITHIN-NOISE on a suite that could hardly show a gain). These tests pin
 * what makes the new suite able to: every question is inside the domains; each case's answer is
 * in exactly the section it names, and the sections that plausibly outrank it cannot answer it;
 * the forbidden advice is detectable. The fixtures are the ground truth the suite is measured
 * against, so they are pinned the way test/answerEval.test.ts pins the library suite's.
 */

const assist = load<typeof import('../src/main/ipc/library/modelAssist')>('library/modelAssist')
const lib = load<typeof import('../src/main/ipc/library')>('library')

const root = join(__dirname, '..', '..', 'test', 'fixtures', 'library-aids')
const casesDir = join(root, 'cases')
const packsDir = join(root, 'packs')

type Case = Partial<AidsCaseFields> & {
  file: string
  prompt: string
  pack: string
  mustInclude: string[]
  mustNotAssert?: string[]
  mustNotInclude?: string[]
  /** What a wrong-passage answer would say — kept so the forbidden patterns are tested to catch it. */
  unsafeReply?: string
}

function loadCases(): Case[] {
  return readdirSync(casesDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({ ...(JSON.parse(readFileSync(join(casesDir, file), 'utf-8')) as Case), file }))
}

/** The text of a `##` section of a fixture document, or null when the document or the heading is not there. */
function sectionText(pack: string, docId: string, heading: string): string | null {
  let text: string
  try {
    text = readFileSync(join(packsDir, pack, 'docs', `${docId}.md`), 'utf-8')
  } catch {
    return null
  }
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l === `## ${heading}`)
  if (start === -1) return null
  const end = lines.findIndex((l, i) => i > start && /^#{1,6} /.test(l))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

const packOfDoc = new Map<string, string>()
for (const pack of readdirSync(packsDir)) {
  for (const f of readdirSync(join(packsDir, pack, 'docs'))) packOfDoc.set(f.replace(/\.md$/, ''), pack)
}

const score = (reply: string, c: Case): ReturnType<typeof scoreLibrary> =>
  scoreLibrary(reply, { mustInclude: c.mustInclude, mustNotAssert: c.mustNotAssert, passages: '', titles: [] })

describe('the library-aids fixtures', () => {
  const cases = loadCases()

  test('at least 20 cases, in all four kinds, and a range of EVAL_CASES is a kind (the files run in kind order)', () => {
    assert.ok(cases.length >= 20, `${cases.length} cases`)
    for (const kind of AIDS_KINDS) assert.ok(cases.filter((c) => c.kind === kind).length >= 4, `${kind}: at least four`)
    assert.ok(cases.every((c) => (AIDS_KINDS as readonly string[]).includes(c.kind ?? '')), 'every case has a known kind')
    const order = cases.map((c) => c.kind!).filter((k, i, all) => i === 0 || k !== all[i - 1])
    assert.deepEqual(order, [...AIDS_KINDS], 'each kind is one contiguous run, in the order the suite lists them')
    assert.equal(new Set(cases.map((c) => c.prompt)).size, cases.length, 'no two cases ask the same question')
  })

  test('each case is well-formed: a question, a source section that exists, decoys that exist, patterns that compile', () => {
    for (const c of cases) {
      assert.equal(c.mustNotInclude, undefined, `${c.file}: mustNotInclude was replaced by mustNotAssert`)
      assert.ok(c.prompt && c.prompt.length > 15, `${c.file}: prompt`)
      assert.ok(Array.isArray(c.mustInclude) && c.mustInclude.length > 0, `${c.file}: mustInclude`)
      for (const p of [...c.mustInclude, ...(c.mustNotAssert ?? [])]) assert.doesNotThrow(() => new RegExp(p, 'i'), `${c.file}: bad pattern ${p}`)
      assert.ok(c.source, `${c.file}: names its source section`)
      assert.equal(packOfDoc.get(c.source!.doc), c.pack, `${c.file}: the source document is in the pack the case names`)
      assert.ok(sectionText(c.pack, c.source!.doc, c.source!.section), `${c.file}: source section "${c.source!.section}" is in ${c.source!.doc}`)
      assert.ok((c.decoys ?? []).length >= 2, `${c.file}: at least two sections that plausibly outrank the source`)
      for (const d of c.decoys ?? []) {
        assert.ok(packOfDoc.has(d.doc), `${c.file}: decoy document ${d.doc} exists`)
        assert.ok(sectionText(packOfDoc.get(d.doc)!, d.doc, d.section), `${c.file}: decoy section "${d.section}" is in ${d.doc}`)
        assert.ok(!(d.doc === c.source!.doc && d.section === c.source!.section), `${c.file}: the source is not its own decoy`)
      }
    }
  })

  test('every question is inside the high-stakes domains — the only questions the aids ever run for', () => {
    for (const c of cases) assert.ok(assist.stakesDomain(c.prompt), `${c.file}: no first-aid, health, building or finance trigger in "${c.prompt}"`)
  })

  test("a case's source section, said back, answers it and asserts nothing forbidden", () => {
    for (const c of cases) {
      const reply = sectionText(c.pack, c.source!.doc, c.source!.section)!
      const s = score(reply, c)
      assert.deepEqual(s.missing, [], `${c.file}: facts missing from its own source`)
      assert.deepEqual(s.forbidden, [], `${c.file}: its own source asserts a forbidden pattern`)
    }
  })

  test('no decoy answers a case alone — each is missing a required fact, so a wrong passage cannot pass for the right one', () => {
    const answering: string[] = []
    for (const c of cases) {
      for (const d of c.decoys ?? []) {
        if (score(sectionText(packOfDoc.get(d.doc)!, d.doc, d.section)!, c).answered) answering.push(`${c.file}: "${d.doc} › ${d.section}"`)
      }
    }
    assert.deepEqual(answering, [], 'decoys that answer the case they decoy')
  })

  test('the forbidden advice is caught: each case that names it keeps a reply that asserts it, and the pattern flags it', () => {
    const withForbidden = cases.filter((c) => (c.mustNotAssert ?? []).length > 0)
    assert.ok(withForbidden.length >= 5, `${withForbidden.length} cases name forbidden advice`)
    for (const c of withForbidden) {
      assert.ok(c.unsafeReply, `${c.file}: keeps an unsafeReply`)
      assert.ok(score(c.unsafeReply!, c).forbidden.length > 0, `${c.file}: the unsafe reply is not flagged`)
    }
  })

  test('the packs are well-formed: every document the manifest lists is a file, every file is listed, titles and sections are unique', () => {
    for (const pack of readdirSync(packsDir)) {
      const manifest = lib.validateManifest(JSON.parse(readFileSync(join(packsDir, pack, 'manifest.json'), 'utf-8')))
      assert.equal(manifest.id, pack)
      const files = readdirSync(join(packsDir, pack, 'docs')).sort()
      assert.deepEqual(manifest.docs.map((d) => d.file).sort(), files, `${pack}: manifest and docs agree`)
      assert.equal(new Set(manifest.docs.map((d) => d.title)).size, manifest.docs.length, `${pack}: titles are unique`)
      for (const d of manifest.docs) {
        const text = readFileSync(join(packsDir, pack, 'docs', d.file), 'utf-8')
        assert.match(text, new RegExp(`^# ${d.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), `${d.id}: its title is its H1`)
        const headings = text.split('\n').filter((l) => l.startsWith('## '))
        assert.equal(new Set(headings).size, headings.length, `${d.id}: section headings are unique`)
        assert.ok(headings.length >= 3, `${d.id}: at least three sections`)
      }
    }
  })

  test('the library suite is as it was: 28 cases, none carrying the new fields, over the built packs and .eval-library', () => {
    const dir = join(__dirname, '..', '..', 'test', 'fixtures', 'library')
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    assert.equal(files.length, 28)
    for (const f of files) {
      const fx = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Record<string, unknown>
      for (const k of ['kind', 'source', 'decoys']) assert.equal(fx[k], undefined, `${f}: ${k}`)
    }
    assert.deepEqual(LIBRARY_SUITES.library, { name: 'library', fixtures: 'test/fixtures/library', packs: 'packs', libDir: '.eval-library', refreshChangedPacks: false })
    assert.equal(LIBRARY_SUITES['library-aids'].libDir, '.eval-library-aids', 'its own library, so the 28 cases\' index is never touched')
  })
})

describe('choosing a library suite', () => {
  test('EVAL_SUITES names one of them, or neither; both at once would write two suites into one results block', () => {
    assert.equal(librarySuiteFrom(['library', 'quant', 'deliberate']), 'library')
    assert.equal(librarySuiteFrom(['library-aids']), 'library-aids')
    assert.equal(librarySuiteFrom(['quant', 'library-aids', 'deliberate']), 'library-aids')
    assert.equal(librarySuiteFrom(['quant']), null)
    assert.throws(() => librarySuiteFrom(['library', 'library-aids']), /one at a time/)
  })

  test('EVAL_LIBRARY_KIND names kinds of the aids suite; an unknown one is an error, none is all', () => {
    assert.equal(kindsFrom(undefined), null)
    assert.equal(kindsFrom(''), null)
    assert.deepEqual(kindsFrom('near-tie, vocabulary'), ['near-tie', 'vocabulary'])
    assert.throws(() => kindsFrom('near-tie,hard'), /not hard/)
  })
})

describe('reading where the source landed', () => {
  const p = (docId: string, section: string): { docId: string; section: string } => ({ docId, section })
  const source = { doc: 'fever-in-children', section: 'Babies younger than 3 months' }

  test('a rank is the 1-based place of the source section among the passages, 0 when it is not among them', () => {
    const passages = [p('fever-in-children', 'Fever seizures'), p('fever-in-children', 'Babies younger than 3 months'), p('medicine-cabinet-notes', 'Ibuprofen')]
    assert.equal(sourceRank(passages, source), 2)
    assert.equal(sourceRank(passages.slice(2), source), 0)
    assert.equal(sourceRank([], source), 0)
  })

  test('the section must be that document\'s: the same heading in another document, or another section of it, is not the source', () => {
    assert.equal(isSection(p('fever-in-children', 'babies younger than 3 months '), source), true, 'case and edge space do not matter')
    assert.equal(isSection(p('fever-and-flu-adults', 'Babies younger than 3 months'), source), false)
    assert.equal(isSection(p('fever-in-children', 'Fever seizures'), source), false)
  })

  test('the split counts first, top three, top five, within twelve and missed; headroom is second to fifth', () => {
    const s = splitRanks([1, 1, 2, 3, 4, 5, 7, 0, 12, 0])
    assert.deepEqual(s, { of: 10, top1: 2, top3: 4, top5: 6, top12: 8, missed: 2 })
    assert.equal(headroom([1, 1, 2, 3, 4, 5, 7, 0, 12, 0]), 4)
    assert.deepEqual(splitRanks([]), { of: 0, top1: 0, top3: 0, top5: 0, top12: 0, missed: 0 })
  })
})
