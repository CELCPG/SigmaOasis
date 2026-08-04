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
