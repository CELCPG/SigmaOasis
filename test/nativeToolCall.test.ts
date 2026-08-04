import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createNativeToolExtractor, parseJsonCallBlob, parseNativeToolCall } from '../src/renderer/src/lib/nativeToolCall'
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

describe('the <call>name{json}</call> variant (agentic fine-tunes, measured 2026-08-03)', () => {
  test('plain JSON arguments parse into the OpenAI shape', () => {
    const call = parseNativeToolCall('web_search{"query":"paris weather","freshness":"week"}')
    assert.equal(call!.name, 'web_search')
    assert.deepEqual(JSON.parse(call!.arguments), { query: 'paris weather', freshness: 'week' })
  })

  test('an empty argument object is a valid call', () => {
    const call = parseNativeToolCall('get_current_datetime{}')
    assert.equal(call!.name, 'get_current_datetime')
    assert.deepEqual(JSON.parse(call!.arguments), {})
  })

  test('broken JSON, arrays, and scalars return null rather than execute', () => {
    assert.equal(parseNativeToolCall('web_search{query: paris}'), null)
    assert.equal(parseNativeToolCall('web_search[1,2]'), null)
    assert.equal(parseNativeToolCall('web_search{"query"'), null)
    assert.equal(parseNativeToolCall('no braces at all'), null)
  })

  test('the exact reply observed from gemma-4-e4b-agentic extracts one real call', () => {
    const out = run(['<call>get_current_datetime{}</call>'])
    assert.equal(out.text, '')
    assert.equal(out.calls.length, 1)
    assert.equal(out.calls[0]!.name, 'get_current_datetime')
    assert.deepEqual(JSON.parse(out.calls[0]!.arguments), {})
  })

  test('a <call> between prose is removed and parsed, the prose kept', () => {
    const out = run(['Let me check. <call>web_search{"query":"tokyo weather"}</call> Here you go.'])
    assert.equal(out.text, 'Let me check.  Here you go.')
    assert.equal(out.calls.length, 1)
    assert.equal(out.calls[0]!.name, 'web_search')
    assert.deepEqual(JSON.parse(out.calls[0]!.arguments), { query: 'tokyo weather' })
  })

  test('a <call> split across chunks still parses', () => {
    const out = run(['<call>finance_calculator{"expre', 'ssion":"86.40*0.18"}</call>'])
    assert.equal(out.calls.length, 1)
    assert.deepEqual(JSON.parse(out.calls[0]!.arguments), { expression: '86.40*0.18' })
  })

  test('an unclosed <call> at end of stream is dropped, not executed or shown', () => {
    const out = run(['answer text <call>web_search{"query":"x"}'])
    assert.equal(out.text, 'answer text ')
    assert.equal(out.calls.length, 0)
  })
})

