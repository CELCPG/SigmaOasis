import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { validateToolArgs } from '../src/renderer/src/lib/toolArgs'
import { TOOL_SCHEMAS } from '../src/shared/tools'

/**
 * The validator scores the eval's arg-validity rate and will word the repair
 * message the loop feeds back to the model — so its messages are pinned here,
 * not just its verdicts.
 */

function schemaOf(tool: string): Record<string, unknown> {
  const found = TOOL_SCHEMAS.find((t) => t.function.name === tool)
  assert.ok(found, `tool ${tool} exists`)
  return found.function.parameters
}

describe('validateToolArgs', () => {
  test('valid arguments pass, including optional fields', () => {
    const result = validateToolArgs(schemaOf('fetch_webpage'), {
      url: 'https://example.com',
      query: 'pricing',
      max_passages: 3
    })
    assert.deepEqual(result, { ok: true, errors: [] })
  })

  test('a missing required field names the field and its type', () => {
    const result = validateToolArgs(schemaOf('read_file'), {})
    assert.equal(result.ok, false)
    assert.deepEqual(result.errors, ['`path` is required and must be a string'])
  })

  test('a wrong-typed field says what arrived', () => {
    const result = validateToolArgs(schemaOf('memory_search'), { query: 'x', topK: 'three' })
    assert.equal(result.ok, false)
    assert.deepEqual(result.errors, ['`topK` must be a number, got string'])
  })

  test('enum violations list the allowed values', () => {
    const result = validateToolArgs(schemaOf('deep_research'), {
      question: 'q',
      depth: 'exhaustive'
    })
    assert.equal(result.ok, false)
    assert.deepEqual(result.errors, ['`depth` must be one of "quick", "standard", "thorough"'])
  })

  test('array items are checked element by element', () => {
    const bad = validateToolArgs(schemaOf('shop_compare'), { product: 'laptop', brands: ['apple', 42] })
    assert.equal(bad.ok, false)
    assert.deepEqual(bad.errors, ['`brands[1]` must be a string, got number'])
    const good = validateToolArgs(schemaOf('shop_compare'), { product: 'laptop', brands: ['apple'] })
    assert.equal(good.ok, true)
  })

  test('schemaless tools accept empty arguments', () => {
    assert.equal(validateToolArgs(schemaOf('get_current_datetime'), {}).ok, true)
    assert.equal(validateToolArgs(schemaOf('list_notes'), {}).ok, true)
  })

  test('extra properties are allowed — no shipped schema forbids them', () => {
    const result = validateToolArgs(schemaOf('web_search'), { query: 'x', surprise: true })
    assert.equal(result.ok, true)
  })

  test('non-object arguments are reported, never coerced', () => {
    assert.deepEqual(validateToolArgs(schemaOf('web_search'), 'a query'), {
      ok: false,
      errors: ['arguments must be an object, got string']
    })
    assert.deepEqual(validateToolArgs(schemaOf('web_search'), null).ok, false)
    assert.deepEqual(validateToolArgs(schemaOf('web_search'), [1, 2]).ok, false)
  })

  test('nested object arguments (shop_requirements.answers) check as objects', () => {
    const good = validateToolArgs(schemaOf('shop_requirements'), {
      need: 'laptop',
      answers: { primary_use: 'editing' }
    })
    assert.equal(good.ok, true)
    const bad = validateToolArgs(schemaOf('shop_requirements'), { need: 'laptop', answers: 'editing' })
    assert.equal(bad.ok, false)
    assert.deepEqual(bad.errors, ['`answers` must be an object, got string'])
  })
})

describe('TOOL_SCHEMAS integrity', () => {
  test('names are unique and every schema is a function with an object body', () => {
    const names = TOOL_SCHEMAS.map((t) => t.function.name)
    assert.equal(new Set(names).size, names.length)
    for (const t of TOOL_SCHEMAS) {
      assert.equal(t.type, 'function')
      assert.equal((t.function.parameters as { type?: string }).type, 'object')
      assert.ok(t.function.description.length > 0, `${t.function.name} has a description`)
    }
  })

  test('the toolbox the eval grades is the full shipped set', () => {
    assert.deepEqual(
      TOOL_SCHEMAS.map((t) => t.function.name),
      [
        'read_file', 'write_file', 'list_directory', 'run_terminal_command',
        'web_search', 'image_search', 'fetch_webpage', 'deep_research', 'finance_calculator',
        'geo_locate', 'date_calculator', 'get_current_datetime', 'create_note', 'list_notes', 'read_note',
        'memory_save', 'memory_search', 'memory_forget', 'reference_lookup', 'run_code', 'run_python', 'analyze_file',
        'shop_requirements', 'shop_compare', 'price_watch', 'market_data'
      ]
    )
  })
})
