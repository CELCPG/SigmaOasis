import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import DOMPurify from 'dompurify'
import {
  VIBE_SYSTEM_LINE,
  isVibeToggle,
  outlineAllowed,
  stripCitationMarkers,
  vibeLines,
  vibePhase,
  vibeSystemBlock
} from '../src/renderer/src/lib/vibe'
import type { ChatMessage } from '../src/renderer/src/types'

/**
 * VIBE (v3.0): the calm view. Two promises are pinned here, because both are
 * easy to break without noticing:
 *
 * 1. The engine does not change. VIBE adds exactly one line to a turn — the
 *    brevity line, in the system prompt — and turns off outline-then-fill.
 *    Everything else a turn does (tools, recall, library, checks) runs as it
 *    does in the full view. Where the line goes is measured, not chosen:
 *    lib/vibe.ts has the numbers.
 * 2. Nothing but the conversation is drawn. A reply whose turn called tools,
 *    thought for a while and was checked renders in VIBE as its words.
 */

const src = (...parts: string[]): string =>
  readFileSync(join(__dirname, '..', '..', 'src', ...parts), 'utf-8').replace(/\r\n/g, '\n')

const msg = (m: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role'>): ChatMessage => ({
  content: '',
  createdAt: 0,
  ...m
})

describe('the brevity line', () => {
  test('asks for short, plain replies and keeps the reader’s right to ask for more', () => {
    assert.match(VIBE_SYSTEM_LINE, /a few calm sentences/i)
    assert.match(VIBE_SYSTEM_LINE, /asks for something long or detailed, give it in full/i)
  })

  test('puts the work first — the reply is short, the checking is not', () => {
    // Measured: a note that only asked for brevity cost the mode its tools.
    assert.match(VIBE_SYSTEM_LINE, /once you have what you need/i)
    assert.doesNotMatch(VIBE_SYSTEM_LINE, /\bno (?:tools|tool calls)\b/i)
  })

  test('is added only when VIBE is on', () => {
    assert.equal(vibeSystemBlock(false), '')
    assert.equal(vibeSystemBlock(undefined), '')
    assert.equal(vibeSystemBlock(true), `\n\n${VIBE_SYSTEM_LINE}`)
  })

  test('rides the system prompt, never the turn’s notes on the user’s message', () => {
    // The notes block cost the tool call — 1/13 against 7/7; the system prompt
    // kept it (lib/vibe.ts). This pins the placement that was measured.
    const engine = src('renderer', 'src', 'hooks', 'useLMStudio.ts')
    const systemPromptBuild = engine.slice(engine.indexOf('let systemPrompt = '), engine.indexOf('const projectTokens'))
    assert.match(systemPromptBuild, /projectBlock \+ vibeSystemBlock\(/)
    assert.match(engine, /const turnContext: string\[\] = gathered\.blocks\n/)
  })

  test('outline-then-fill steps aside in VIBE and nowhere else', () => {
    assert.equal(outlineAllowed(true), false)
    assert.equal(outlineAllowed(false), true)
    assert.equal(outlineAllowed(undefined), true)
    assert.match(src('renderer', 'src', 'hooks', 'useLMStudio.ts'), /outlineAllowed\(settings\.vibeMode\)/)
  })
})

describe('what VIBE shows', () => {
  test('the conversation’s words, in order, without dividers', () => {
    const lines = vibeLines(
      [
        msg({ id: 'u1', role: 'user', content: 'hello' }),
        msg({ id: 'r1', role: 'assistant', content: 'Context rolled back', marker: 'rollback' }),
        msg({ id: 'a1', role: 'assistant', content: 'Hi there.' }),
        msg({ id: 'd1', role: 'assistant', content: 'Your digest.', marker: 'digest' })
      ],
      null
    )
    assert.deepEqual(
      lines.map((l) => [l.role, l.text]),
      [
        ['user', 'hello'],
        ['assistant', 'Hi there.'],
        ['assistant', 'Your digest.']
      ]
    )
  })

  test('the reply being written is a line even before its first word', () => {
    const lines = vibeLines([msg({ id: 'u1', role: 'user', content: 'hi' }), msg({ id: 'a1', role: 'assistant' })], 'a1')
    assert.equal(lines[1].id, 'a1')
    assert.equal(lines[1].quiet, undefined)
  })

  test('an agent turn still working is in progress, not a reply that ended with nothing', () => {
    const lines = vibeLines(
      [msg({ id: 'a1', role: 'assistant', agent: { taskId: 't', status: 'running', steps: [], startedAt: 0, workspace: null, permission: 'ask' } })],
      null
    )
    assert.equal(lines.length, 1)
    assert.equal(lines[0].quiet, undefined)
    assert.equal(lines[0].text, '')
  })

  test('a finished empty reply says why instead of leaving a blank', () => {
    const lines = vibeLines(
      [
        msg({
          id: 'a1',
          role: 'assistant',
          ending: { accepted: false, streamed: false, completed: false, produced: false, stoppedByUser: true, silentMs: 10 }
        })
      ],
      null
    )
    assert.equal(lines.length, 1)
    assert.equal(lines[0].quiet, true)
    assert.ok(lines[0].text.length > 10, 'a sentence, not an empty line')
  })

  test('a steer still on its way is marked, and a file-only message names its files', () => {
    const lines = vibeLines(
      [
        msg({ id: 'u1', role: 'user', content: 'wait, shorter', delivery: { state: 'queued' } }),
        msg({ id: 'u2', role: 'user', content: '', attachments: [{ name: 'notes.txt', type: 'text', content: 'x' } as never] })
      ],
      null
    )
    assert.equal(lines[0].queued, true)
    assert.equal(lines[1].text, '📎 notes.txt')
  })

  test('the light breathes while nothing has surfaced, and glows once words do', () => {
    assert.equal(vibePhase(false, false), 'still')
    assert.equal(vibePhase(false, true), 'still')
    assert.equal(vibePhase(true, false), 'breathing')
    assert.equal(vibePhase(true, true), 'surfacing')
  })
})

describe('citation markers', () => {
  test('are removed from prose, with the space before them', () => {
    assert.equal(stripCitationMarkers('Water boils at 100 °C [1].'), 'Water boils at 100 °C.')
    assert.equal(stripCitationMarkers('Two sources agree [2][3], mostly.'), 'Two sources agree, mostly.')
  })

  test('are left alone in code, in links and on indexes', () => {
    const fenced = 'Try:\n```python\nx = [1]\ny = [2][3]\n```\ndone [4].'
    assert.equal(stripCitationMarkers(fenced), 'Try:\n```python\nx = [1]\ny = [2][3]\n```\ndone.')
    assert.equal(stripCitationMarkers('Use `pick [2]` here.'), 'Use `pick [2]` here.')
    assert.equal(stripCitationMarkers('See [1](https://example.org).'), 'See [1](https://example.org).')
    assert.equal(stripCitationMarkers('items[0] and arr[12]'), 'items[0] and arr[12]')
  })

  test('a fence still open mid-stream keeps its contents whole', () => {
    assert.equal(stripCitationMarkers('Here [1]:\n```js\nconst a = [1]'), 'Here:\n```js\nconst a = [1]')
  })
})

describe('the shortcut', () => {
  const key = (k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>>) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...mods
  })

  test('is ⌘⇧L or Ctrl+Shift+L', () => {
    assert.ok(isVibeToggle(key('L', { ctrlKey: true, shiftKey: true })))
    assert.ok(isVibeToggle(key('l', { metaKey: true, shiftKey: true })))
  })

  test('is not paste-as-plain-text, and not any near miss', () => {
    assert.equal(isVibeToggle(key('V', { ctrlKey: true, shiftKey: true })), false)
    assert.equal(isVibeToggle(key('l', { ctrlKey: true })), false)
    assert.equal(isVibeToggle(key('L', { ctrlKey: true, shiftKey: true, altKey: true })), false)
    assert.equal(isVibeToggle(key('L', { shiftKey: true })), false)
  })
})

