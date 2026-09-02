/**
 * The shared streaming core (v2.4): the parser both processes read LM Studio's
 * `/chat/completions` stream with, and the contract it keeps.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSseFrameReader,
  createToolCallAssembler,
  frameError,
  frameText,
  parseChatFrame
} from '../src/shared/sse'

const frame = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ choices: [{ delta, ...extra }], ...(extra.usage ? { usage: extra.usage } : {}) })

describe('createSseFrameReader', () => {
  it('yields one payload per blank-line-terminated event', () => {
    const r = createSseFrameReader()
    const got = r.push(`data: ${frame({ content: 'a' })}\n\ndata: ${frame({ content: 'b' })}\n\n`)
    assert.equal(got.length, 2)
    assert.equal(frameText(parseChatFrame(got[1])!).content, 'b')
  })

  it('a frame split across chunks arrives whole, once', () => {
    const r = createSseFrameReader()
    const f = frame({ content: 'hello' })
    const first = r.push(`data: ${f.slice(0, 10)}`)
    const second = r.push(`${f.slice(10)}\n\n`)
    assert.deepEqual(first, [])
    assert.equal(second.length, 1)
    assert.equal(frameText(parseChatFrame(second[0])!).content, 'hello')
  })

  it('a server that never sends blank lines still streams, frame by line', () => {
    const r = createSseFrameReader()
    const got = r.push(`data: ${frame({ content: 'x' })}\ndata: ${frame({ content: 'y' })}\n`)
    assert.equal(got.length, 2)
  })

  it('CRLF line endings are the same stream', () => {
    const r = createSseFrameReader()
    const got = r.push(`data: ${frame({ content: 'x' })}\r\n\r\n`)
    assert.equal(got.length, 1)
  })

  it('[DONE] ends the stream and nothing after it is read', () => {
    const r = createSseFrameReader()
    const got = r.push(`data: ${frame({ content: 'x' })}\n\ndata: [DONE]\n\ndata: ${frame({ content: 'late' })}\n\n`)
    assert.equal(got.length, 1)
    assert.equal(r.done, true)
    assert.deepEqual(r.push(`data: ${frame({ content: 'later' })}\n\n`), [])
    assert.deepEqual(r.flush(), [])
  })

  it('flush yields a final frame that had no trailing newline', () => {
    const r = createSseFrameReader()
    assert.deepEqual(r.push(`data: ${frame({ content: 'end' })}`), [])
    const got = r.flush()
    assert.equal(got.length, 1)
    assert.equal(frameText(parseChatFrame(got[0])!).content, 'end')
  })

  it('comment, event and id lines are ignored', () => {
    const r = createSseFrameReader()
    const got = r.push(`: keepalive\nevent: message\nid: 7\ndata: {"choices":[{"delta":{"content":"a"}}]}\n\n`)
    assert.equal(got.length, 1)
    assert.equal(frameText(parseChatFrame(got[0])!).content, 'a')
  })

  it('a malformed payload is skipped by the parser, never fatal', () => {
    const r = createSseFrameReader()
    const got = r.push(`data: {not json\ndata: ${frame({ content: 'ok' })}\n`)
    // the malformed line is handed over as-is and never swallows its neighbour
    assert.equal(got.length, 2)
    assert.equal(parseChatFrame(got[0]), null)
    assert.equal(frameText(parseChatFrame(got[1])!).content, 'ok')
  })
})

describe('frames', () => {
  it('reads content, reasoning and the message shape', () => {
    assert.deepEqual(frameText(parseChatFrame(frame({ content: 'c', reasoning_content: 'r' }))!), { content: 'c', reasoning: 'r' })
    assert.deepEqual(frameText({ choices: [{ message: { content: 'm' } }] }), { content: 'm', reasoning: '' })
    assert.deepEqual(frameText({ usage: { total_tokens: 3 } }), { content: '', reasoning: '' })
  })

  it('an error frame is read outside any JSON catch, in both shapes', () => {
    assert.equal(frameError({ error: 'plain' }), 'plain')
    assert.equal(frameError({ error: { message: 'over the window', code: 400 } }), 'over the window')
    assert.equal(frameError({ error: { code: 500 } }), '{"code":500}')
    assert.equal(frameError({ choices: [] }), null)
  })
})

describe('createToolCallAssembler', () => {
  it('joins name and argument fragments by index and keeps arguments raw', () => {
    const a = createToolCallAssembler(() => 'gen')
    a.push([{ index: 0, id: 'call_1', function: { name: 'web_', arguments: '{"q":' } }])
    a.push([{ index: 0, function: { name: 'search', arguments: '"x"}' } }, { index: 1, function: { name: 'read_file', arguments: '{}' } }])
    const { calls, droppedAsTruncated } = a.finish('stop')
    assert.equal(droppedAsTruncated, 0)
    assert.deepEqual(calls, [
      { id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"q":"x"}' } },
      { id: 'gen', type: 'function', function: { name: 'read_file', arguments: '{}' } }
    ])
  })

  it('a reply cut off at its token budget drops the calls it was still writing', () => {
    const a = createToolCallAssembler(() => 'gen')
    a.push([{ index: 0, function: { name: 'run_python', arguments: '{"code":"print(' } }])
    const { calls, droppedAsTruncated } = a.finish('length')
    assert.deepEqual(calls, [])
    assert.equal(droppedAsTruncated, 1)
  })

  it('a length finish with no calls open drops nothing', () => {
    const a = createToolCallAssembler(() => 'gen')
    assert.deepEqual(a.finish('length'), { calls: [], droppedAsTruncated: 0 })
  })
})
