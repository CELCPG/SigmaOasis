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
