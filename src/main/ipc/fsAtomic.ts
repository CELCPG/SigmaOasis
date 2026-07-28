import { promises as fs } from 'fs'
import { basename, dirname, join } from 'path'

/**
 * Write a file atomically: content goes to a temp file in the same directory
 * and is then renamed over the target. rename() is atomic within a volume, so
 * a crash (or a quit) mid-write leaves the previous version intact instead of
 * a truncated one — the stores here rewrite whole JSON documents every time.
 */
let sequence = 0

export async function writeFileAtomic(file: string, data: string): Promise<void> {
  // The temp name must be unique per call, not just per process: two
  // overlapping writes to the same file would otherwise share one temp path,
  // and the second rename would fail after the first moved it away.
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${sequence++}.tmp`)
  try {
    await fs.writeFile(tmp, data, 'utf-8')
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined)
    throw err
  }
}
