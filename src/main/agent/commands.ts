/**
 * Slash commands (v4.0, C7 — an experiment, off by default; 3.2's D2).
 *
 * `.sigma/commands/<name>.md` in the folder, and the app's own folder of
 * them, become `/name` in the composer of an agent chat and in `sigma`. The
 * expansion is shared/slashCommands.ts, so the composer needs no file
 * access; this reads the files. A recipe (./recipes.ts) is a method; a
 * command is a shortcut to typing.
 *
 * Plain Node.
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { COMMAND_NAME_RE, type SlashCommand } from '../../shared/slashCommands'

export { expandCommand, type SlashCommand } from '../../shared/slashCommands'

export const COMMANDS_DIR = join('.sigma', 'commands')
const MAX_COMMAND_CHARS = 8_000

/** The commands in one directory, by name; a missing directory is none. */
export async function loadCommandsFrom(dir: string, source: SlashCommand['source']): Promise<SlashCommand[]> {
  let names: string[]
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.md')).sort()
  } catch {
    return []
  }
  const out: SlashCommand[] = []
  for (const file of names) {
    const name = file.slice(0, -3).toLowerCase()
    if (!COMMAND_NAME_RE.test(name)) continue
    const body = (await fs.readFile(join(dir, file), 'utf8').catch(() => '')).replace(/\r\n/g, '\n').trim().slice(0, MAX_COMMAND_CHARS)
    if (!body) continue
    out.push({ name, summary: body.split('\n')[0]!.replace(/^#+\s*/, '').slice(0, 120), body, source })
  }
  return out
}

/** The folder's commands, then the app's; a folder command wins a name. */
export async function loadCommands(workspace: string | null, appDir: string | null): Promise<SlashCommand[]> {
  const folder = workspace ? await loadCommandsFrom(join(workspace, COMMANDS_DIR), 'folder') : []
  const app = appDir ? await loadCommandsFrom(appDir, 'app') : []
  const seen = new Set(folder.map((c) => c.name))
  return [...folder, ...app.filter((c) => !seen.has(c.name))]
}
