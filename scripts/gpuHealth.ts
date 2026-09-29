/**
 * The GPU's error counter, for the eval runners (v4.0, E9).
 *
 * Both `eval:agent` baseline attempts on 2026-09-28 were lost to the bench
 * GPU's PCIe link — corrected errors by the thousand a minute, then LM Studio
 * dead mid-case — and nothing in the run said so until the owner read the
 * driver's counters. So a runner reads the counter before it starts and after
 * each case, and a case during which it moved is marked *machine*: excluded
 * and named, never scored, the way a server failure already is.
 *
 * Plain Node, no Electron: the same parsers `src/main/ipc/gpu.ts` uses.
 */
import { execFileSync } from 'child_process'
import { parseNvidiaCsv, parseReplays } from '../src/main/ipc/gpu'

export interface GpuReading {
  name: string
  memoryBytes: number
  pcieReplays: number | null
}

/** What nvidia-smi says right now, or null where there is no nvidia-smi. */
export function readGpuSync(): GpuReading | null {
  try {
    const csv = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { encoding: 'utf8', timeout: 4000, windowsHide: true })
    const parsed = parseNvidiaCsv(csv)
    if (!parsed) return null
    let replays: number | null = null
    try {
      replays = parseReplays(execFileSync('nvidia-smi', ['-q', '-d', 'PCIE'], { encoding: 'utf8', timeout: 4000, windowsHide: true }))
    } catch {
      replays = null
    }
    return { ...parsed, pcieReplays: replays }
  } catch {
    return null
  }
}

/** The counter moved between two readings: the machine, not the model, is what the run measured. */
export function machineMoved(before: GpuReading | null, after: GpuReading | null): { moved: boolean; delta: number } {
  if (!before || !after || before.pcieReplays === null || after.pcieReplays === null) return { moved: false, delta: 0 }
  const delta = after.pcieReplays - before.pcieReplays
  return { moved: delta > 0, delta }
}

export function describeGpu(g: GpuReading | null): string {
  if (!g) return 'GPU: no nvidia-smi here; error counters not read'
  const gb = (g.memoryBytes / 1024 ** 3).toFixed(0)
  return `GPU: ${g.name}, ${gb} GB${g.pcieReplays === null ? '' : `, PCIe replays since reset: ${g.pcieReplays}`}`
}
