import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  fingerprintChanged,
  mergeUnfocused,
  nextActivation,
  styleDelta,
  tabStop,
  FOCUS_STYLE_KEYS,
  TAB_BASELINE,
  TAB_RESOLVE,
  THEME_READ
} from '../scripts/h2h-traversal'

/**
 * Two holes the bench had in seven rounds, and the decisions that closed them.
 *
 * 1. No head-to-head run had ever captured dark theme. The render harness
 *    measures both, but every contrast figure this project published from a
 *    RECORDED RUN was light-theme only.
 * 2. The VC2 keyboard traversal walked up to the Settings button and stopped
 *    there, so the task's own question — can a keyboard user reach both settings
 *    the answer names — was unproven even for the round it was won in.
 *
 * The parts that can only be decided in a live layout are pinned in
 * test/tabTraverseCheck.ts against a real window; a mocked DOM would answer
 * from the mock. What is pinned here is the orchestration around them — which
 * is where the ordering bugs live — and the wiring, read out of the harness
 * sources and the task file, because exercising it for real needs a built app
 * and a live model.
 */

const ROOT = join(__dirname, '..', '..')
const captureSrc = readFileSync(join(ROOT, 'scripts', 'h2h-capture.ts'), 'utf-8')
const runnerSrc = readFileSync(join(ROOT, 'scripts', 'h2h-run.sh'), 'utf-8')
const setup = JSON.parse(
  readFileSync(join(ROOT, 'docs', 'head-to-head', 'task-setup.json'), 'utf-8')
) as {
  conventions: Record<string, string>
  tasks: Record<
    string,
    {
      variants?: Record<string, unknown>
      actions?: {
        type: string
        theme?: string
        label?: string
        within?: string
        exit?: string
        activate?: { match: string }[]
      }[]
    }
  >
}

describe('a route through the app, not a walk up to it', () => {
  const route = [{ match: '^Settings\\b' }, { match: '^Tools$' }]

  test('a pattern fires on the stop whose label it matches', () => {
    assert.deepEqual(nextActivation('Settings (⌘,)', route, 0)?.index, 0)
  })

  test('and not on any other stop', () => {
    assert.equal(nextActivation('Search conversations', route, 0), null)
    assert.equal(nextActivation('Export conversation as Markdown', route, 0), null)
  })

  test('a later pattern cannot fire before the one in front of it', () => {
    // "Tools" is reachable long before Settings is open — the sidebar and the
    // composer both carry controls a loose matcher would fire on. An unordered
    // route would send the traversal somewhere the task did not ask for and
    // still report the journey as taken.
    assert.equal(nextActivation('Tools', route, 0), null)
    assert.equal(nextActivation('Tools', route, 1)?.index, 1)
  })

  test('a route that has fully fired stops matching', () => {
    assert.equal(nextActivation('Settings (⌘,)', route, 2), null)
  })

  test('a stop with no label matches nothing', () => {
    assert.equal(nextActivation(null, route, 0), null)
  })

  test('an unparseable pattern is refused rather than thrown', () => {
    assert.equal(nextActivation('anything', [{ match: '([' }], 0), null)
  })

  test('both the sidebar variants of the Settings control are on the route', () => {
    // One variant carries aria-label="Settings", the other only
    // title="Settings (⌘,)". A pattern that matched one would silently miss
    // half the runs depending on whether the rail was collapsed.
    const settings = [{ match: '^Settings\\b' }]
    assert.ok(nextActivation('Settings', settings, 0))
    assert.ok(nextActivation('Settings (⌘,)', settings, 0))
  })
})

describe('an activation is decided by looking, not by assuming', () => {
  const base = { focusables: 35, overlay: false, overlayTextLength: 0 }

  test('a new surface opening counts', () => {
    assert.equal(fingerprintChanged(base, { ...base, overlay: true }), true)
  })

  test('so does a change in how many controls exist', () => {
    assert.equal(fingerprintChanged(base, { ...base, focusables: 81 }), true)
  })

  test('so does a tab switch inside an open surface', () => {
    const open = { focusables: 81, overlay: true, overlayTextLength: 1200 }
    assert.equal(fingerprintChanged(open, { ...open, overlayTextLength: 1750 }), true)
  })

  test('and a keypress that changed nothing is not reported as an activation', () => {
    assert.equal(fingerprintChanged(base, { ...base }), false)
  })
})