describe('JSON call blobs in content (measured on the 4B, 2026-08-03)', () => {
  test('the plural blob: function as a string name plus args', () => {
    const calls = parseJsonCallBlob(
      '{\n  "tool_calls": [\n    {\n      "function": "list_directory",\n      "args": {\n        "path": "~/Downloads"\n      }\n    }\n  ]\n}'
    )
    assert.equal(calls!.length, 1)
    assert.equal(calls![0]!.name, 'list_directory')
    assert.deepEqual(JSON.parse(calls![0]!.arguments), { path: '~/Downloads' })
  })

  test('the singular blob: tool_call as a string plus args', () => {
    const calls = parseJsonCallBlob('{"tool_call": "memory_save", "args": {"title": "favorite band", "text": "Phish"}}')
    assert.equal(calls!.length, 1)
    assert.equal(calls![0]!.name, 'memory_save')
    assert.deepEqual(JSON.parse(calls![0]!.arguments), { title: 'favorite band', text: 'Phish' })
  })

  test('OpenAI-ish entries are accepted: function object, arguments key, stringified args', () => {
    const calls = parseJsonCallBlob(
      '{"tool_calls": [{"function": {"name": "web_search", "arguments": "{\\"query\\":\\"x\\"}"}}]}'
    )
    assert.equal(calls!.length, 1)
    assert.equal(calls![0]!.name, 'web_search')
    assert.deepEqual(JSON.parse(calls![0]!.arguments), { query: 'x' })
  })

  test('multiple calls in one blob all extract', () => {
    const calls = parseJsonCallBlob(
      '{"tool_calls": [{"function": "list_notes", "args": {}}, {"function": "memory_search", "args": {"query": "band"}}]}'
    )
    assert.deepEqual(calls!.map((c) => c.name), ['list_notes', 'memory_search'])
  })

  test('a bare argument object is not a call — guessing the tool is how the wrong thing runs', () => {
    assert.equal(parseJsonCallBlob('{"path":"groceries.txt","content":"milk"}'), null)
  })

  test('broken JSON, arrays, scalars, and missing names return null', () => {
    assert.equal(parseJsonCallBlob('{"tool_calls": [{"function": "x", "args":'), null)
    assert.equal(parseJsonCallBlob('[{"tool_call": "x"}]'), null)
    assert.equal(parseJsonCallBlob('"tool_call"'), null)
    assert.equal(parseJsonCallBlob('{"tool_calls": [{"args": {}}]}'), null)
    assert.equal(parseJsonCallBlob('{"tool_calls": []}'), null)
    assert.equal(parseJsonCallBlob('{"unrelated": true}'), null)
  })

  test('a whole-content blob extracts with no visible text', () => {
    const out = run(['{"tool_calls": [{"function": "list_directory", "args": {"path": "~/Downloads"}}]}'])
    assert.equal(out.text, '')
    assert.equal(out.calls.length, 1)
    assert.equal(out.calls[0]!.name, 'list_directory')
  })

  test('a blob split across chunks still parses, prose before it kept', () => {
    const out = run(['One moment. {"tool_call"', ': "finance_calculator", "args": {"expression": "86.40*0.18"}}'])
    assert.equal(out.text, 'One moment. ')
    assert.equal(out.calls.length, 1)
    assert.equal(out.calls[0]!.name, 'finance_calculator')
    assert.deepEqual(JSON.parse(out.calls[0]!.arguments), { expression: '86.40*0.18' })
  })

  test('a signature cut at the chunk boundary holds, then resolves on the next chunk', () => {
    const out = run(['checking {"tool_ca', 'll": "list_notes", "args": {}}'])
    assert.equal(out.text, 'checking ')
    assert.equal(out.calls.length, 1)
    assert.equal(out.calls[0]!.name, 'list_notes')
  })

  test('braces inside JSON strings do not end the span early', () => {
    const out = run(['{"tool_call": "write_file", "args": {"path": "a.txt", "content": "use {curly} braces"}}'])
    assert.equal(out.calls.length, 1)
    assert.deepEqual(JSON.parse(out.calls[0]!.arguments), { path: 'a.txt', content: 'use {curly} braces' })
  })

  test('ordinary JSON in the answer is visible text, never executed', () => {
    const out = run(['Here is the config: {"path": "a.txt", "content": "milk"} — done.'])
    assert.equal(out.text, 'Here is the config: {"path": "a.txt", "content": "milk"} — done.')
    assert.equal(out.calls.length, 0)
  })

  test('a blob-shaped span that fails to parse becomes visible text, not a call', () => {
    const out = run(['{"tool_calls": [{"function": "x", "args": broken}]}'])
    assert.equal(out.text, '{"tool_calls": [{"function": "x", "args": broken}]}')
    assert.equal(out.calls.length, 0)
  })

  test('an unclosed blob at end of stream is dropped, not executed or shown', () => {
    const out = run(['let me look {"tool_calls": [{"function": "list_directory", "args": {"path": "~'])
    assert.equal(out.text, 'let me look ')
    assert.equal(out.calls.length, 0)
  })
})

