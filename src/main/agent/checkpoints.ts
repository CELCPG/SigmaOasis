import { promises as fs } from 'fs'
import { join } from 'path'
import type { Checkpoint } from './types'

/**
 * Undo, the one implementation (v3.1).
 *
 * Put every file a turn changed back the way it found it — unless the file
 * has changed since the task last wrote it, in which case the edit that came
 * after is somebody's work, and it is left alone and named. Newest first, so
 * a file the turn created and then another step edited unwinds in order.
 *
 * The app's Undo button, the CLI's `/undo` and the agent eval all call this,
 * so what `eval:agent` scores as "Undo restored the folder" is the Undo users
 * get, not a copy of it.
 */

export interface RestoreResult {
  restored: string[]
  skipped: { path: string; reason: string }[]
}

export async function restoreCheckpoints(workspace: string, checkpoints: readonly Checkpoint[]): Promise<RestoreResult> {
  const restored: string[] = []
  const skipped: { path: string; reason: string }[] = []
  for (const cp of [...checkpoints].reverse()) {
    const abs = join(workspace, cp.path)
    const now = await fs.readFile(abs, 'utf8').catch(() => null)
    if (now !== cp.after) {
      skipped.push({ path: cp.path, reason: now === null ? 'it has been deleted since' : 'it has been changed since the task wrote it' })
      continue
    }
    try {
      if (cp.before === null) await fs.rm(abs, { force: true })
      else await fs.writeFile(abs, cp.before, 'utf8')
      restored.push(cp.path)
    } catch (err) {
      skipped.push({ path: cp.path, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return { restored, skipped }
}
