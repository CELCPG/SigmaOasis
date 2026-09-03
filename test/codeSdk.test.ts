import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { BRIDGE_EXCLUDED, bridgeableTools, generateSdk, sdkSignatures } from '../src/shared/codeSdk'
import { TOOL_SCHEMAS } from '../src/shared/tools'
import type { ToolSchema } from '../src/shared/tools/types'

/**
 * v2.7 Code Mode: the SDK is a pure function of the tool table — the same
 * table, the same bytes — and it never admits a tool that would re-enter the
 * sandbox from inside itself.
 */

const tool = (name: string, properties: Record<string, unknown>, required: string[] = []): ToolSchema => ({
  type: 'function',
  function: { name, description: `Does ${name}.`, parameters: { type: 'object', properties, required } }
})

describe('the Code Mode SDK', () => {
  test('byte-identical for an unchanged tool set, whatever the input order', () => {
    const a = generateSdk(TOOL_SCHEMAS)
    const b = generateSdk([...TOOL_SCHEMAS].reverse())
    assert.equal(a, b)
    assert.equal(a, generateSdk(TOOL_SCHEMAS))
  })

  test('the tools that run the sandbox, and consultation, are never in it', () => {
    const names = bridgeableTools(TOOL_SCHEMAS).map((t) => t.function.name)
    for (const x of BRIDGE_EXCLUDED) assert.ok(!names.includes(x), x)
    assert.ok(names.includes('web_search'))
    assert.ok(names.includes('reference_lookup'))
    assert.deepEqual(names, [...names].sort((x, y) => x.localeCompare(y, 'en')))
  })

  test('a function per tool: required parameters first, optional ones default to None and are dropped', () => {
    const sdk = generateSdk([
      tool('zeta', { b: { type: 'string' }, a: { type: 'integer' }, limit: { type: 'number', description: 'How many' } }, ['b', 'a']),
      tool('alpha', {}, [])
    ])
    assert.ok(sdk.indexOf('async def alpha(') < sdk.indexOf('async def zeta('))
    assert.match(sdk, /async def alpha\(\) -> str:/)
    assert.match(sdk, /async def zeta\(\*, a: int, b: str, limit: float \| None = None\) -> str:/)
    assert.match(sdk, /return await _call\("zeta", _args\(\{"a": a, "b": b, "limit": limit\}\)\)/)
    assert.match(sdk, /limit \(float, optional\): How many/)
    assert.match(sdk, /__all__ = \["alpha", "zeta", "ToolError"\]/)
  })

  test('a parameter that is a Python keyword or has odd characters gets a safe name, and the wire name is kept', () => {
    const sdk = generateSdk([tool('t', { from: { type: 'string' }, 'max-results': { type: 'integer' } }, ['from'])])
    assert.match(sdk, /async def t\(\*, from_: str, max_results: int \| None = None\)/)
    assert.match(sdk, /_args\(\{"from": from_, "max-results": max_results\}\)/)
  })

  test('descriptions become docstrings and cannot break out of them', () => {
    const t = tool('q', {}, [])
    t.function.description = 'Ends with """ and a \\ backslash'
    const sdk = generateSdk([t])
    assert.match(sdk, /"""Ends with \\"\\"\\" and a \\\\ backslash/)
  })

  test('the signature list is one line per tool, in the same order', () => {
    const lines = sdkSignatures(TOOL_SCHEMAS).split('\n')
    assert.equal(lines.length, bridgeableTools(TOOL_SCHEMAS).length)
    assert.ok(lines.some((l) => /^tools\.web_search\(query\)$/.test(l)), lines.join('\n'))
    assert.ok(lines.every((l) => l.startsWith('tools.')))
  })
})