describe('every stop is measurable, or says it is not', () => {
  const focused = { outlineStyle: 'solid', outlineWidth: '2px', outlineColor: 'rgb(0, 105, 90)' }
  const unfocused = { outlineStyle: 'none', outlineWidth: '0px', outlineColor: 'rgba(0, 0, 0, 0)' }

  test('a reading taken before the walk is marked as such', () => {
    const [row] = mergeUnfocused([{ stop: 1, tag: 'button', focused, unfocused }], [])
    assert.equal(row.unfocusedSource, 'pre')
  })

  test('a control that appeared mid-walk is filled in from the post-walk pass', () => {
    // This is the case that made focus visibility undecidable inside the panel:
    // the element did not exist when the baseline ran, so it had no unfocused
    // reading at all, and every stop the task was actually about came back null.
    const [row] = mergeUnfocused(
      [{ stop: 7, tag: 'input', focused, unfocused: null }],
      [{ stop: 7, style: unfocused }]
    )
    assert.equal(row.unfocusedSource, 'post')
    assert.deepEqual(row.unfocused, unfocused)
  })

  test('an element the walk unmounted is recorded as unknown, never as "no difference"', () => {
    const [row] = mergeUnfocused(
      [{ stop: 9, tag: 'button', focused, unfocused: null }],
      [{ stop: 9, style: null }]
    )
    assert.equal(row.unfocusedSource, null)
    assert.equal(row.unfocused, null)
    // Scoring a missing measurement as a passing one is how a build wins a
    // dimension it was never measured on.
    assert.equal(row.styleDeltaKeys, null)
  })

  test('a Tab press that landed on nothing stays untouched', () => {
    const [row] = mergeUnfocused([{ stop: 3, tag: null }], [])
    assert.equal(row.unfocusedSource, undefined)
  })
})

describe('which properties moved, not merely that something did', () => {
  test('a drawn ring names the properties that draw it', () => {
    assert.deepEqual(
      styleDelta(
        { outlineStyle: 'solid', outlineWidth: '2px', outlineColor: 'rgb(0, 105, 90)' },
        { outlineStyle: 'none', outlineWidth: '0px', outlineColor: 'rgba(0, 0, 0, 0)' }
      ),
      ['outlineStyle', 'outlineWidth', 'outlineColor']
    )
  })

  test('a colour change on an outline that is not drawn names only the colour', () => {
    // "The two readings differ" scores this as a visible ring. It is not one.
    assert.deepEqual(
      styleDelta(
        { outlineStyle: 'none', outlineWidth: '0px', outlineColor: 'rgb(0, 105, 90)' },
        { outlineStyle: 'none', outlineWidth: '0px', outlineColor: 'rgba(0, 0, 0, 0)' }
      ),
      ['outlineColor']
    )
  })

  test('an identical pair names nothing', () => {
    const same = { outlineStyle: 'none', outlineWidth: '0px' }
    assert.deepEqual(styleDelta(same, { ...same }), [])
  })

  test('a ring that only changes colour is not confused with one that is absent', () => {
    // Recorded from a real run of this app: its inputs carry a permanent
    // 2px solid outline that is transparent until focus turns it teal. The
    // delta is one key in both cases, so a scorer needs the values too — which
    // is why both full states stay in the record beside the key list.
    assert.deepEqual(
      styleDelta(
        { outlineStyle: 'solid', outlineWidth: '2px', outlineColor: 'rgb(0, 105, 90)' },
        { outlineStyle: 'solid', outlineWidth: '2px', outlineColor: 'rgba(0, 0, 0, 0)' }
      ),
      ['outlineColor']
    )
  })
})

