import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { extractByInstruction, instructionWords, passages } from '../src/shared/browseExtract'

/** v4.0 (C4, an experiment): what browse hands back for an instruction, with no model in the way. */

const page = {
  title: 'Acme Widgets — Store',
  text: ['Welcome to Acme.', '', 'Widget A — the classic. $12.50 each, ships tomorrow.', 'Widget B — bigger. €30 per unit.', '', 'About us', 'Founded in 1999 in Leeds, Acme makes widgets for everyone.', '', 'Releases', 'v2.3.0 released 2026-09-01: faster startup, fixes to the exporter.', 'v2.2.0 released 2026-06-15: dark mode.'].join('\n'),
  links: [
    { text: 'Releases', url: 'https://acme.example/releases' },
    { text: 'Download v2.3.0', url: 'https://acme.example/dl/2.3.0.zip' },
    { text: 'Contact', url: 'https://acme.example/contact' }
  ]
}

describe('browse extraction', () => {
  test('the instruction’s words, without the filler', () => {
    assert.deepEqual(instructionWords('Find the newest release on this page'), ['newest', 'release'])
  })

  test('links: the ones whose text or URL holds the words, or all of them', () => {
    const out = extractByInstruction(page, 'the download links')
    assert.match(out, /^Acme Widgets — Store\n\nLinks matching the instruction \(1\):\n- Download v2\.3\.0 → https:\/\/acme\.example\/dl\/2\.3\.0\.zip$/)
    assert.match(extractByInstruction(page, 'list every link'), /Links \(3\):\n- Releases → [\s\S]*- Contact →/)
  })

  test('prices: the lines with an amount', () => {
    const out = extractByInstruction(page, 'the prices of the widgets')
    assert.match(out, /Lines with an amount \(2\):\n- Widget A — the classic\. \$12\.50 each, ships tomorrow\.\n- Widget B — bigger\. €30 per unit\./)
  })

  test('anything else: the passages that match, best first; nothing matching says so and gives the start', () => {
    const out = extractByInstruction(page, 'the newest release and what changed')
    assert.match(out, /^Acme Widgets — Store\n\nReleases\nv2\.3\.0 released 2026-09-01/)
    assert.doesNotMatch(out.split('\n\n')[1] ?? '', /Welcome/)
    const none = extractByInstruction(page, 'the opening hours')
    assert.match(none, /Nothing on the page matched “the opening hours”/)
    assert.match(none, /Welcome to Acme\./)
  })

  test('a word matches at a word’s start: "rain" finds "raining", never "training" (4.0.2)', () => {
    const wx = {
      title: 'Richmond forecast',
      text: ['Staff training schedule for the week.', '', 'Tuesday: raining until 3 pm, then clearing.'].join('\n'),
      links: []
    }
    const out = extractByInstruction(wx, 'rain today')
    assert.match(out.split('\n\n')[1] ?? '', /^Tuesday: raining/)
    assert.doesNotMatch(out, /Staff training/)
  })

  test('passages: paragraphs, and long blocks cut by line', () => {
    assert.deepEqual(passages('a\n\nb\nc\n\n\nd'), ['a', 'b\nc', 'd'])
    const long = Array.from({ length: 40 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')
    const cut = passages(long, 300)
    assert.ok(cut.length > 3 && cut.every((p) => p.length <= 300))
    assert.equal(cut.join('\n'), long)
  })

  test('the output is clipped to the budget, and says so', () => {
    const big = { title: 'T', text: Array.from({ length: 200 }, (_, i) => `paragraph ${i} about widgets ${'y'.repeat(100)}`).join('\n\n'), links: [] }
    const out = extractByInstruction(big, 'widgets', 1_000)
    assert.ok(out.length < 1_100)
    assert.match(out, /more characters\)$/)
  })
})
