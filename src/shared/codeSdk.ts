import type { ToolSchema } from './tools/types'

/**
 * v2.7 Code Mode: the Python SDK a program in the Workbench calls tools
 * through — `tools.web_search(query=...)`, one `async def` per tool, generated
 * from the tool table and nothing else.
 *
 * Deterministic on purpose: tools in lexicographic order, parameters required
 * first then optional, each set sorted, so an unchanged tool set yields a
 * byte-identical module and the prompt that carries its signatures caches.
 *
 * The functions are thin: each serializes its arguments and awaits the
 * bridge, which is the app's ordinary tool path with the same allowlists,
 * budgets and audit as a native call. A program sees `{ok, output}` or a
 * `ToolError` naming the tool — never a stack, never a host path.
 */

/**
 * Tools a program may not call from inside the sandbox. The first three run
 * the sandbox themselves — a nested run would wait on the queue it is in —
 * and a consultation is a turn, not a tool.
 */
export const BRIDGE_EXCLUDED: ReadonlySet<string> = new Set(['run_python', 'analyze_file', 'market_data', 'consult_model', 'run_code'])

const PY_KEYWORDS = new Set(
  'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' ')
)

export function bridgeableTools(schemas: readonly ToolSchema[]): ToolSchema[] {
  return schemas.filter((t) => !BRIDGE_EXCLUDED.has(t.function.name)).sort((a, b) => a.function.name.localeCompare(b.function.name, 'en'))
}

function pyType(prop: Record<string, unknown> | undefined): string {
  const t = prop?.type
  const kind = Array.isArray(t) ? t.find((x) => x !== 'null') : t
  switch (kind) {
    case 'string':
      return Array.isArray(prop?.enum) ? 'str' : 'str'
    case 'integer':
      return 'int'
    case 'number':
      return 'float'
    case 'boolean':
      return 'bool'
    case 'array':
      return 'list'
    case 'object':
      return 'dict'
    default:
      return 'object'
  }
}

function pyName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1')
  return PY_KEYWORDS.has(cleaned) ? `${cleaned}_` : cleaned
}

function docstring(text: string): string {
  const safe = text.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"').trim()
  return `    """${safe}\n    """`
}

interface Param {
  wire: string
  py: string
  type: string
  required: boolean
  description: string
}

function paramsOf(schema: ToolSchema): Param[] {
  const p = schema.function.parameters as { properties?: Record<string, Record<string, unknown>>; required?: string[] }
  const required = new Set(p.required ?? [])
  const all = Object.entries(p.properties ?? {}).map(([wire, prop]) => ({
    wire,
    py: pyName(wire),
    type: pyType(prop),
    required: required.has(wire),
    description: typeof prop.description === 'string' ? prop.description : ''
  }))
  const byName = (a: Param, b: Param): number => a.py.localeCompare(b.py, 'en')
  return [...all.filter((x) => x.required).sort(byName), ...all.filter((x) => !x.required).sort(byName)]
}

/** The module's text. Every tool in `schemas` that the bridge admits becomes one function. */
export function generateSdk(schemas: readonly ToolSchema[]): string {
  const tools = bridgeableTools(schemas)
  const head = [
    '"""Sigma Oasis tools — generated from the tool table; do not edit.',
    '',
    'Each function is one of the app\'s tools, called through the app with the same',
    'allowlists, per-turn budgets and audit record as a call the model makes',
    'directly. Every function is a coroutine: `await tools.web_search(query=...)`.',
    'A refused or failed call raises ToolError naming the tool.',
    '"""',
    'import json as _json',
    'from _sigma_bridge import call as _bridge_call',
    '',
    '',
    'class ToolError(Exception):',
    '    """A tool call the app refused or that failed. The message is what the app said."""',
    '',
    '',
    'def _args(d):',
    '    return {k: v for k, v in d.items() if v is not None}',
    '',
    '',
    'async def _call(name, args):',
    '    raw = await _bridge_call(name, _json.dumps(args))',
    '    r = _json.loads(raw)',
    '    if not r.get("ok"):',
    '        raise ToolError(f"{name}: {r.get(\'error\', \'failed\')}")',
    '    return r.get("output", "")',
    ''
  ]
  const body: string[] = []
  for (const t of tools) {
    const params = paramsOf(t)
    const sig = params.map((p) => (p.required ? `${p.py}: ${p.type}` : `${p.py}: ${p.type} | None = None`))
    const argDict = params.map((p) => `${JSON.stringify(p.wire)}: ${p.py}`).join(', ')
    const paramDoc = params.length
      ? '\n\n    Parameters:\n' + params.map((p) => `      ${p.py} (${p.type}${p.required ? '' : ', optional'})${p.description ? `: ${p.description}` : ''}`).join('\n')
      : ''
    body.push(
      '',
      `async def ${pyName(t.function.name)}(${sig.length ? `*, ${sig.join(', ')}` : ''}) -> str:`,
      docstring(`${t.function.description}${paramDoc}`),
      `    return await _call(${JSON.stringify(t.function.name)}, _args({${argDict}}))`,
      ''
    )
  }
  body.push('', `__all__ = [${tools.map((t) => JSON.stringify(pyName(t.function.name))).join(', ')}, "ToolError"]`, '')
  return [...head, ...body].join('\n')
}

/** One line per tool — what the run_code description carries so the model knows what `tools` holds. */
export function sdkSignatures(schemas: readonly ToolSchema[]): string {
  return bridgeableTools(schemas)
    .map((t) => {
      const params = paramsOf(t)
      return `tools.${pyName(t.function.name)}(${params.map((p) => (p.required ? p.py : `${p.py}=None`)).join(', ')})`
    })
    .join('\n')
}