describe('the instruments carry what a critic has to compare', () => {
  test('both style states are recorded from the same property list', () => {
    for (const key of FOCUS_STYLE_KEYS) assert.ok(TAB_BASELINE.includes(key), key)
  })

  test('a stop records the surface it is on and whether anything is over it', () => {
    const src = tabStop(1)
    for (const field of ['surface', 'obscured', 'obscuredBy', 'matchesFocusVisible']) {
      assert.ok(src.includes(field), field)
    }
  })

  test('the walk is put back to the start of the document, not merely blurred', () => {
    // blur() alone leaves Chromium's sequential-focus starting point where the
    // focus was, and one run produced four traversals of one route that reached
    // Settings at stops 26, 8, 8 and 8.
    assert.ok(TAB_BASELINE.includes("setAttribute('tabindex', '-1')"))
    assert.ok(TAB_BASELINE.includes('document.body.focus()'))
    assert.ok(TAB_BASELINE.includes('startedFrom'))
  })

  test('and the attribute it borrows to do that is given back', () => {
    assert.ok(TAB_RESOLVE.includes("removeAttribute('tabindex')"))
  })

  test('a theme reading carries the setting, the class and a colour that rendered', () => {
    assert.ok(THEME_READ.includes('classList.contains'))
    assert.ok(THEME_READ.includes('backgroundColor'))
    assert.ok(THEME_READ.includes('overlay'))
  })
})

describe('the theme is changed the way the product changes it', () => {
  const themeCase = captureSrc.slice(
    captureSrc.indexOf("case 'theme': {"),
    captureSrc.indexOf("case 'tabTraverse': {")
  )

  test('through the app\'s own Settings panel, control by control', () => {
    for (const control of ["'^Settings\\\\b'", "'^General$'", "'^Save$'"]) {
      assert.ok(themeCase.includes(control), control)
    }
  })

  test('never by writing the setting behind the panel\'s back', () => {
    // The shortcut leaves the renderer's store holding the old theme, and the
    // Settings panel repaints from that stale value every time it opens or
    // closes. A run once walked four traversals labelled dark, two of which
    // were light, and only the witness below caught it.
    assert.ok(!themeCase.includes('setSettings('))
  })

  test('and the run fails rather than mislabelling a capture', () => {
    assert.ok(themeCase.includes('changed no rendered colour'))
    assert.ok(themeCase.includes('did not take theme'))
    assert.ok(themeCase.includes('did not close the Settings panel'))
  })

  test('a theme already in force is a no-op, not a failed Save', () => {
    assert.ok(themeCase.includes('nothing changed'))
  })
})

describe('the unfocused readings survive the way out', () => {
  test('the post-walk resolve runs before the exit unmounts the panel', () => {
    const traverse = captureSrc.slice(captureSrc.indexOf("case 'tabTraverse': {"))
    const resolveAt = traverse.indexOf('TAB_RESOLVE')
    const exitAt = traverse.indexOf('if (action.exit)')
    assert.ok(resolveAt > 0 && exitAt > 0)
    assert.ok(
      resolveAt < exitAt,
      'resolving after the exit returns null for every control inside the panel — the one place the reading was needed'
    )
  })

  test('an exit that could not be performed fails the action', () => {
    const traverse = captureSrc.slice(captureSrc.indexOf("case 'tabTraverse': {"))
    assert.ok(traverse.includes('is still open and the run would not be in the state the task describes'))
  })
})

