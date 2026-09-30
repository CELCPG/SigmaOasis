import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { splitStreamingMarkdown } from '../src/renderer/src/lib/markdown'

/**
 * The streaming split decides which half of a live reply is re-parsed per
 * flush. Every failure mode here is silent visual corruption — code rendered
 * as prose, a table torn in half — so the boundary rules are pinned directly.
 * The invariant that matters most: stable + live === input, always, since the
 * two halves are rendered back-to-back.
 */

/** Split and assert the halves reassemble into the input exactly. */
function split(markdown: string): [string, string] {
  const [stable, live] = splitStreamingMarkdown(markdown)
  assert.equal(stable + live, markdown, 'the split must lose nothing')
  return [stable, live]
}

describe('splitStreamingMarkdown boundaries', () => {
  test('splits at the last blank line', () => {
    const [stable, live] = split('First paragraph.\n\nSecond paragraph.\n\nStill typing')
    assert.equal(stable, 'First paragraph.\n\nSecond paragraph.\n\n')
    assert.equal(live, 'Still typing')
  })

  test('no blank line yet — everything is live', () => {
    const [stable, live] = split('A single opening paragraph, still growing')
    assert.equal(stable, '')
    assert.equal(live, 'A single opening paragraph, still growing')
  })

  test('empty input stays empty', () => {
    assert.deepEqual(split(''), ['', ''])
  })

  test('a blank line inside an open code fence is not a boundary', () => {
    const md = 'Intro.\n\n```python\ndef f():\n\n    return 1\n'
    const [stable, live] = split(md)
    // The open fence must fall wholly into the live half.
    assert.equal(stable, 'Intro.\n\n')
    assert.equal(live, '```python\ndef f():\n\n    return 1\n')
  })

  test('a closed fence is stable up to the next blank line', () => {
    const md = 'Intro.\n\n```js\nconst a = 1\n```\n\nAfter the block, still typing'
    const [stable, live] = split(md)
    assert.equal(stable, 'Intro.\n\n```js\nconst a = 1\n```\n\n')
    assert.equal(live, 'After the block, still typing')
  })

  test('an open fence with earlier closed fences retreats to before the open one', () => {
    const md = 'A.\n\n```\nclosed\n```\n\nB.\n\n```\nstill open\n\nmore code\n'
    const [stable, live] = split(md)
    assert.equal(stable, 'A.\n\n```\nclosed\n```\n\nB.\n\n')
    assert.equal(live, '```\nstill open\n\nmore code\n')
  })

  test('a fence opened at the very start leaves everything live', () => {
    const md = '```\nline one\n\nline two\n'
    const [stable, live] = split(md)
    assert.equal(stable, '')
    assert.equal(live, md)
  })

  test('a table has no blank lines and falls wholly into the live half', () => {
    const md = 'Here are the results:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |'
    const [stable, live] = split(md)
    assert.equal(stable, 'Here are the results:\n\n')
    assert.match(live, /^\| a \| b \|/)
  })
})

describe('sandbox image refs are dropped from rendered markdown (v1.12)', () => {
  // renderMarkdown itself needs a DOM (DOMPurify) and is exercised by the
  // Electron render checks; the stripping rule is pure and pinned here.
  const { stripSandboxImages } = require('../src/renderer/src/lib/markdown') as typeof import('../src/renderer/src/lib/markdown')

  test('an img into /work never survives — a broken icon is all it could render', () => {
    for (const src of ['/work/chart.png', 'file:///work/chart.png', "/work/out%20put.png"]) {
      const html = `<p>before</p><img src="${src}" alt="chart"><p>after</p>`
      const out = stripSandboxImages(html)
      assert.ok(!out.includes('<img'), out)
      assert.ok(out.includes('before') && out.includes('after'))
    }
  })

  test('ordinary images survive', () => {
    for (const src of ['data:image/png;base64,iVBORw0KGgo=', 'https://example.com/x.png']) {
      const out = stripSandboxImages(`<img src="${src}">`)
      assert.ok(out.includes('<img'), out)
    }
  })
})

describe('an open code block is highlighted in settled runs while it streams (v4.1 S6)', () => {
  // DOMPurify is a factory with no sanitize() outside a DOM. The sanitizer is
  // pinned in a real window (test/markdownCheck.ts); what is measured here is
  // the highlighting ahead of it, so it passes HTML through.
  const purify = require('dompurify') as { sanitize?: (html: string) => string }
  if (typeof purify.sanitize !== 'function') purify.sanitize = (html: string) => html
  const md = require('../src/renderer/src/lib/markdown') as typeof import('../src/renderer/src/lib/markdown')
  const hljs = require('highlight.js/lib/core') as typeof import('highlight.js').default

  // Line-local code, like the render bench's reply: no construct spans a line.
  const lines = Array.from({ length: 400 }, (_, i) => `    out[key_${i}] = out.get("k${i}", 0) + int(record.get("count", 1))  # step ${i}`)
  const code = lines.join('\n')
  const reply = `Here it is.\n\n\`\`\`python\n${code}\n\`\`\`\n`

  test('a finished message is highlighted whole, exactly as before', () => {
    const html = md.renderMarkdown(reply)
    assert.ok(html.includes(hljs.highlight(code, { language: 'python' }).value))
  })

  test('the streaming render of line-local code is byte-identical to the finished one', () => {
    assert.equal(md.renderStreamingMarkdown(reply), md.renderMarkdown(reply))
  })

  test('the cost per flush follows the new text, not the whole block', () => {
    const open = `\`\`\`python\n${code}`
    const before = md.streamingHighlightWork()
    let naive = 0
    let flushes = 0
    // A flush every ~120 characters, the pacer's order of magnitude at 60 tok/s.
    for (let end = 200; end <= open.length; end += 120) {
      md.renderStreamingMarkdown(open.slice(0, end))
      naive += end
      flushes++
    }
    const work = md.streamingHighlightWork() - before
    assert.ok(flushes > 200)
    // Bounded by one unsettled run per flush, where whole-block highlighting grows with the block.
    assert.ok(work * 5 < naive, `highlighted ${work} chars where whole-block re-highlighting is ${naive}`)
    assert.ok(work / flushes < 40 * 100, `${Math.round(work / flushes)} chars a flush`)
  })
})