describe('createNativeToolExtractor — bare name{args} calls, gated by the tool list', () => {
  /** Same driver as run(), but with the offered tool names supplied. */
  function runGated(
    chunks: string[],
    names: string[] = ['memory_search', 'web_search']
  ): { text: string; calls: { name: string; arguments: string }[] } {
    const extractor = createNativeToolExtractor(names)
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

  test('the observed e4b-agentic form: bare name, unquoted keys', () => {
    // Verbatim from the gemma-4-e4b-agentic-sol-fable transcript, 2026-08-03.
    const out = runGated(['memory_search{query: "hardware recommendations for 35B LLMs"}'])
    assert.equal(out.text, '')
    assert.equal(out.calls.length, 1)
    assert.equal(out.calls[0]!.name, 'memory_search')
    assert.deepEqual(JSON.parse(out.calls[0]!.arguments), {
      query: 'hardware recommendations for 35B LLMs'
    })
  })

  test('strict JSON arguments parse too', () => {
    const out = runGated(['web_search{"query": "paris weather"}'])
    assert.equal(out.calls.length, 1)
    assert.deepEqual(JSON.parse(out.calls[0]!.arguments), { query: 'paris weather' })
  })

  test('prose around a bare call is kept', () => {
    const out = runGated(['Let me check. memory_search{query: "35B LLMs"} Done.'])
    assert.equal(out.text, 'Let me check.  Done.')
    assert.equal(out.calls.length, 1)
  })

  test('an unlisted name stays prose — the gate is what makes this form safe', () => {
    const out = runGated(['remember{query: "x"}'])
    assert.equal(out.text, 'remember{query: "x"}')
    assert.equal(out.calls.length, 0)
  })

  test('no tool names supplied: bare calls stay prose (backwards compatible)', () => {
    const out = run(['memory_search{query: "x"}'])
    assert.equal(out.text, 'memory_search{query: "x"}')
    assert.equal(out.calls.length, 0)
  })

  test('a name glued to a word or a call: prefix is not a bare call', () => {
    for (const s of ['xmemory_search{query: "x"}', 'call:memory_search{query: "x"}']) {
      const out = runGated([s])
      assert.equal(out.text, s, `input: ${s}`)
      assert.equal(out.calls.length, 0, `input: ${s}`)
    }
  })

  test('a bare call split across chunks is still collected', () => {
    const out = runGated(['memory_sea', 'rch{query: "x"}'])
    assert.equal(out.text, '')
    assert.equal(out.calls.length, 1)
    assert.equal(out.calls[0]!.name, 'memory_search')
  })

  test('a partial tool name at a chunk boundary is held back, not displayed', () => {
    const extractor = createNativeToolExtractor(['memory_search'])
    const first = extractor.push('checking memory_sea')
    // "memory_sea" could still grow into memory_search{, so it waits.
    assert.equal(first.text, 'checking ')
    const second = extractor.push('rch{query: "x"}')
    assert.equal(second.calls.length, 1)
  })

  test('a suffix that is only a word, not a call, flushes out at end of stream', () => {
    const out = runGated(['I need to search'])
    // "search" is a prefix of no offered name here... and even when it is,
    // flush must emit it rather than swallow it.
    assert.equal(out.text, 'I need to search')
  })

  test('arguments broken beyond both grammars render as text, never execute', () => {
    const out = runGated(['memory_search{query: broken!}'])
    assert.equal(out.text, 'memory_search{query: broken!}')
    assert.equal(out.calls.length, 0)
  })

  test('a truncated bare call at end of stream is dropped, not executed or shown', () => {
    const out = runGated(['let me look memory_search{query: "untermina'])
    assert.equal(out.text, 'let me look ')
    assert.equal(out.calls.length, 0)
  })

  test('nested objects and arrays in lenient arguments', () => {
    const out = runGated(['web_search{query: "a } brace", options: {limit: 3, tags: ["x", "y"]}}'])
    assert.equal(out.calls.length, 1)
    assert.deepEqual(JSON.parse(out.calls[0]!.arguments), {
      query: 'a } brace',
      options: { limit: 3, tags: ['x', 'y'] }
    })
  })
})

describe('stray tokens — e4b-agentic thought/response delimiters', () => {
  test('<|response>, <response> and </thought> never render mid-answer', () => {
    const out = run(['The answer.</thought> More. <|response> Even more. <response> End.'])
    assert.equal(out.text, 'The answer. More.  Even more.  End.')
    assert.equal(out.calls.length, 0)
  })

  test('<|thought> mid-answer is stripped, not shown', () => {
    const out = run(['Here you go. <|thought>late thought'])
    assert.equal(out.text, 'Here you go. late thought')
  })
})
