import { dialog, ipcMain } from 'electron'
import { hostWindow } from './hostWindow'
import { promises as fs } from 'fs'
import { basename, extname } from 'path'
import { extractPdfText } from './pdf'

/**
 * Attachment ingestion: the renderer hands us absolute paths (from a file
 * picker or drag & drop via webUtils.getPathForFile), and we return
 * display-ready attachment payloads — base64 data URLs for images, extracted
 * text for text files and PDFs. Structurally mirrors the renderer's Attachment
 * type.
 *
 * PDFs go through the same extractor `fetch_webpage` uses (./pdf), which
 * refuses encrypted files, scans with no text layer, and encodings it cannot
 * decode rather than returning plausible-looking garbage. Those refusals
 * surface here as the rejection reason the user sees.
 */

interface AttachmentPayload {
  id: string
  kind: 'image' | 'file'
  name: string
  mimeType: string
  sizeBytes: number
  dataUrl?: string
  textContent?: string
  truncated?: boolean
}

interface LoadResult {
  attachments: AttachmentPayload[]
  rejected: { name: string; reason: string }[]
  /** Audio files the renderer should send to local transcription instead. */
  audioPaths: string[]
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.log', '.xml',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.env.example', '.sql', '.sh', '.bash',
  '.zsh', '.py', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.html', '.htm',
  '.css', '.scss', '.less', '.java', '.go', '.rs', '.c', '.h', '.cpp', '.hpp',
  '.cs', '.rb', '.php', '.swift', '.kt', '.kts', '.lua', '.r', '.vue', '.svelte',
  '.diff', '.patch'
])

/**
 * Audio files are never attached to the chat — they're routed to local
 * whisper transcription (main/ipc/voice.ts) and surface as `audioPaths`.
 */
export const AUDIO_EXTENSIONS = new Set([
  '.wav', '.mp3', '.ogg', '.flac', '.m4a', '.aac', '.opus', '.webm', '.aiff', '.aif'
])

/**
 * Read a text document or PDF for ingestion (attachments, memory indexing).
 * Throws on unsupported/binary files; truncates at maxChars.
 */
export async function readTextDocument(
  path: string,
  maxChars: number
): Promise<{ name: string; text: string; truncated: boolean }> {
  const name = basename(path)
  const ext = extname(path).toLowerCase()

  if (ext === '.pdf') {
    const stat = await fs.stat(path)
    if (stat.size > MAX_PDF_BYTES) {
      throw new Error(`PDF is larger than ${MAX_PDF_BYTES / 1024 / 1024} MB.`)
    }
    const outcome = extractPdfText(new Uint8Array(await fs.readFile(path)))
    // The extractor's refusals are specific and actionable — pass them through
    // rather than flattening them into "could not read the file".
    if (!outcome.ok) throw new Error(outcome.error)
    return {
      name,
      text: outcome.text.slice(0, maxChars),
      truncated: outcome.text.length > maxChars
    }
  }

  if (!TEXT_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported type "${ext || 'unknown'}" — text files and PDFs only.`)
  }
  const raw = await fs.readFile(path)
  if (raw.includes(0)) throw new Error('Binary files are not supported.')
  const text = raw.toString('utf-8')
  return { name, text: text.slice(0, maxChars), truncated: text.length > maxChars }
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_TEXT_CHARS = 20_000
/** Parsing scales with file size, and a 25 MB PDF is already far past useful. */
const MAX_PDF_BYTES = 25 * 1024 * 1024

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

async function loadOne(path: string): Promise<AttachmentPayload | { name: string; reason: string }> {
  const name = basename(path)
  const ext = extname(path).toLowerCase()
  const stat = await fs.stat(path)
  if (stat.isDirectory()) return { name, reason: 'Folders are not supported yet.' }

  if (IMAGE_MIME[ext]) {
    if (stat.size > MAX_IMAGE_BYTES) {
      return { name, reason: `Image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.` }
    }
    const data = await fs.readFile(path)
    return {
      id: uid(),
      kind: 'image',
      name,
      mimeType: IMAGE_MIME[ext],
      sizeBytes: stat.size,
      dataUrl: `data:${IMAGE_MIME[ext]};base64,${data.toString('base64')}`
    }
  }

  if (ext === '.pdf') {
    if (stat.size > MAX_PDF_BYTES) {
      return { name, reason: `PDF is larger than ${MAX_PDF_BYTES / 1024 / 1024} MB.` }
    }
    const outcome = extractPdfText(new Uint8Array(await fs.readFile(path)))
    if (!outcome.ok) return { name, reason: outcome.error }
    return {
      id: uid(),
      kind: 'file',
      name,
      mimeType: 'application/pdf',
      sizeBytes: stat.size,
      textContent: outcome.text.slice(0, MAX_TEXT_CHARS),
      truncated: outcome.text.length > MAX_TEXT_CHARS
    }
  }

  if (TEXT_EXTENSIONS.has(ext)) {
    const raw = await fs.readFile(path)
    if (raw.includes(0)) return { name, reason: 'Binary files are not supported (images and text only).' }
    const text = raw.toString('utf-8')
    return {
      id: uid(),
      kind: 'file',
      name,
      mimeType: 'text/plain',
      sizeBytes: stat.size,
      textContent: text.slice(0, MAX_TEXT_CHARS),
      truncated: text.length > MAX_TEXT_CHARS
    }
  }

  return {
    name,
    reason: `Unsupported type "${ext || 'unknown'}" — images, text files and PDFs only.`
  }
}

async function loadPaths(paths: string[]): Promise<LoadResult> {
  const result: LoadResult = { attachments: [], rejected: [], audioPaths: [] }
  for (const p of paths) {
    if (AUDIO_EXTENSIONS.has(extname(p).toLowerCase())) {
      result.audioPaths.push(p)
      continue
    }
    try {
      const loaded = await loadOne(p)
      if ('reason' in loaded) result.rejected.push(loaded)
      else result.attachments.push(loaded)
    } catch (err) {
      result.rejected.push({
        name: basename(p),
        reason: err instanceof Error ? err.message : 'Could not read the file.'
      })
    }
  }
  return result
}

export function registerAttachmentHandlers(): void {
  ipcMain.handle('attachments:pick', async (event) => {
    const win = hostWindow(event.sender)
    if (!win) return { attachments: [], rejected: [], audioPaths: [] }
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Images, text & PDF',
          extensions: [...Object.keys(IMAGE_MIME), ...TEXT_EXTENSIONS, '.pdf'].map((e) => e.slice(1))
        },
        { name: 'Audio (transcribed locally)', extensions: [...AUDIO_EXTENSIONS].map((e) => e.slice(1)) },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (canceled || filePaths.length === 0) return { attachments: [], rejected: [], audioPaths: [] }
    return loadPaths(filePaths)
  })

  ipcMain.handle('attachments:load', (_event, paths: string[]) => loadPaths(paths ?? []))
}
