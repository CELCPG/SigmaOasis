/**
 * The guard that keeps the containment as wide as the class it guards.
 *
 * `modalFocusCheck` measures the overlays that exist today. It cannot fail on
 * the one somebody adds next week, and "every overlay contains focus" is the
 * kind of claim that decays silently — the app shipped four that did not, plus
 * a fifth (`BranchMenu`) that the traversal instrument's own `fixed inset-0 …
 * z-50` vocabulary could not even see, because its click-catcher is z-40.
 *
 * So the guard is written against the class rather than against the members.
 * A surface that covers the viewport to take interaction away from what is
 * under it is, in this codebase, `fixed inset-0` — no z-index, no component
 * name, no list of files. Every file that renders one must come through
 * `useModalSurface` (directly, or through `useModalPresence`, which wraps it)
 * and must attach the `surfaceRef` it hands back. Rounds 3–6 each lost to a
 * check that enumerated the forms it had already seen; this one enumerates
 * nothing.
 *
 * The pair of cases below is the standing requirement in docs/evals.md: a true
 * positive (a file that renders a covering surface without containing it is
 * named) beside a true negative (a file that renders no such surface, and a
 * `fixed` element that does not cover the viewport, are both silent).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// `..`, `..`: the tests run compiled, out of .test-build/test.
const RENDERER = join(__dirname, '..', '..', 'src', 'renderer', 'src')

/**
 * A surface that covers the viewport. Deliberately not `z-50`: the z-index is
 * how the app happens to stack them today, and `BranchMenu`'s catcher at z-40
 * covers the page exactly as completely.
 */
export const COVERING_SURFACE = /fixed\s+inset-0/

/** Comes through the shared hook, one way or the other. */
export const USES_SURFACE_HOOK = /useModalSurface|useModalPresence/

/** And actually attaches what the hook handed back. */
export const ATTACHES_SURFACE_REF = /ref=\{surfaceRef\}/

export interface SurfaceVerdict {
  file: string
  covers: boolean
  hooked: boolean
  attached: boolean
}

/** The verdict for one file's source. Exported so the cases can feed it prose. */
export function judgeSurface(file: string, source: string): SurfaceVerdict {
  return {
    file,
    covers: COVERING_SURFACE.test(source),
    hooked: USES_SURFACE_HOOK.test(source),
    attached: ATTACHES_SURFACE_REF.test(source)
  }
}

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full))
    else if (entry.endsWith('.tsx')) out.push(full)
  }
  return out
}

describe('modal surfaces · every covering surface contains focus', () => {
  it('names a covering surface that does not come through the hook', () => {
    const offender = judgeSurface(
      'Rogue.tsx',
      `export function Rogue() {
         return <div className="fixed inset-0 z-50 bg-black/50"><button>x</button></div>
       }`
    )
    assert.equal(offender.covers, true)
    assert.equal(offender.hooked, false, 'a surface with no containment hook must be named')
  })

  it('names a covering surface that takes the hook but never attaches the ref', () => {
    const offender = judgeSurface(
      'HalfDone.tsx',
      `import { useModalSurface } from '../hooks/useModalSurface'
       export function HalfDone() {
         const { dialogProps } = useModalSurface(true, { onDismiss: () => {} })
         return <div className="fixed inset-0 z-50"><div {...dialogProps} /></div>
       }`
    )
    assert.equal(offender.covers, true)
    assert.equal(offender.hooked, true)
    assert.equal(offender.attached, false, 'holding the ref is not attaching it')
  })

  it('is silent on a file with no covering surface', () => {
    const innocent = judgeSurface(
      'Plain.tsx',
      `export function Plain() { return <div className="relative flex"><button>x</button></div> }`
    )
    assert.equal(innocent.covers, false)
  })

  it('is silent on a fixed element that does not cover the viewport', () => {
    // A toast pinned to a corner is `fixed` and takes nothing away from the
    // page. Widening the pattern to bare `fixed` would flag it, and a check
    // that cries wolf gets ignored — round 4's lesson.
    const innocent = judgeSurface(
      'Toast.tsx',
      `export function Toast() { return <div className="fixed bottom-4 right-4 z-50">saved</div> }`
    )
    assert.equal(innocent.covers, false)
  })

  it('every covering surface in the renderer is contained', () => {
    const offenders = tsxFiles(RENDERER)
      .map((f) => judgeSurface(f, readFileSync(f, 'utf-8')))
      .filter((v) => v.covers && !(v.hooked && v.attached))
    assert.deepEqual(
      offenders.map((o) => o.file.slice(o.file.indexOf('src/renderer'))),
      [],
      'a covering surface that does not go through useModalSurface leaves the page behind it tabbable'
    )
  })

  it('finds the covering surfaces it is meant to be guarding', () => {
    // A pattern that matched nothing would pass the case above by finding no
    // offenders. The count is the floor, not the number: adding an overlay
    // must not have to come back here and edit a total.
    const covering = tsxFiles(RENDERER)
      .map((f) => judgeSurface(f, readFileSync(f, 'utf-8')))
      .filter((v) => v.covers)
    assert.ok(
      covering.length >= 5,
      `expected the five known covering surfaces, found ${covering.length}`
    )
  })
})
