import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createNativeToolExtractor, parseNativeToolCall } from '../src/renderer/src/lib/nativeToolCall'
import { createReasoningSplitter } from '../src/renderer/src/lib/reasoning'

/**
 * Gemma 4 emits tool calls as native markup inside the content stream when
 * the serving layer has no gemma4 parser (LM Studio today). The extractor
 * must do three things perfectly: never show the markup, never execute a
 * half-parsed call, and never lose the prose around a call.
 */

/** Feed a whole reply through the extractor in the given chunks. */
function run(chunks: string[]): { text: string; calls: { name: string; arguments: string }[] } {
  const extractor = createNativeToolExtractor()
  let text = ''
  const calls: { name: string; arguments: string }[] = []
  for (const chunk of chunks) {
    const out = extractor.push(chunk)
    text += out.text
    calls.push(...out.calls)
  }
  const tail = extractor.flush()
  return { text: text + tail.text, calls: calls.concat(tail.calls) }
}

describe('parseNativeToolCall — the argument grammar', () => {
  test('the documented format: quoted strings and bare numbers', () => {
    const call = parseNativeToolCall(
      'call:write_file{content:<|"|>print("hello")<|"|>,file_path:<|"|>hello.py<|"|>,retries:3}'
    )
    assert.equal(call!.name, 'write_file')
    assert.deepEqual(JSON.parse(call!.arguments), {
      content: 'print("hello")',
      file_path: 'hello.py',
      retries: 3
    })
  })

  test('booleans, floats, negatives and lists', () => {
    const call = parseNativeToolCall(
      'call:run{background:false,temperature:3.5,offset:-2,paths:[<|"|>a<|"|>,<|"|>b<|"|>]}'
    )
    assert.deepEqual(JSON.parse(call!.arguments), {
      background: false,
      temperature: 3.5,
      offset: -2,
      paths: ['a', 'b']
    })
  })

  test('commas inside quoted strings do not split pairs', () => {
    const call = parseNativeToolCall('call:search{q:<|"|>hello, world<|"|>}')
    assert.deepEqual(JSON.parse(call!.arguments), { q: 'hello, world' })
  })

  test('a brace inside a quoted string is not the end of the call', () => {
    const call = parseNativeToolCall('call:write{content:<|"|>a } brace<|"|>}')
    assert.deepEqual(JSON.parse(call!.arguments), { content: 'a } brace' })
  })

  test('malformed spans return null rather than half-parsed arguments', () => {
    assert.equal(parseNativeToolCall('call:{broken'), null)
    assert.equal(parseNativeToolCall('not even a call'), null)
    assert.equal(parseNativeToolCall('call:x{key}'), null)
    assert.equal(parseNativeToolCall('call:x{key:<|"|>unterminated'), null)
  })
})

describe('createNativeToolExtractor — stream behavior', () => {
  test('a call between prose is removed and parsed, the prose kept', () => {
    const out = run(['Let me check. <|tool_call>call:get_time{}<tool_call|> Done.'])
    assert.equal(out.text, 'Let me check.  Done.')
    assert.equal(out.calls.length, 1)
    assert.equal(out.calls[0]!.name, 'get_time')
    assert.equal(out.calls[0]!.arguments, '{}')
  })

  test('the sloppy <|tool> opener variant is accepted', () => {
    const out = run(['<|tool>call:text_generation{prompt:<|"|>cats<|"|>}<tool_call|>'])
    assert.equal(out.text, '')
    assert.equal(out.calls[0]!.name, 'text_generation')
    assert.deepEqual(JSON.parse(out.calls[0]!.arguments), { prompt: 'cats' })
  })

  test('a call split across chunks still parses', () => {
    const out = run(['<|tool', '_call>call:x{a:<|"|>1<|"|>}', '<tool_call|>'])
    assert.equal(out.calls.length, 1)
    assert.deepEqual(JSON.parse(out.calls[0]!.arguments), { a: '1' })
  })

  test('an unclosed call at end of stream is dropped, not executed or shown', () => {
    const out = run(['<|tool_call>call:x{a:<|"|>half'])
    assert.equal(out.text, '')
    assert.equal(out.calls.length, 0)
  })

  test('a malformed call is dropped silently', () => {
    const out = run(['<|tool_call>call:{broken}<tool_call|>visible'])
    assert.equal(out.text, 'visible')
    assert.equal(out.calls.length, 0)
  })

  test('stray control tokens never render', () => {
    const out = run(['A story about cats<|"|> and dogs<turn|>'])
    assert.equal(out.text, 'A story about cats and dogs')
  })

  test('plain text passes through untouched', () => {
    const out = run(['Once upon a ', 'time there was a cat.'])
    assert.equal(out.text, 'Once upon a time there was a cat.')
    assert.equal(out.calls.length, 0)
  })
})

describe('reasoning splitter + tool extractor — the reported bug, end to end', () => {
  test('the exact gemma-4-12b-qat reply renders as thinking plus one real call', () => {
    const sample =
      '<|think|>The user has asked me to generate another story, following up on ' +
      'the previous request. I need to maintain context that they want another ' +
      'cat story.<|tool>call:text_generation{prompt:<|"|>a short story about cats<|"|>}<tool_call|>'

    const splitter = createReasoningSplitter()
    const extractor = createNativeToolExtractor()
    const split = splitter.push(sample)
    const out = extractor.push(split.answer)
    const tail = extractor.flush()

    assert.match(split.reasoning, /generate another story/)
    assert.equal(out.text + tail.text, '')
    const calls = out.calls.concat(tail.calls)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.name, 'text_generation')
    assert.deepEqual(JSON.parse(calls[0]!.arguments), { prompt: 'a short story about cats' })
  })
})
