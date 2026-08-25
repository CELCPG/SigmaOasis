import type { WorkbenchOutcome } from './workbench'

/**
 * How a run_python outcome is shown to the model and the user. Pure, so the
 * shape is pinned by tests without a sandbox.
 */

const MAX_STDOUT_SHOWN = 6000
const MAX_STDERR_SHOWN = 3000
const MAX_TEXT_FILE_INLINE = 4000
/** Image files handed to the chat gallery; the CSP renders data: images only. */
const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const TEXT_EXT = new Set(['.txt', '.csv', '.tsv', '.json', '.md', '.log', '.html', '.svg', '.xml', '.py'])
/** Total data-URL chars a gallery may carry — same ceiling as image search. */
const MAX_GALLERY_CHARS = 256 * 1024

/**
 * v1.11.2: the sentence appended when a run's stdout contains no number that
 * the code could have computed — every one of them appears as a literal in
 * the code itself. Measured in a real session: asked for volatile stocks, the
 * model wrote `nvda_range = (10, 20)` … `print(...)` and the app then told it
 * "Numbers above were computed, not recalled" — laundering invented figures
 * into computed ones with the app's own voice. The renderer keys on this
 * marker too (toolGrounding), so laundered constants also stop counting as
 * support for the reply's figures.
 */
export const HARDCODED_NUMBERS_NOTE =
  'Caution: every number in this output appears as a literal in the code — nothing was computed. ' +
  'These are values you supplied, not results. Do not present them as computed or verified; if they ' +
  'came from memory or assumption, say so plainly.'

/** Numeric tokens of a blob, as values (commas stripped), for the literal check. */
function numericValues(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const v = Number(m[0].replace(/,/g, ''))
    if (Number.isFinite(v)) out.push(v)
  }
  return out
}

/**
 * True when stdout states at least one number and every number it states is a
 * literal already present in the code (including inside its string constants).
 * One genuinely derived value — a sum, a ratio, a length — clears the run,
 * so mixed runs keep the normal banner; this only catches pure echo.
 */
export function numbersLookHardcoded(code: string, stdout: string): boolean {
  const printed = numericValues(stdout)
  if (printed.length === 0) return false
  const literals = new Set(numericValues(code))
  return printed.every((v) => literals.has(v))
}

/**
 * v1.12.4: the sentence that carries the one-time runtime start. `durationMs`
 * only ever covered execution, so the boot — seconds of it — was attributed to
 * nobody and the first run of a session read as the fastest one. It is stated
 * as its own section rather than folded into the run time because it is a
 * session cost, not this snippet's: the same code is not a thousand times
 * slower the first time it is asked for.
 */
function bootLine(bootMs: number): string {
  return `The sandbox started for this run: ${bootMs} ms (one-time; later runs in this conversation skip it).`
}

export interface FormattedRun {
  ok: boolean
  output?: string
  error?: string
  images?: { title: string; pageUrl: string; dataUrl: string }[]
}

function ext(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

function clip(text: string, max: number, what: string): string {
  return text.length > max ? `${text.slice(0, max)}\n… [${what} truncated, ${text.length - max} more characters]` : text
}

export function formatRun(outcome: WorkbenchOutcome, code: string): FormattedRun {
  const parts: string[] = []
  const stdout = outcome.stdout.trimEnd()
  const stderr = outcome.stderr.trimEnd()
  const images: FormattedRun['images'] = []
  const fileLines: string[] = []
  let galleryChars = 0

  for (const f of outcome.files) {
    const e = ext(f.name)
    const mime = IMAGE_MIME[e]
    if (mime) {
      const dataUrl = `data:${mime};base64,${f.data.toString('base64')}`
      if (galleryChars + dataUrl.length <= MAX_GALLERY_CHARS) {
        galleryChars += dataUrl.length
        images.push({ title: f.name, pageUrl: '', dataUrl })
        fileLines.push(`- ${f.name} (${f.data.length.toLocaleString('en-US')} bytes, image — shown to the user)`)
      } else {
        fileLines.push(`- ${f.name} (${f.data.length.toLocaleString('en-US')} bytes, image — not shown: gallery size limit)`)
      }
    } else if (TEXT_EXT.has(e) && f.data.length <= MAX_TEXT_FILE_INLINE) {
      fileLines.push(`- ${f.name} (${f.data.length.toLocaleString('en-US')} bytes):\n\`\`\`\n${f.data.toString('utf-8')}\n\`\`\``)
    } else {
      fileLines.push(`- ${f.name} (${f.data.length.toLocaleString('en-US')} bytes)`)
    }
  }

  if (!outcome.ok) {
    const err = outcome.error ?? 'Python raised an error.'
    const body = [
      `Python run failed after ${outcome.durationMs} ms.`,
      outcome.bootMs ? bootLine(outcome.bootMs) : '',
      stdout ? `stdout before the error:\n${clip(stdout, MAX_STDOUT_SHOWN, 'stdout')}` : '',
      `error:\n${clip(err, MAX_STDERR_SHOWN, 'traceback')}`,
      stderr && !err.includes(stderr.slice(0, 80)) ? `stderr:\n${clip(stderr, MAX_STDERR_SHOWN, 'stderr')}` : '',
      outcome.restarted ? 'The sandbox was restarted; any state from earlier runs is gone.' : '',
      'Fix the code and run again — do not guess at the value it would have produced.'
    ].filter(Boolean)
    return { ok: false, error: body.join('\n\n'), images: images.length ? images : undefined }
  }

  parts.push(`Python ran in ${outcome.durationMs} ms.`)
  if (outcome.bootMs) parts.push(bootLine(outcome.bootMs))
  if (stdout) parts.push(`stdout:\n${clip(stdout, MAX_STDOUT_SHOWN, 'stdout')}`)
  if (outcome.result !== null && outcome.result !== '' && outcome.result !== 'None') parts.push(`result (last expression): ${outcome.result}`)
  if (stderr) parts.push(`stderr:\n${clip(stderr, MAX_STDERR_SHOWN, 'stderr')}`)
  if (fileLines.length) parts.push(`files written under /work:\n${fileLines.join('\n')}`)
  if (!stdout && (outcome.result === null || outcome.result === 'None') && fileLines.length === 0) {
    parts.push('(no output — print() what you want to see, or end with an expression)')
  }
  parts.push(
    stdout && numbersLookHardcoded(code, stdout)
      ? HARDCODED_NUMBERS_NOTE
      : 'Numbers above were computed, not recalled: state them exactly as shown, with units, and say they came from running code.'
  )
  return { ok: true, output: parts.join('\n\n'), images: images.length ? images : undefined }
}
