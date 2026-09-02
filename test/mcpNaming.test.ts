import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { assignWireNames, isMcpWireName, wireName, WIRE_NAME_MAX } from '../src/main/ipc/mcp/naming'
import { splitMcpWireName } from '../src/shared/mcpNames'
import { TOOL_DEFS } from '../src/shared/tools'

describe('MCP wire names', () => {
  test('a clean name is the prefix, the server and the tool', () => {
    assert.equal(wireName('github', 'create_issue'), 'mcp__github__create_issue')
    assert.ok(isMcpWireName(wireName('github', 'create_issue')))
    assert.ok(!isMcpWireName('read_file'))
  })

  test('a name that had to be sanitized carries the identity hash', () => {
    const a = wireName('my server', 'read.file')
    assert.match(a, /^mcp__my_server__read_file_[0-9a-f]{12}$/)
    // and is a pure function of its inputs
    assert.equal(a, wireName('my server', 'read.file'))
  })

  test('two raw names that sanitize alike never collapse', () => {
    assert.notEqual(wireName('s', 'read.file'), wireName('s', 'read/file'))
  })

  test('a long name is cut to the wire limit and still unique', () => {
    const long = 'a'.repeat(100)
    const n = wireName('server', long)
    assert.ok(n.length <= WIRE_NAME_MAX)
    assert.match(n, /_[0-9a-f]{12}$/)
    assert.notEqual(n, wireName('server', `${long}b`))
  })

  test('wire names match the wire contract', () => {
    for (const raw of ['ok', 'has space', 'café', '../../x', '']) {
      assert.match(wireName('srv', raw), /^[A-Za-z0-9_-]{1,64}$/)
    }
  })

  test('a list that shadows a built-in or itself is refused whole', () => {
    const builtIns = new Set(['read_file', 'mcp__fs__read_file'])
    assert.deepEqual(assignWireNames('fs', ['read_file'], builtIns), {
      ok: false,
      error: 'tool "read_file" would shadow the built-in "mcp__fs__read_file"'
    })
    const r = assignWireNames('fs', ['list', 'stat'], new Set(['read_file']))
    assert.ok(r.ok && r.names.get('list') === 'mcp__fs__list' && r.names.get('stat') === 'mcp__fs__stat')
    const other = assignWireNames('fs', ['list'], new Set(), new Set(['mcp__fs__list']))
    assert.ok(!other.ok && /another server/.test(other.error))
  })
})

describe('MCP names and the built-ins', () => {
  test('no built-in tool wears the MCP prefix, so a wire name can never be mistaken for one', () => {
    for (const d of TOOL_DEFS) assert.ok(!isMcpWireName(d.name), d.name)
  })

  test('a wire name splits back into its server and tool for display', () => {
    assert.deepEqual(splitMcpWireName('mcp__github__create_issue'), { server: 'github', tool: 'create_issue' })
    assert.deepEqual(splitMcpWireName(wireName('my server', 'read.file')), { server: 'my_server', tool: splitMcpWireName(wireName('my server', 'read.file'))!.tool })
    assert.equal(splitMcpWireName('read_file'), null)
  })
})
