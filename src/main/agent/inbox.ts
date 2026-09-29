/**
 * Files into an agent chat (v4.0, C6 — an experiment, off by default).
 *
 * A file dropped on an agent chat is copied into the folder's
 * `.sigma/inbox/` — the one place the task may read it from without the
 * folder picker — and the model is told where it landed. Names that
 * collide get a numbered suffix; nothing is overwritten. A task with no
 * folder has no inbox: the app makes it a scratch folder first.
 *
 * Plain Node.
 */
import { promises as fs } from 'fs'
import { basename, extname, join } from 'path'

export const INBOX_DIR = join('.sigma', 'inbox')
const MAX_INBOX_FILES = 20
const MAX_INBOX_BYTES = 200 * 1024 * 1024

export interface InboxResult {
  /** Workspace-relative paths, `/`-separated, in the order given. */
  copied: string[]
  skipped: { path: string; reason: string }[]
}

/** Copy `paths` into the workspace's inbox. Never throws for one bad file. */
export async function copyToInbox(workspace: string, paths: readonly string[]): Promise<InboxResult> {
  const inbox = join(workspace, INBOX_DIR)
  await fs.mkdir(inbox, { recursive: true })
  const copied: string[] = []
  const skipped: InboxResult['skipped'] = []
  for (const p of paths.slice(0, MAX_INBOX_FILES)) {
    try {
      const st = await fs.stat(p)
      if (!st.isFile()) {
        skipped.push({ path: p, reason: 'not a file' })
        continue
      }
      if (st.size > MAX_INBOX_BYTES) {
        skipped.push({ path: p, reason: 'over 200 MB' })
        continue
      }
      const name = await freeName(inbox, basename(p))
      await fs.copyFile(p, join(inbox, name))
      copied.push(`${INBOX_DIR.split(/[\\/]/).join('/')}/${name}`)
    } catch (err) {
      skipped.push({ path: p, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  for (const p of paths.slice(MAX_INBOX_FILES)) skipped.push({ path: p, reason: `more than ${MAX_INBOX_FILES} files at once` })
  return { copied, skipped }
}

async function freeName(dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = name
  for (let n = 2; n < 1000; n++) {
    try {
      await fs.stat(join(dir, candidate))
      candidate = `${stem} (${n})${ext}`
    } catch {
      return candidate
    }
  }
  return candidate
}

export { inboxNote } from '../../shared/slashCommands'
