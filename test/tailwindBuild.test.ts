import { before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * What the Tailwind 4 build must keep (v4.7, M1).
 *
 * The migration from 3 was checked by screenshots of every scene before and
 * after, and by comparing every utility's computed style under both. Two of
 * the differences it found were invisible in a screenshot and would have
 * shipped: the minifier dropped the standard `backdrop-filter` from
 * `.glass-panel` (Chromium ignores the prefixed one, so every glass surface
 * lost its blur over backgrounds too smooth to show it), and v4's unitless
 * line heights shortened every small line inside a `text-xs` block. This pins
 * those and the other choices index.css's header explains, on the stylesheet
 * as the app's build makes it: the same plugin, minified.
 */

const REPO = join(__dirname, '..', '..')
const ENTRY = join(REPO, 'src/renderer/src/assets/index.css')

let source = ''
let css = ''

before(async () => {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const postcss = require('postcss') as typeof import('postcss')
  const tailwind = require('@tailwindcss/postcss')
  /* eslint-enable @typescript-eslint/no-var-requires */
  source = readFileSync(ENTRY, 'utf8')
  const out = await postcss([tailwind({ base: REPO, optimize: { minify: true } })]).process(source, { from: ENTRY })
  css = out.css
})

/** Innermost `selector { declarations }` pairs, comments removed. */
function rules(text: string): { selector: string; body: string }[] {
  const plain = text.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }))
}

/** A selector as the minifier writes it: no whitespace, one colon before a pseudo-element, an attribute value unquoted. */
const normal = (selector: string): string =>
  selector
    .replace(/\s+/g, '')
    .replace(/::/g, ':')
    .replace(/=(['"])([\w-]*)\1\]/g, '=$2]')

/** Whether a declaration block sets `prop` itself (not `-webkit-prop`). */
const declares = (body: string, prop: string): boolean => new RegExp(`(?:^|[;{\\s])${prop}:`).test(body)

describe('the Tailwind 4 build (v4.7, M1)', () => {
  test('every prefixed property the app pairs with the standard one keeps the standard one', () => {
    const pairs: { selector: string; prop: string }[] = []
    for (const r of rules(source)) {
      for (const m of r.body.matchAll(/-webkit-([a-z-]+)\s*:/g)) {
        if (declares(r.body, m[1]!)) pairs.push({ selector: r.selector, prop: m[1]! })
      }
    }
    assert.ok(pairs.length >= 8, `found ${pairs.length} prefixed/standard pairs in index.css`)
    const built = rules(css)
    for (const { selector, prop } of pairs) {
      const target = normal(selector)
      const matches = built.filter((r) => r.selector.split(',').map(normal).includes(target) || normal(r.selector) === target)
      assert.ok(matches.length > 0, `${selector} is missing from the built stylesheet`)
      assert.ok(
        matches.some((r) => declares(r.body, prop)),
        `${selector} lost its standard \`${prop}\` in the build — Chromium ignores \`-webkit-${prop}\` for some properties (backdrop-filter among them). Write the prefixed declaration first.`
      )
    }
  })

  test("the app's own CSS shares the utilities' layer and comes after them, so v3's specificity order holds", () => {
    const layers = [...css.matchAll(/@layer ([a-z]+)\{/g)].map((m) => m[1])
    assert.equal(layers.filter((l) => l === 'utilities').length, 1, `one utilities layer, found: ${layers.join(', ')}`)
    const open = css.indexOf('@layer utilities{')
    const utility = css.indexOf('.text-ink-primary{')
    const own = css.indexOf('.glass-panel{')
    assert.ok(open !== -1 && utility > open && own > utility, `utilities at ${utility}, .glass-panel at ${own}, layer opens at ${open}`)
  })

  test('the ink and accent tokens read their variables directly, so they follow the theme where .dark is set', () => {
    assert.match(css, /\.text-ink-primary\{color:var\(--text-primary\)\}/)
    assert.match(css, /\.text-ink-danger\{color:var\(--text-danger\)\}/)
    assert.match(css, /\.text-accent-ink\{color:var\(--accent-ink\)\}/)
  })

  test("the type scale's line heights are v3's lengths, which a smaller child inherits as they are", () => {
    for (const [size, lh] of [['xs', '1rem'], ['sm', '1.25rem'], ['base', '1.5rem'], ['lg', '1.75rem']]) {
      assert.match(css, new RegExp(`--text-${size}--line-height:${lh.replace('.', '\\.')}[;}]`), `text-${size}`)
    }
  })

  test("every raw palette step the app uses is v3's, which the contrast tests measured", () => {
    // v4 emits a theme variable only where something uses it, so this is the
    // set in use. A family not pinned in index.css's @theme comes out as v4's
    // OKLCH default — a colour no contrast test measured.
    const used = [...css.matchAll(/--color-([a-z]+-\d{2,3}):([^;}]+)/g)].map((m) => ({ name: m[1]!, value: m[2]! }))
    assert.ok(used.length >= 10, `${used.length} palette steps in use`)
    const unpinned = used.filter((u) => !/^#[0-9a-f]{3,8}$/i.test(u.value))
    assert.deepEqual(unpinned, [], `palette steps at v4's defaults — pin the family in index.css's @theme: ${unpinned.map((u) => u.name).join(', ')}`)
    assert.match(css, /--color-violet-600:#7c3aed[;}]/)
    assert.match(css, /--color-gray-200:#e5e7eb[;}]/)
  })

  test("only the renderer's own files are scanned, from any working directory", () => {
    assert.match(source, /@import 'tailwindcss' source\(none\);/)
    assert.match(source, /@source '\.\.\/\.\.\/index\.html';/)
    assert.match(source, /@source '\.\.\/\*\*\/\*\.\{ts,tsx\}';/)
  })

  test("v3's dark variant and hover behaviour, to the selector", () => {
    assert.match(css, /\.dark\\:bg-white\\\/10:is\(\.dark \*\)\{/)
    assert.ok(!/@media \(hover:hover\)/.test(css), 'hover: is wrapped in a hover media query again')
  })
})
