import { runPython } from '../workbench'
import { formatRun } from '../workbenchFormat'
import { truncate } from './types'
import type { ToolHandler } from './types'

/**
 * run_python — the Workbench's tool face. Local, sandboxed (WASM, no network,
 * no real filesystem), one job at a time. Not prefixed UNTRUSTED_HEADER: the
 * output is the product of code the model itself wrote in this turn.
 */
const MAX_RUN_OUTPUT_CHARS = 12_000

const runPythonTool: ToolHandler = async (args) => {
  const code = String(args.code ?? '')
  if (!code.trim()) return { ok: false, error: 'Provide the Python code to run in `code`.' }
  const requested = Number(args.timeout_seconds)
  const timeoutMs = Number.isFinite(requested) ? Math.round(requested * 1000) : undefined
  const outcome = await runPython({ code, timeoutMs })
  const formatted = formatRun(outcome, code)
  return formatted.ok
    ? { ok: true, output: truncate(formatted.output ?? '', MAX_RUN_OUTPUT_CHARS), images: formatted.images }
    : { ok: false, error: truncate(formatted.error ?? 'run failed', MAX_RUN_OUTPUT_CHARS), images: formatted.images }
}

export const workbenchHandlers = {
  run_python: runPythonTool
} satisfies Record<string, ToolHandler>