describe('the view draws nothing but the conversation', () => {
  beforeEach(() => {
    ;(globalThis as { window?: unknown }).window = {
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      api: {}
    }
    // DOMPurify needs a DOM, which plain Node has none of; its sanitizing is
    // exercised in a real window by test/markdownCheck.ts. What is asserted
    // here is what reaches the markup, not how it is cleaned.
    const purify = DOMPurify as unknown as { sanitize?: (html: string) => string }
    if (typeof purify.sanitize !== 'function') purify.sanitize = (html) => html
  })

  /**
   * The scene is rendered from what the container hands it — `vibeLines` of
   * the conversation — so this is the same path the app takes from a stored
   * message to the screen, minus the store.
   */
  const render = async (
    messages: ChatMessage[],
    extra: Partial<Record<'streaming' | 'streamingId' | 'pendingPatches' | 'offline' | 'ephemeral', unknown>> = {}
  ): Promise<string> => {
    const { VibeScene } = await import('../src/renderer/src/components/vibe/VibeView')
    const streamingId = (extra.streamingId as string | undefined) ?? null
    const streaming = Boolean(extra.streaming)
    const last = messages[messages.length - 1]
    return renderToStaticMarkup(
      createElement(VibeScene, {
        lines: vibeLines(messages, streamingId),
        phase: vibePhase(streaming, Boolean(streamingId && last?.content.trim())),
        streaming,
        streamingId,
        offline: Boolean(extra.offline),
        ephemeral: Boolean(extra.ephemeral),
        pendingPatches: (extra.pendingPatches as never) ?? [],
        reducedMotion: false,
        onSend: () => {},
        onStop: () => {},
        onNewChat: () => {},
        onLeave: () => {},
        onDecide: () => {}
      })
    )
  }

  const busyTurn: ChatMessage[] = [
    msg({ id: 'u1', role: 'user', content: 'What is the boiling point of water?' }),
    msg({
      id: 'a1',
      role: 'assistant',
      content: 'It boils at 100 °C at sea level [1].',
      roleName: 'Researcher',
      reasoning: 'SECRET-CHAIN-OF-THOUGHT',
      reasoningMs: 4000,
      toolCalls: [{ id: 't1', name: 'web_search', args: { query: 'boiling point' }, status: 'done', result: 'TOOL-OUTPUT' }],
      stats: { ttftMs: 120, totalMs: 900, tokensPerSecond: 42, completionTokens: 30 },
      checks: [{ kind: 'recompute', ok: true, summary: 'CHECK-LINE' }],
      playbook: 'PLAYBOOK-NAME',
      memoryContext: [{ source: 'MEMORY-SOURCE', text: 'x', score: 0.9 } as never]
    })
  ]

  test('a turn that searched, thought and was checked renders as its words', async () => {
    const html = await render(busyTurn)
    assert.match(html, /What is the boiling point of water\?/)
    assert.match(html, /It boils at 100 °C at sea level\./)
    for (const noise of ['SECRET-CHAIN-OF-THOUGHT', 'TOOL-OUTPUT', 'web_search', 'CHECK-LINE', 'PLAYBOOK-NAME', 'MEMORY-SOURCE', 'Researcher', 'tok/s', 'Thought for', '[1]']) {
      assert.ok(!html.includes(noise), `VIBE drew "${noise}"`)
    }
  })

  test('it is always night, and there is always a way out', async () => {
    const html = await render(busyTurn)
    assert.match(html, /class="vibe-root dark /)
    assert.match(html, /leave vibe/)
    assert.match(html, /aria-label="Message"/)
    assert.doesNotMatch(html, /LM Studio isn’t answering/, 'no offline line while the server answers')
  })

  test('a waiting turn breathes; a file change still waits for the reader', async () => {
    const waiting = [...busyTurn, msg({ id: 'u2', role: 'user', content: 'fix my notes' }), msg({ id: 'a2', role: 'assistant' })]
    const html = await render(waiting, {
      streaming: true,
      streamingId: 'a2',
      pendingPatches: [
        { reviewId: 'r1', callId: 'c', path: 'notes.md', isNew: false, diff: '--- a\n+++ b\n', stats: { added: 2, removed: 1, hunks: 1 } }
      ]
    })
    assert.match(html, /role="status" aria-label="Thinking"/)
    assert.match(html, /notes\.md/)
    assert.match(html, />Apply</)
    assert.match(html, />Discard</)
    assert.match(html, /aria-label="Stop"/)
    assert.match(html, /data-live="true"/)
  })

  test('a server that is not answering is said once, quietly', async () => {
    const html = await render(busyTurn, { offline: true })
    assert.match(html, /LM Studio isn’t answering/)
  })

  test('an ephemeral chat says it is not being saved; a saved one says nothing', async () => {
    assert.match(await render(busyTurn, { ephemeral: true }), /◌ not saved/)
    assert.doesNotMatch(await render(busyTurn), /not saved/)
  })

  test('an empty conversation is still water with a composer', async () => {
    const html = await render([])
    assert.match(html, /Still water\./)
    assert.match(html, /say anything…/)
  })
})
