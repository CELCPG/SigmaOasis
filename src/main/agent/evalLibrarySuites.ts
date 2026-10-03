/**
 * v4.5 (H5): the library suites, and where the second one's cases come from.
 *
 * `eval:answers`' `library` suite is 28 questions over the curated packs in
 * `packs/`. Re-rank and the sample answer (library/modelAssist.ts, hyde.ts)
 * could not show a gain on it: they run only for a question inside the
 * high-stakes domains (`stakesDomain`: first aid, health, building, finance —
 * a keyword rule on the question), and 5 of the 28 are (02, 03, 06, 25, 26 —
 * the others never reach the aids: "boiling water on my forearm", "a stroke",
 * "a snake bite" carry no trigger word), none of them hard.
 *
 * `library-aids` is the suite built for them: every question inside the
 * domains, in four kinds where plain embedding-and-keyword ranking plausibly
 * leads with the wrong passage and an aid could put the right one first —
 *
 *   vocabulary      the question's words are not the document's ("burning up"
 *                   for a fever, "extra insurance the bank makes us pay" for PMI)
 *   paraphrase      an indirect or situational question ("keeps throwing up"
 *                   after a bump, "the allergy pill and the cold medicine")
 *   near-tie        two sections of one topic both fit and the right one names
 *                   the answer ("5 months" is not "under 3 months")
 *   multi-document  the answer is in a document whose title is not the
 *                   question's topic (the babysitter sheet, the inspection
 *                   report, the benefits guide)
 *
 * over three small packs written for it (`test/fixtures/library-aids/packs/`),
 * installed into a library of their own (`.eval-library-aids`) so the 28
 * cases' library, and the way they score, are untouched. A case names the
 * source section whose passage must be retrieved and cited (`source`) and the
 * sections that plausibly outrank it (`decoys`); the scorer is the library
 * suite's (`scoreLibrary`: answered, cited, forbidden).
 */

export type LibrarySuiteName = 'library' | 'library-aids'

export interface LibrarySuiteConfig {
  name: LibrarySuiteName
  /** Case fixtures, relative to the repository root. */
  fixtures: string
  /** Built or fixture packs installed for the suite. */
  packs: string
  /** The persistent throwaway library the suite installs into. */
  libDir: string
  /** Reinstall a pack whose source text no longer matches what is installed (fixture packs are edited; built packs are not). */
  refreshChangedPacks: boolean
}

export const LIBRARY_SUITES: Record<LibrarySuiteName, LibrarySuiteConfig> = {
  library: { name: 'library', fixtures: 'test/fixtures/library', packs: 'packs', libDir: '.eval-library', refreshChangedPacks: false },
  'library-aids': {
    name: 'library-aids',
    fixtures: 'test/fixtures/library-aids/cases',
    packs: 'test/fixtures/library-aids/packs',
    libDir: '.eval-library-aids',
    refreshChangedPacks: true
  }
}

/**
 * The library suite an `EVAL_SUITES` list names: `library`, `library-aids`, or
 * null. Both at once would write two suites into one results block (the one
 * `eval:diff` reads), so naming both is an error.
 */
export function librarySuiteFrom(want: string[]): LibrarySuiteName | null {
  const named = (Object.keys(LIBRARY_SUITES) as LibrarySuiteName[]).filter((s) => want.includes(s))
  if (named.length > 1) throw new Error(`EVAL_SUITES names two library suites (${named.join(', ')}): run them one at a time, each writes the results file's library block`)
  return named[0] ?? null
}

export const AIDS_KINDS = ['vocabulary', 'paraphrase', 'near-tie', 'multi-document'] as const
export type AidsKind = (typeof AIDS_KINDS)[number]

/** A section of a document: where a case's answer is, or what plausibly outranks it. */
export interface SectionRef {
  doc: string
  section: string
}

/** The fields `library-aids` cases carry beyond the library suite's (prompt, pack, mustInclude, mustNotAssert). */
export interface AidsCaseFields {
  kind: AidsKind
  source: SectionRef
  decoys: SectionRef[]
}

/** `EVAL_LIBRARY_KIND=vocabulary,near-tie`: the kinds to run; unset is all of them. */
export function kindsFrom(spec: string | undefined): AidsKind[] | null {
  const keys = (spec ?? '').split(',').map((k) => k.trim()).filter(Boolean)
  if (keys.length === 0) return null
  const unknown = keys.filter((k) => !(AIDS_KINDS as readonly string[]).includes(k))
  if (unknown.length) throw new Error(`EVAL_LIBRARY_KIND names ${AIDS_KINDS.join(', ')}, not ${unknown.join(', ')}`)
  return keys as AidsKind[]
}

/** The passage fields a rank is read from. */
export interface RankedPassage {
  docId: string
  section: string
}

const norm = (s: string): string => s.trim().toLowerCase()

/** Does the passage come from the referenced section of the referenced document? */
export function isSection(p: RankedPassage, ref: SectionRef): boolean {
  return p.docId === ref.doc && norm(p.section) === norm(ref.section)
}

/** The 1-based position of the case's source among the passages, in the order given; 0 when it is not among them. */
export function sourceRank(passages: RankedPassage[], source: SectionRef): number {
  const i = passages.findIndex((p) => isSection(p, source))
  return i === -1 ? 0 : i + 1
}

export interface RetrievalSplit {
  of: number
  top1: number
  top3: number
  top5: number
  /** Among the first twelve passages a lookup can return (the most it will). */
  top12: number
  /** Not among those at all. */
  missed: number
}

/** The split of a set of ranks (0 = not retrieved), as the dry check reports it. */
export function splitRanks(ranks: number[]): RetrievalSplit {
  const within = (n: number): number => ranks.filter((r) => r >= 1 && r <= n).length
  return { of: ranks.length, top1: within(1), top3: within(3), top5: within(5), top12: within(12), missed: ranks.filter((r) => r === 0).length }
}

/** Cases whose source is not first but is in the lookup's reach — the headroom an aid has. */
export function headroom(ranks: number[], reach = 5): number {
  return ranks.filter((r) => r > 1 && r <= reach).length
}
