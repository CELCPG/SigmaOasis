import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { latexToPlainText } from '../src/renderer/src/lib/mathPlaintext'

/**
 * The transform is pure string logic and every regression here is a silent
 * display corruption (readers see raw $...$ again, or worse, currency gets
 * mangled), so the exact outputs are pinned.
 */

describe('latexToPlainText — the cases that broke the UI', () => {
  test('unit markup renders as readable text', () => {
    assert.equal(latexToPlainText('about $374^\\circ\\text{C}$'), 'about 374°C')
    assert.equal(latexToPlainText('$214 \\text{ atm}$'), '214 atm')
    assert.equal(latexToPlainText('symbol $\\text{F}$'), 'symbol F')
  })

  test('arrows become Unicode arrows', () => {
    assert.equal(latexToPlainText('House $\\rightarrow$ Senate'), 'House → Senate')
    assert.equal(latexToPlainText('$a \\to b$'), 'a → b')
  })

  test('the escaped-dollar mess from the transcript resolves to currency', () => {
    assert.equal(latexToPlainText('$\\text{\\$20}$'), '$20')
  })

  test('display math converts and drops the $$ fences', () => {
    assert.equal(latexToPlainText('$$E = mc^2$$').trim(), 'E = mc²')
    assert.equal(latexToPlainText('\\[x + y\\]').trim(), 'x + y')
    assert.equal(latexToPlainText('\\(\\alpha + \\beta\\)'), 'α + β')
  })
})

describe('latexToPlainText — common TeX constructs', () => {
  test('fractions', () => {
    assert.equal(latexToPlainText('$\\frac{1}{2}$'), '1/2')
    assert.equal(latexToPlainText('$\\frac{a+b}{c}$'), '(a+b)/c')
  })

  test('super- and subscripts use Unicode where possible', () => {
    assert.equal(latexToPlainText('$x^{2}$'), 'x²')
    assert.equal(latexToPlainText('$x^2$'), 'x²')
    assert.equal(latexToPlainText('$H_2O$'), 'H₂O')
    assert.equal(latexToPlainText('$2^{10}$'), '2¹⁰')
  })

  test('scripts without a Unicode form fall back to explicit notation', () => {
    assert.equal(latexToPlainText('$e^{i\\theta}$'), 'e^(iθ)')
  })

  test('roots and greek letters', () => {
    assert.equal(latexToPlainText('$\\sqrt{2}$'), '√(2)')
    assert.equal(latexToPlainText('$\\pi \\approx 3.14$'), 'π ≈ 3.14')
  })

  test('comparison and operator symbols', () => {
    assert.equal(latexToPlainText('$a \\leq b \\times c$'), 'a ≤ b × c')
  })
})

describe('latexToPlainText — things that must not change', () => {
  test('currency with two dollar signs is left alone', () => {
    assert.equal(latexToPlainText('It costs $20 and saves $30.'), 'It costs $20 and saves $30.')
  })

  test('a single dollar amount is untouched', () => {
    assert.equal(latexToPlainText('That will be $20, please.'), 'That will be $20, please.')
  })

  test('plain text without any math passes through', () => {
    const text = 'Water boils at 212°F at sea level.'
    assert.equal(latexToPlainText(text), text)
  })

  test('inline code is protected', () => {
    assert.equal(latexToPlainText('run `echo $HOME` in bash'), 'run `echo $HOME` in bash')
  })

  test('fenced code blocks are protected', () => {
    const code = '```sh\nprice=$((x * 2))\n```'
    assert.equal(latexToPlainText(`try:\n${code}\ndone`), `try:\n${code}\ndone`)
  })

  test('an unclosed dollar is left as-is', () => {
    assert.equal(latexToPlainText('price is $5'), 'price is $5')
  })
})

/**
 * Every string here is copied out of a captured head-to-head run (docs/evals.md,
 * task V3) where the raw markdown carried the dollars and the screen did not.
 * The pairs are pinned verbatim, both halves, because the failure was silent:
 * the reply still read as a fluent sentence, so nothing flagged it except the
 * grounding warning naming figures no reader could find.
 */
describe('latexToPlainText — currency that inline math used to swallow', () => {
  test('an approximation tilde does not pair two prices into one math span', () => {
    // "~" made looksLikeMath accept the whole clause; texToPlain then dropped
    // the "~", and its trailing trim took the space before the second figure.
    assert.equal(
      latexToPlainText("at $0.01 per gallon that's ~$36/year"),
      "at $0.01 per gallon that's ~$36/year"
    )
  })

  test('a price range survives', () => {
    assert.equal(latexToPlainText('often a $5–$10 part'), 'often a $5–$10 part')
    assert.equal(
      latexToPlainText('The repair usually costs $5–$20 for parts.'),
      'The repair usually costs $5–$20 for parts.'
    )
    assert.equal(
      latexToPlainText('A plumber would charge $150–$400+ for labor alone.'),
      'A plumber would charge $150–$400+ for labor alone.'
    )
  })

  test('every dollar in the captured reply reaches the output', () => {
    const raw = [
      'The repair usually costs **$5–$20 for parts** and takes 30–60 minutes.',
      'A plumber would charge $150–$400+ for labor alone.',
      'A $10–$20 repair kit usually covers all sizes.'
    ].join('\n')
    const count = (s: string): number => (s.match(/\$/g) ?? []).length
    assert.equal(count(raw), 6)
    assert.equal(count(latexToPlainText(raw)), 6)
  })

  test('a figure separated from prose by a TeX marker is still not math', () => {
    assert.equal(latexToPlainText('Costs $3 for foo_bar and $9 total.'), 'Costs $3 for foo_bar and $9 total.')
    assert.equal(latexToPlainText('It costs $3 per unit^2 and $9 total.'), 'It costs $3 per unit^2 and $9 total.')
  })

  test('a tilde inside a genuine single-token span still converts', () => {
    // Tightening the marker set must not cost the TeX tie its meaning where
    // the span really is one expression.
    assert.equal(latexToPlainText('mass $5~kg$ exactly'), 'mass 5 kg exactly')
  })
})
