import { execFile } from 'child_process'
import { ipcMain } from 'electron'
import { totalmem } from 'os'

/**
 * What this machine's GPU is, and whether it is well (v4.0, E1 and E9).
 *
 * Read from the vendor's own tool when there is one — `nvidia-smi` on the
 * bench machine — and never guessed: the app says what the tool said, or
 * nothing. Two numbers matter. The card's memory, so a model's fit can be
 * judged before the first slow reply (E1). And the PCIe replay counter, the
 * corrected-error count that flooded on the bench machine on 2026-09-28 and
 * lost both agent baselines: a run whose counter moved measured the machine,
 * not the model (E9). On Apple silicon the GPU shares system memory, which
 * `os.totalmem()` reports; there is no error counter to read.
 */
export interface GpuInfo {
  /** The tool the numbers came from. */
  source: 'nvidia-smi' | 'unified-memory'
  name: string
  memoryBytes: number
  /** PCIe replays since the driver reset; null where no tool reports it. */
  pcieReplays: number | null
}

const TIMEOUT_MS = 4_000

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: TIMEOUT_MS, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)))
    } catch {
      resolve(null)
    }
  })
}

/** nvidia-smi's CSV: `name, memory.total [MiB]` for the first GPU. */
export function parseNvidiaCsv(text: string): { name: string; memoryBytes: number } | null {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
  if (!line) return null
  const [name, mem] = line.split(',').map((s) => s.trim())
  const mib = Number((mem ?? '').replace(/[^\d.]/g, ''))
  if (!name || !Number.isFinite(mib) || mib <= 0) return null
  return { name, memoryBytes: Math.round(mib * 1024 * 1024) }
}

/** The replay counter out of `nvidia-smi -q`: the line "Replays Since Reset : N" (PCIe section). */
export function parseReplays(text: string): number | null {
  const m = /Replays?\s+Since\s+Reset\s*:\s*(\d+)/i.exec(text)
  return m ? Number(m[1]) : null
}

let cached: { at: number; info: GpuInfo | null } | null = null
const CACHE_MS = 15_000

export async function readGpu(force = false): Promise<GpuInfo | null> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.info
  let info: GpuInfo | null = null
  const csv = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'])
  const parsed = csv ? parseNvidiaCsv(csv) : null
  if (parsed) {
    const q = await run('nvidia-smi', ['-q', '-d', 'PCIE'])
    info = { source: 'nvidia-smi', ...parsed, pcieReplays: q ? parseReplays(q) : null }
  } else if (process.platform === 'darwin') {
    info = { source: 'unified-memory', name: 'Apple silicon (unified memory)', memoryBytes: totalmem(), pcieReplays: null }
  }
  cached = { at: Date.now(), info }
  return info
}

export function registerGpu(): void {
  ipcMain.handle('gpu:info', (_e, force?: unknown) => readGpu(Boolean(force)))
}
