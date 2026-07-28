import { app, ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { extname, join } from 'path'
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

/** 16 kHz mono PCM16 — 10 minutes is far beyond any push-to-talk clip. */
const MAX_WAV_BYTES = 16_000 * 2 * 60 * 10

/**
 * whisper.cpp hallucinates on silence (classic outputs: "you", "Thank you.",
 * "[BLANK_AUDIO]"). Gate on RMS energy before ever invoking the CLI, and
 * filter residual noise-only transcripts below.
 */
const MIN_RMS = 0.004

/** Whole-transcript phrases whisper emits for noise/silence (lowercased). */
const SILENCE_HALLUCINATIONS = new Set([
  'you',
  'thank you',
  'thank you.',
  'thanks',
  'thanks for watching',
  'thanks for watching!',
  'bye',
  'bye bye',
  '.',
  '..'
])

/** RMS amplitude of 16-bit PCM data inside a WAV buffer (0–1 scale). */
function wavRms(wav: Buffer): number {
  // Locate the "data" chunk rather than assuming a 44-byte header.
  let offset = 12
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'data') {
      const start = offset + 8
      const end = Math.min(start + size, wav.length - 1)
      if (end <= start) return 0
      let sum = 0
      let count = 0
      for (let i = start; i + 1 < end; i += 2) {
        const s = wav.readInt16LE(i) / 0x8000
        sum += s * s
        count++
      }
      return count > 0 ? Math.sqrt(sum / count) : 0
    }
    offset += 8 + size + (size % 2) // chunks are word-aligned
  }
  return 0
}

/** Strips whisper noise tokens and known silence hallucinations. */
function cleanTranscript(raw: string): string {
  const text = raw
    // Bracketed/parenthesized whisper tokens: [BLANK_AUDIO], (silence), [ Music ]
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  return SILENCE_HALLUCINATIONS.has(text.toLowerCase()) ? '' : text
}

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

/** Audio formats whisper.cpp reads natively. */
const WHISPER_NATIVE = new Set(['.wav', '.mp3', '.ogg', '.flac'])
/** Formats we convert to WAV first (via macOS afconvert). */
const CONVERTIBLE = new Set(['.m4a', '.aac', '.opus', '.webm', '.aiff', '.aif'])
/** File transcription gets a longer budget than push-to-talk clips. */
const FILE_TRANSCRIBE_TIMEOUT_MS = 600_000
const MAX_AUDIO_FILE_BYTES = 200 * 1024 * 1024

function runWhisper(
  cliPath: string,
  modelPath: string,
  audioPath: string,
  timeoutMs = TRANSCRIBE_TIMEOUT_MS
): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      cliPath,
      ['-m', modelPath, '-f', audioPath, '--no-timestamps'],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          rejectPromise(new Error(stderr.trim() || err.message))
        } else {
          resolvePromise(stdout)
        }
      }
    )
  })
}

/** Convert any CoreAudio-supported format to 16 kHz mono WAV (macOS only). */
function afconvertToWav(src: string, dst: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      '/usr/bin/afconvert',
      ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', src, dst],
      { timeout: 60_000 },
      (err, _stdout, stderr) => (err ? rejectPromise(new Error(stderr.trim() || err.message)) : resolvePromise())
    )
  })
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
    if (wav.byteLength > MAX_WAV_BYTES) {
      return { ok: false, error: 'The recording is too long — keep voice clips under 10 minutes.' }
    }

    const wavBuffer = Buffer.from(wav)
    // Silence gate: whisper hallucinates plausible-looking text on quiet
    // noise, so don't invoke it at all when nothing was said.
    if (wavRms(wavBuffer) < MIN_RMS) {
      return { ok: false, error: 'No speech detected — check your microphone and try again.' }
    }

    const wavPath = join(app.getPath('temp'), `sigmaoasis-stt-${Date.now()}.wav`)
    try {
      await fs.writeFile(wavPath, wavBuffer)
      const text = await runWhisper(status.cliPath, status.modelPath, wavPath)
      // whisper-cli echoes blank lines / noise tokens around the transcript.
      const transcript = cleanTranscript(text)
      return transcript
        ? { ok: true, text: transcript }
        : { ok: false, error: 'No speech detected in the recording.' }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      await fs.unlink(wavPath).catch(() => undefined)
    }
  })

  // Transcribe a dropped/picked audio file (voice memo, meeting recording…).
  ipcMain.handle('voice:transcribeFile', async (_event, filePath: string) => {
    const status = await sttStatus()
    if (!status.available || !status.cliPath || !status.modelPath) {
      return { ok: false, error: status.reason ?? 'Speech-to-text is not set up.' }
    }
    const ext = extname(String(filePath ?? '')).toLowerCase()
    if (!WHISPER_NATIVE.has(ext) && !CONVERTIBLE.has(ext)) {
      return { ok: false, error: `Unsupported audio type "${ext || 'unknown'}".` }
    }
    const stat = await fs.stat(filePath).catch(() => null)
    if (!stat?.isFile()) return { ok: false, error: 'File not found.' }
    if (stat.size > MAX_AUDIO_FILE_BYTES) {
      return { ok: false, error: 'That audio file is too large (200 MB max).' }
    }

    let audioPath = filePath
    let converted: string | null = null
    if (!WHISPER_NATIVE.has(ext)) {
      if (process.platform !== 'darwin') {
        return {
          ok: false,
          error: `Files of type "${ext}" need conversion first — use wav, mp3, ogg or flac on this platform.`
        }
      }
      converted = join(app.getPath('temp'), `sigmaoasis-stt-${Date.now()}.wav`)
      try {
        await afconvertToWav(filePath, converted)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      audioPath = converted
    }

    try {
      const text = await runWhisper(
        status.cliPath,
        status.modelPath,
        audioPath,
        FILE_TRANSCRIBE_TIMEOUT_MS
      )
      const transcript = cleanTranscript(text)
      return transcript
        ? { ok: true, text: transcript }
        : { ok: false, error: 'No speech detected in this file.' }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      if (converted) await fs.unlink(converted).catch(() => undefined)
    }
  })
}
