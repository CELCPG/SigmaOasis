import { promises as fs } from 'fs'
import { basename } from 'path'
import { bundledPackages, runPython } from '../workbench'
import { formatRun } from '../workbenchFormat'
import { formatProfile, parseProfile, profileScript } from '../workbenchProfile'
import { truncate } from './types'
import type { ToolContext, ToolHandler } from './types'

/**
 * The Workbench's tool faces: run_python and analyze_file. Local, sandboxed
 * (WASM, no network, no real filesystem), one job at a time. Not prefixed
 * UNTRUSTED_HEADER: the output is the product of code run on the user's own
 * files in this turn.
 *
 * Attachments reach the sandbox by being staged under /work from their
 * original path at tool time (ToolContext.attachments) — the sandbox never
 * mounts the disk; it receives bytes.
 */
const MAX_RUN_OUTPUT_CHARS = 12_000
/** Per file and per job, so a stray 2 GB export cannot be shipped into WASM memory. */
const MAX_STAGED_FILE_BYTES = 40 * 1024 * 1024
const MAX_STAGED_TOTAL_BYTES = 64 * 1024 * 1024

interface StagedFiles {
  files: { name: string; data: Buffer }[]
  notes: string[]
}

/** Read the conversation's attachments for /work. Latest attachment wins on a name clash. */
async function stageAttachments(context: ToolContext, only?: string): Promise<StagedFiles> {
  const refs = context.attachments ?? []
  const byName = new Map<string, string>()
  for (const r of refs) byName.set(basename(r.name), r.sourcePath)
  const files: StagedFiles['files'] = []
  const notes: string[] = []
  let total = 0
  for (const [name, path] of byName) {
    if (only && name !== only) continue
    try {
      const stat = await fs.stat(path)
      if (stat.size > MAX_STAGED_FILE_BYTES) {
        notes.push(`${name} was not staged: ${Math.round(stat.size / 1024 / 1024)} MB exceeds the ${MAX_STAGED_FILE_BYTES / 1024 / 1024} MB per-file limit.`)
        continue
      }
      if (total + stat.size > MAX_STAGED_TOTAL_BYTES) {
        notes.push(`${name} was not staged: the ${MAX_STAGED_TOTAL_BYTES / 1024 / 1024} MB per-run limit was reached.`)
        continue
      }
      files.push({ name, data: await fs.readFile(path) })
      total += stat.size
    } catch (err) {
      notes.push(`${name} could not be read from its original location (${err instanceof Error ? err.message : String(err)}).`)
    }
  }
  return { files, notes }
}

const runPythonTool: ToolHandler = async (args, context) => {
  const code = String(args.code ?? '')
  if (!code.trim()) return { ok: false, error: 'Provide the Python code to run in `code`.' }
  const requested = Number(args.timeout_seconds)
  const timeoutMs = Number.isFinite(requested) ? Math.round(requested * 1000) : undefined
  const staged = await stageAttachments(context)
  const outcome = await runPython({ code, files: staged.files, timeoutMs })
  const formatted = formatRun(outcome, code)
  if (!formatted.ok && /ModuleNotFoundError|No module named/.test(formatted.error ?? '')) {
    const pk = await bundledPackages()
    formatted.error += `\n\nThe sandbox is offline: only the standard library${pk.length ? ` and these packages are available: ${pk.join(', ')}` : ' is available'}. Rewrite without the missing module.`
  }
  const stagedNote =
    staged.files.length > 0
      ? `\n\nFiles available under /work: ${staged.files.map((f) => f.name).join(', ')}.`
      : ''
  const notes = staged.notes.length ? `\n\n${staged.notes.map((n) => `Note: ${n}`).join('\n')}` : ''
  return formatted.ok
    ? { ok: true, output: truncate(`${formatted.output ?? ''}${stagedNote}${notes}`, MAX_RUN_OUTPUT_CHARS), images: formatted.images }
    : { ok: false, error: truncate(`${formatted.error ?? 'run failed'}${stagedNote}${notes}`, MAX_RUN_OUTPUT_CHARS), images: formatted.images }
}

const analyzeFileTool: ToolHandler = async (args, context) => {
  const refs = context.attachments ?? []
  if (refs.length === 0) {
    return { ok: false, error: 'No file is attached to this conversation. Attach a CSV, TSV, JSON or XLSX file, then call analyze_file with its name.' }
  }
  const names = [...new Set(refs.map((r) => basename(r.name)))]
  const requested = String(args.file ?? '').trim()
  const file = requested ? names.find((n) => n === requested) ?? names.find((n) => n.toLowerCase() === requested.toLowerCase()) : names.length === 1 ? names[0] : undefined
  if (!file) {
    return {
      ok: false,
      error: requested
        ? `No attached file named "${requested}". Attached: ${names.join(', ')}.`
        : `Several files are attached — say which: ${names.join(', ')}.`
    }
  }
  const sheet = typeof args.sheet === 'string' && args.sheet.trim() ? args.sheet.trim() : null
  const staged = await stageAttachments(context, file)
  if (staged.files.length === 0) {
    return { ok: false, error: staged.notes.join(' ') || `${file} could not be read.` }
  }
  const outcome = await runPython({ code: profileScript(file, sheet), files: staged.files, timeoutMs: 120_000 })
  const profile = parseProfile(outcome.stdout)
  if (!profile) {
    const why = outcome.error ?? outcome.stderr ?? 'no report produced'
    return { ok: false, error: `Could not profile ${file}: ${truncate(why, 1500)}` }
  }
  return { ok: !profile.error, output: profile.error ? undefined : truncate(formatProfile(profile), MAX_RUN_OUTPUT_CHARS), error: profile.error ? formatProfile(profile) : undefined }
}

export const workbenchHandlers = {
  run_python: runPythonTool,
  analyze_file: analyzeFileTool
} satisfies Record<string, ToolHandler>
