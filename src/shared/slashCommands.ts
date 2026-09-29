/**
 * Slash commands, the pure half (v4.0, C7 — an experiment, off by default).
 *
 * Shared by the main process (which reads `.sigma/commands/*.md`), the
 * composer (which expands `/name args` before a task starts) and the CLI.
 * A command is text: its file's body with `$ARGUMENTS` replaced by whatever
 * followed the name.
 */

export const COMMAND_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/

export interface SlashCommand {
  name: string
  /** The first line of the file, for a list. */
  summary: string
  body: string
  /** Where it came from: the folder's `.sigma/commands` or the app's. */
  source: 'folder' | 'app'
}

/**
 * `/name the rest` → the command's body with `$ARGUMENTS` filled in; text
 * that is not a known command comes back unchanged. Only a leading slash
 * counts, so a path or a fraction in a sentence is never a command.
 */
export function expandCommand(text: string, commands: readonly SlashCommand[]): { text: string; command: SlashCommand | null } {
  const m = /^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim())
  if (!m) return { text, command: null }
  const command = commands.find((c) => c.name === m[1]!.toLowerCase())
  if (!command) return { text, command: null }
  const args = (m[2] ?? '').trim()
  const body = command.body.includes('$ARGUMENTS') ? command.body.replace(/\$ARGUMENTS/g, args) : args ? `${command.body}\n\n${args}` : command.body
  return { text: body, command }
}

/** The line the composer gets after a drop, naming where the files landed (v4.0, C6). */
export function inboxNote(result: { copied: string[]; skipped: { path: string; reason: string }[] }): string {
  const parts: string[] = []
  if (result.copied.length > 0) parts.push(`Files dropped in: ${result.copied.join(', ')}`)
  if (result.skipped.length > 0) parts.push(`Not copied: ${result.skipped.map((s) => `${s.path.split(/[\\/]/).pop() ?? s.path} (${s.reason})`).join(', ')}`)
  return parts.join('\n')
}
