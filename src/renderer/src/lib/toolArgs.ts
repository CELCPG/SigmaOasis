/**
 * Validate a model's tool-call arguments against the tool's own JSON schema.
 *
 * Small models' dominant tool failure is a missing or misnamed field, not a
 * wrong tool — and today those calls execute anyway. This validator is the
 * checker both consumers share: the tool-choice eval harness scores
 * arg-validity with it, and the agent loop's repair round (strategy Layer 3a)
 * uses the same messages to tell the model what to fix.
 *
 * It implements the subset of JSON Schema the shipped tool schemas use —
 * `type`, `properties`, `required`, `enum`, `items` — and deliberately no
 * more. Unknown keywords are ignored; unknown extra properties are allowed
 * (no shipped schema sets `additionalProperties: false`). No dependencies.
 */

export interface ArgValidation {
  ok: boolean
  /** Human-readable problems, phrased so they can be fed back to the model. */
  errors: string[]
}

type JsonSchema = {
  type?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  enum?: unknown[]
  items?: JsonSchema
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function checkValue(name: string, value: unknown, schema: JsonSchema, errors: string[]): void {
  if (schema.enum && !schema.enum.some((v) => v === value)) {
    errors.push(`\`${name}\` must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`)
    return
  }
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') errors.push(`\`${name}\` must be a string, got ${typeOf(value)}`)
      break
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`\`${name}\` must be a number, got ${typeOf(value)}`)
      }
      break
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`\`${name}\` must be a boolean, got ${typeOf(value)}`)
      break
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`\`${name}\` must be an array, got ${typeOf(value)}`)
        break
      }
      if (schema.items) {
        value.forEach((item, i) => checkValue(`${name}[${i}]`, item, schema.items as JsonSchema, errors))
      }
      break
    }
    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`\`${name}\` must be an object, got ${typeOf(value)}`)
      }
      break
    default:
      // No declared type: nothing to check.
      break
  }
}

/**
 * Check `args` against a tool's `parameters` schema. The `args` from a model
 * is `unknown` by the time JSON.parse is done with it — non-object arguments
 * are reported, never coerced.
 */
export function validateToolArgs(parameters: Record<string, unknown>, args: unknown): ArgValidation {
  const errors: string[] = []
  const schema = parameters as JsonSchema

  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { ok: false, errors: [`arguments must be an object, got ${typeOf(args)}`] }
  }
  const record = args as Record<string, unknown>

  for (const key of schema.required ?? []) {
    if (record[key] === undefined) {
      const expected = schema.properties?.[key]?.type
      errors.push(`\`${key}\` is required${expected ? ` and must be a ${expected}` : ''}`)
    }
  }
  for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
    if (record[key] !== undefined) checkValue(key, record[key], propSchema, errors)
  }

  return { ok: errors.length === 0, errors }
}
