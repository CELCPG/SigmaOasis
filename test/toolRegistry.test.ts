import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { installStubs, load, resetState } from './harness'

installStubs()

/**
 * The tool dispatch table has three legs that must agree: the schemas the
 * model sees (toolSchemas.ts), the toggles the user controls (store.ts
 * ToolToggles — pinned at compile time by the registry's type), and the
 * handlers that run (toolHandlers/registry.ts). A schema with no handler is a
 * tool the model can call and always fails; a handler with no schema is dead
 * code. Both are silent without this test.
 */
type Registry = {
  TOOL_HANDLERS: Record<string, unknown>
  TOOL_NAMES: string[]
  executeTool: (
    name: string,
    args: Record<string, unknown>,
    context: { sender: unknown; modelId?: string }
  ) => Promise<{ ok: boolean; output?: string; error?: string }>
}
type Schemas = { TOOL_SCHEMAS: { function: { name: string } }[] }

const registry = load<Registry>('toolHandlers/registry')
const { TOOL_SCHEMAS } = load<Schemas>('toolSchemas')
const context = { sender: {} as unknown }

describe('tool registry', () => {
  test('every schema has a handler and every handler has a schema', () => {
    const schemaNames = TOOL_SCHEMAS.map((t) => t.function.name).sort()
    const handlerNames = [...registry.TOOL_NAMES].sort()
    assert.deepEqual(handlerNames, schemaNames)
  })

  test('handlers are functions', () => {
    for (const name of registry.TOOL_NAMES) {
      assert.equal(typeof registry.TOOL_HANDLERS[name], 'function', name)
    }
  })

  test('an unknown tool is a readable error, not a throw', async () => {
    const result = await registry.executeTool('no_such_tool', {}, context)
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /Unknown tool "no_such_tool"/)
  })

  test('a handler exception becomes an ok:false result the model can read', async () => {
    resetState()
    // read_file with a path that cannot exist — fs throws, executeTool catches.
    const result = await registry.executeTool(
      'read_file',
      { path: '/definitely/not/a/real/path/sigma-oasis-test-file.txt' },
      context
    )
    assert.equal(result.ok, false)
    assert.ok(result.error && result.error.length > 0)
  })

  test('a pure calculator dispatches end to end', async () => {
    const result = await registry.executeTool(
      'date_calculator',
      { operation: 'difference', from: '2026-01-01', to: '2026-01-31' },
      context
    )
    assert.equal(result.ok, true, result.error)
    assert.match(result.output ?? '', /30 day\(s\)/)
  })
})

describe('reference_lookup through the registry', () => {
  test('an empty library is an honest ok result, not an error', async () => {
    resetState()
    const lib = load<typeof import('../src/main/ipc/library')>('library')
    lib.setLibraryDirForTests(require('path').join(require('os').tmpdir(), `sigma-reg-lib-${process.pid}`))
    const result = await registry.executeTool('reference_lookup', { query: 'burns' }, context)
    assert.equal(result.ok, true, result.error)
    assert.match(result.output ?? '', /No reference passages found/)
    assert.match(result.output ?? '', /do not invent a reference/)
    lib.setLibraryDirForTests(null)
  })
  test('a blank query is refused', async () => {
    const result = await registry.executeTool('reference_lookup', { query: '  ' }, context)
    assert.equal(result.ok, false)
  })
})
