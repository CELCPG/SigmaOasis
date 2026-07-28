import { app, ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getSettings } from './store'

/**
 * Speech-to-text via whisper.cpp, run as a local child process — no cloud,
 * no telemetry. The renderer records 16 kHz mono WAV (see lib/voice.ts) and
 * sends the bytes here; we write a temp file and invoke whisper-cli.
 *
 * The CLI and model are auto-detected (settings overrides win), so users who
 * `brew install whisper-cpp` and download a ggml model get voice input
 * without any configuration.
 */

interface SttStatus {
  available: boolean
  cliPath: string | null
  modelPath: string | null
  reason?: string
}

const IS_WINDOWS = process.platform === 'win32'

const CLI_CANDIDATES = IS_WINDOWS
  ? [
      join(homedir(), '.local', 'bin', 'whisper-cli.exe'),
      join(homedir(), 'whisper.cpp', 'build', 'bin', 'Release', 'whisper-cli.exe'),
      join(homedir(), 'scoop', 'shims', 'whisper-cli.exe'),
      'C:\\Program Files\\whisper.cpp\\whisper-cli.exe',
      'C:\\ProgramData\\chocolatey\\bin\\whisper-cli.exe'
    ]
  : [
      join(homedir(), '.local', 'bin', 'whisper-cli'),
      '/opt/homebrew/bin/whisper-cli',
      '/usr/local/bin/whisper-cli',
      '/opt/homebrew/bin/whisper-cpp-main', // older brew formula name
      '/usr/local/bin/whisper-cpp-main'
    ]

const MODEL_DIRS = [
  join(homedir(), '.cache', 'whisper'),
  join(homedir(), 'whisper.cpp', 'models'),
  join(homedir(), 'models', 'whisper'),
  ...(IS_WINDOWS ? [join(homedir(), 'AppData', 'Local', 'whisper')] : [])
]

/** Install hint for the current platform, shown when the CLI is missing. */
const INSTALL_HINT = IS_WINDOWS
  ? 'whisper.cpp CLI (download whisper-cli.exe from the whisper.cpp releases, or set its path below)'
  : 'whisper.cpp CLI (install with: brew install whisper-cpp)'

const TRANSCRIBE_TIMEOUT_MS = 120_000

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/** Locate a command on PATH — `where` on Windows, `which` elsewhere. */
function which(cmd: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const [bin, args] = IS_WINDOWS
      ? ['where', [cmd]]
      : ['/usr/bin/which', [cmd]]
    execFile(bin, args as string[], { shell: IS_WINDOWS }, (err, stdout) => {
      const found = stdout.trim().split(/\r?\n/)[0]
      resolvePromise(err || !found ? null : found.trim())
    })
  })
}

async function detectCli(): Promise<string | null> {
  const custom = getSettings().stt.whisperCliPath.trim()
  if (custom && (await exists(custom))) return custom

  for (const candidate of CLI_CANDIDATES) {
    if (await exists(candidate)) return candidate
  }
  return (await which('whisper-cli')) ?? (IS_WINDOWS ? which('main') : null)
}

async function detectModel(): Promise<string | null> {
  const custom = getSettings().stt.whisperModelPath.trim()
  if (custom && (await exists(custom))) return custom

  for (const dir of MODEL_DIRS) {
    try {
      const files = await fs.readdir(dir)
      const model = files
        .filter((f) => /^ggml-.*\.bin$/.test(f))
        // Prefer smaller/faster English models when several are present.
        .sort((a, b) => {
          const rank = (f: string): number =>
            f.includes('tiny') ? 0 : f.includes('base') ? 1 : f.includes('small') ? 2 : 3
          return rank(a) - rank(b) || a.localeCompare(b)
        })[0]
      if (model) return join(dir, model)
    } catch {
      // directory doesn't exist — try the next one
    }
  }
  return null
}

async function sttStatus(): Promise<SttStatus> {
  const cliPath = await detectCli()
  const modelPath = await detectModel()
  if (cliPath && modelPath) return { available: true, cliPath, modelPath }

  const missing: string[] = []
  if (!cliPath) missing.push(INSTALL_HINT)
  if (!modelPath) {
    missing.push(
      'a ggml model file (e.g. ggml-base.en.bin — see Settings → Voice to set its location)'
    )
  }
  return {
    available: false,
    cliPath,
    modelPath,
    reason: `Voice input needs ${missing.join(' and ')}.`
  }
}

export function registerVoiceHandlers(): void {
  ipcMain.handle('voice:sttStatus', () => sttStatus())

  ipcMain.handle('voice:transcribe', async (_event, wav: ArrayBuffer) => {
    const status = await sttStatus()
    if (!status.available || !status.cliPath || !status.modelPath) {
      return { ok: false, error: status.reason ?? 'Speech-to-text is not set up.' }
    }
    if (!wav || wav.byteLength < 100) {
      return { ok: false, error: 'The recording was empty — try again.' }
    }

    const wavPath = join(app.getPath('temp'), `openmind-stt-${Date.now()}.wav`)
    try {
      await fs.writeFile(wavPath, Buffer.from(wav))

      const text = await new Promise<string>((resolvePromise, rejectPromise) => {
        execFile(
          status.cliPath!,
          ['-m', status.modelPath!, '-f', wavPath, '--no-timestamps'],
          { timeout: TRANSCRIBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
          (err, stdout, stderr) => {
            if (err) {
              rejectPromise(new Error(stderr.trim() || err.message))
            } else {
              resolvePromise(stdout)
            }
          }
        )
      })

      // whisper-cli echoes blank lines / leading whitespace around the transcript.
      const transcript = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .join(' ')
        .trim()
      return transcript
        ? { ok: true, text: transcript }
        : { ok: false, error: 'No speech detected in the recording.' }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      await fs.unlink(wavPath).catch(() => undefined)
    }
  })
}
