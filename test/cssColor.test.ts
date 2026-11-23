import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { CSS_COLOR_PARSE_JS, parseCssColor } from './cssColor'

/** Within half a step of a byte, and alpha to three places. */
function near(actual: number[], expected: number[], tol = 0.5): void {
  assert.equal(actual.length, 4)
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(actual[i]! - expected[i]!) <= tol, `channel ${i}: ${actual[i]} vs ${expected[i]} (${actual.join(', ')})`)
  assert.ok(Math.abs(actual[3]! - expected[3]!) < 1e-3, `alpha: ${actual[3]} vs ${expected[3]}`)
}

describe('a computed CSS colour, read exactly (v4.7, M1)', () => {
  test('hex and the legacy rgb()/rgba() forms, as before', () => {
    near(parseCssColor('#00d4aa'), [0, 212, 170, 1])
    near(parseCssColor('#fff'), [255, 255, 255, 1])
    near(parseCssColor('#00000080'), [0, 0, 0, 128 / 255])
    near(parseCssColor('rgb(10, 20, 30)'), [10, 20, 30, 1])
    near(parseCssColor('rgba(255, 255, 255, 0.95)'), [255, 255, 255, 0.95])
    near(parseCssColor('rgb(10 20 30 / 0.5)'), [10, 20, 30, 0.5])
    near(parseCssColor('transparent'), [0, 0, 0, 0])
  })

  test("oklab() — what Tailwind 4's opacity modifiers compute to — converts to sRGB, minus signs and all", () => {
    near(parseCssColor('oklab(1 0 0)'), [255, 255, 255, 1])
    near(parseCssColor('oklab(0 0 0)'), [0, 0, 0, 1])
    // sRGB red, by Ottosson's published coordinates.
    near(parseCssColor('oklab(0.627955 0.224863 0.125846)'), [255, 0, 0, 1], 1)
    // sRGB blue: a negative b, which the old "first numbers" reading turned positive.
    near(parseCssColor('oklab(0.452014 -0.032457 -0.311528)'), [0, 0, 255, 1], 1)
    // The chip case: a colour at 15%, alpha after the slash.
    near(parseCssColor('oklab(0.627955 0.224863 0.125846 / 0.15)'), [255, 0, 0, 0.15], 1)
    // Percentages: L to 1, a and b to 0.4.
    near(parseCssColor('oklab(100% 0% 0%)'), [255, 255, 255, 1])
  })

  test('oklch() and color(srgb …) too', () => {
    near(parseCssColor('oklch(0.627955 0.257683 29.2339)'), [255, 0, 0, 1], 1)
    near(parseCssColor('color(srgb 1 0.5 0 / 0.25)'), [255, 127.5, 0, 0.25])
  })

  test('anything else is refused by name, never measured as something else', () => {
    assert.throws(() => parseCssColor('lab(50 20 30)'), /unsupported color function: lab\(50 20 30\)/)
    assert.throws(() => parseCssColor('color(display-p3 1 0 0)'), /unsupported color space/)
    assert.throws(() => parseCssColor('teal'), /unparseable color: teal/)
  })

  test('the page-script form is the same function, runnable on its own', () => {
    // eslint-disable-next-line no-new-func
    const parse = new Function(`${CSS_COLOR_PARSE_JS}; return parse`)() as typeof parseCssColor
    near(parse('oklab(0.452014 -0.032457 -0.311528)'), [0, 0, 255, 1], 1)
    near(parse('rgba(1, 2, 3, 0.5)'), [1, 2, 3, 0.5])
  })
})