describe('both themes reach a critic, and neither names an arm', () => {
  const vc2 = setup.tasks.VC2
  const vc3 = setup.tasks.VC3
  const themes = (id: 'VC2' | 'VC3'): string[] =>
    (setup.tasks[id].actions ?? []).filter((a) => a.type === 'theme').map((a) => String(a.theme))

  test('VC2 measures its traversals in light and in dark', () => {
    const labels = (vc2.actions ?? []).filter((a) => a.type === 'tabTraverse').map((a) => String(a.label))
    assert.ok(labels.some((l) => l.includes('light')), labels.join(','))
    assert.ok(labels.some((l) => l.includes('dark')), labels.join(','))
    assert.ok(themes('VC2').includes('dark'))
  })

  test('VC2 walks to each of the two settings its answer names', () => {
    const routes = (vc2.actions ?? [])
      .filter((a) => a.type === 'tabTraverse')
      .map((a) => (a.activate ?? []).map((s) => s.match).join(' → '))
    assert.ok(routes.some((r) => r.includes('Tools')), routes.join(' | '))
    assert.ok(routes.some((r) => r.includes('Models')), routes.join(' | '))
  })

  test('and every traversal closes what it opened', () => {
    const traversals = (vc2.actions ?? []).filter((a) => a.type === 'tabTraverse')
    assert.ok(traversals.length >= 4)
    // Settings → General renders "Sigma Oasis v<version>". A panel left open is
    // in every screenshot that follows, and a screenshot is the one artifact
    // make-blind-pairs cannot scrub.
    for (const t of traversals) assert.ok(t.exit, `${String(t.label)} declares no exit`)
  })

  test('VC3 measures the same reply in both themes', () => {
    const labels = (vc3.actions ?? [])
      .filter((a) => a.type === 'styles' || a.type === 'snapshot' || a.type === 'screenshot')
      .map((a) => String(a.label))
    assert.ok(labels.some((l) => l.endsWith('light')), labels.join(','))
    assert.ok(labels.some((l) => l.endsWith('dark')), labels.join(','))
  })

  test('VC3 records the computed styles a contrast ratio is computed from', () => {
    // A snapshot carries outerHTML and innerText, and neither says what colour
    // anything rendered in. Through round 7 there was nothing in a run
    // directory to compute VC3's own mechanicalChecks from.
    const styles = (vc3.actions ?? []).filter((a) => a.type === 'styles')
    assert.equal(styles.length, 4)
    // Two scopes per theme. The task names the last assistant message for its
    // prose count, and the "📖 From the library:" line specifically — and that
    // line sits on the retrieval turn, so a run whose follow-up consulted
    // nothing has no provenance line in its last message to measure.
    for (const theme of ['light', 'dark']) {
      const scopes = styles.filter((a) => String(a.label).endsWith(theme)).map((a) => a.within)
      assert.deepEqual(scopes.sort(), ['lastMessage', 'transcript'])
    }
  })

  test('both tasks put the theme back before the run takes its own artifacts', () => {
    for (const id of ['VC2', 'VC3'] as const) {
      const list = themes(id)
      assert.equal(list[list.length - 1], 'light', `${id} finishes in ${String(list[list.length - 1])}`)
    }
  })

  test('nothing new in a run directory is hidden from the blinding check', () => {
    // make-blind-pairs.mjs skips names starting with "_" and scrubs paths out
    // of .txt/.json/.jsonl/.md/.html. Every artifact these tasks add has to be
    // in the second set, not the first.
    const artifacts = [...(vc2.actions ?? []), ...(vc3.actions ?? [])]
      .filter((a) => ['tabTraverse', 'styles', 'snapshot'].includes(a.type))
      .map((a) => String(a.label))
    assert.ok(artifacts.length > 0)
    for (const name of artifacts) assert.ok(!name.startsWith('_'), name)
  })

  test('no task outside visual-craft declares a theme', () => {
    for (const [id, task] of Object.entries(setup.tasks)) {
      if (id.startsWith('VC')) continue
      assert.equal((task.actions ?? []).some((a) => a.type === 'theme'), false, id)
      assert.equal(task.variants, undefined, id)
    }
  })
})

describe('a variant names a real thing or the run does not happen', () => {
  test('VC1 keeps the whole-run themes, because its checks are geometric', () => {
    assert.deepEqual(Object.keys(setup.tasks.VC1.variants ?? {}), ['light', 'dark'])
  })

  test('the runner refuses a variant the task does not define', () => {
    // Otherwise --variant dark on a task with no dark variant captures the base
    // setup into a directory named "<id>-dark": a label that outruns its
    // measurement, which is the species this bench keeps finding in the product.
    assert.ok(runnerSrc.includes('refusing to capture it under a name it would not be'))
  })

  test('the convention says which question each mechanism answers', () => {
    assert.ok(setup.conventions.themes.includes('property of a MEASUREMENT'))
  })
})
