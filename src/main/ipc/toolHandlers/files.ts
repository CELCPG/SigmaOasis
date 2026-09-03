import { dialog } from 'electron'
import { exec } from 'child_process'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, resolve, sep } from 'path'
import { getSettings } from '../store'
import { hostWindow } from '../hostWindow'
import { createGrant, GRANT_NOTE, useGrant } from '../grants'
import { declinedCall } from '../../../shared/tools/outcomes'
import { truncate } from './types'
import type { ToolHandler, ToolResult } from './types'

/**
 * Local filesystem and shell tools: read_file, write_file, list_directory,
 * run_terminal_command.
 *
 * v2.6: the two confirmations gain "Always allow". The answer mints a
 * standing grant (../grants.ts) bound to the exact call — the command and the
 * working directory it will run in, or the resolved file path — and a later
 * call that matches runs without a dialog and says so in its output. A call
 * that differs by a byte asks. No window still means decline: a grant is
 * consulted only where a dialog could have been raised, so an unattended
 * process cannot run under one.
 */

const TERMINAL_TIMEOUT_MS = 30_000

/** The three answers, in button order; the index is what the dialog returns. */
const APPROVAL_BUTTONS = ['Allow once', 'Always allow', 'Cancel'] as const
const ALLOW_ONCE = 0
const ALWAYS_ALLOW = 1
const CANCEL = 2

type Approval = 'once' | 'granted' | 'declined'

/**
 * Ask, or find the grant. `binding` is what a grant would be bound to; `summary`
 * is the line the panel will show for it. The dialog options are the caller's.
 */
async function approve(
  sender: Electron.WebContents,
  binding: { tool: string; args: Record<string, unknown>; cwd?: string },
  summary: string,
  box: Omit<Electron.MessageBoxOptions, 'buttons' | 'defaultId' | 'cancelId'>
): Promise<Approval> {
  const win = hostWindow(sender)
  if (!win) return 'declined' // window closed — nobody to ask; decline, grant or not
  if (await useGrant(binding)) return 'granted'
  const { response } = await dialog.showMessageBox(win, {
    ...box,
    buttons: [...APPROVAL_BUTTONS],
    defaultId: CANCEL,
    cancelId: CANCEL
  })
  if (response === ALWAYS_ALLOW) {
    await createGrant(binding, summary)
    return 'once'
  }
  return response === ALLOW_ONCE ? 'once' : 'declined'
}

/** The configured working directory, resolved — or null when none is set. */
function workingRoot(): string | null {
  const root = getSettings().workingDirectory.trim()
  return root ? resolve(root) : null
}

/**
 * Relative paths resolve against the configured working directory (fallback:
 * home). When a working directory is set it is also a boundary — absolute
 * paths and `..` escapes outside it are refused, so the models can only touch
 * the tree the user scoped them to. (Symlinks inside the root are followed as
 * the OS resolves them; the root is a scoping tool, not a sandbox.)
 */
export function resolvePath(p: string): string {
  const root = workingRoot()
  const resolved = isAbsolute(p) ? resolve(p) : resolve(root ?? homedir(), p)
  if (root && resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(
      `"${resolved}" is outside the working directory (${root}). Change or clear it under Settings → Tools.`
    )
  }
  return resolved
}

/**
 * Writes outside a scoped working directory need explicit user approval. A
 * grant here is bound to the resolved path alone — content changes on every
 * write, and "always allow writes to this file" is the thing worth granting.
 */
function confirmWrite(sender: Electron.WebContents, target: string, chars: number): Promise<Approval> {
  return approve(sender, { tool: 'write_file', args: { path: target } }, target, {
    type: 'warning',
    title: 'Confirm file write',
    message: 'A model wants to write to a file outside any scoped working directory:',
    detail:
      `${target}\n\n${chars} character(s) — this overwrites the file if it exists.\n\n` +
      '"Always allow" lets any future write to this exact path through without asking, until you revoke it under Settings → Tools.'
  })
}

/**
 * Command shapes that are destructive even when the user means well. They
 * still can run — the user is in charge — but the confirmation dialog spells
 * out the danger instead of presenting them as routine.
 */
const DANGEROUS_COMMAND_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'recursive force delete', re: /\brm\s+[^\n]*-[a-zA-Z]*[rf][a-zA-Z]*\s/ },
  { label: 'writes directly to a disk device', re: /\bdd\b[^\n]*\bof=\/dev\// },
  { label: 'disk format / partition', re: /\b(mkfs|fdisk|diskpart|newfs)[.\w]*\b/ },
  { label: 'pipes a remote script into a shell', re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b/ },
  { label: 'fork bomb shape', re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/ },
  { label: 'broad permission change', re: /\bchmod\s+(-R\s+)?777\s+[~/]/ },
  { label: 'system-wide removal', re: /\brm\s+[^\n]*-[a-zA-Z]*[rf][a-zA-Z]*\s+(--no-preserve-root\s+)?[/~]/ }
]

export function dangerousCommandWarning(command: string): string | null {
  const hits = DANGEROUS_COMMAND_PATTERNS.filter((p) => p.re.test(command)).map((p) => p.label)
  return hits.length > 0 ? `⚠️ Potentially destructive: ${hits.join('; ')}.` : null
}

const readFile: ToolHandler = async (args) => {
  const content = await fs.readFile(resolvePath(String(args.path ?? '')), 'utf-8')
  return { ok: true, output: truncate(content) }
}

const writeFile: ToolHandler = async (args, { sender }) => {
  const target = resolvePath(String(args.path ?? ''))
  const content = String(args.content ?? '')
  // A working directory means the user already scoped where writes may
  // land; without one, every write is confirmed.
  let approval: Approval = 'once'
  if (!workingRoot()) {
    approval = await confirmWrite(sender, target, content.length)
    if (approval === 'declined') {
      // Declined, not failed: nothing was written, and the row must say which.
      return { ok: false, error: declinedCall('the user declined this file write') }
    }
  }
  await fs.mkdir(dirname(target), { recursive: true })
  await fs.writeFile(target, content, 'utf-8')
  return {
    ok: true,
    output: `Wrote ${content.length} characters to ${target}${approval === 'granted' ? ` ${GRANT_NOTE}` : ''}`
  }
}

const listDirectory: ToolHandler = async (args) => {
  const entries = await fs.readdir(resolvePath(String(args.path ?? '')), { withFileTypes: true })
  const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
  return { ok: true, output: truncate(lines.join('\n') || '(empty directory)') }
}

const runTerminalCommand: ToolHandler = async (args, { sender }) => {
  const command = String(args.command ?? '')
  const warning = dangerousCommandWarning(command)
  // The directory is part of what is approved, so it is read before the
  // dialog and the run uses the same value — a settings change in between
  // cannot move an approved command somewhere else.
  const cwd = getSettings().workingDirectory || undefined
  const approval = await approve(sender, { tool: 'run_terminal_command', args: { command }, cwd }, command, {
    type: warning ? 'error' : 'warning',
    title: warning ? 'DANGEROUS command — confirm' : 'Confirm terminal command',
    message: warning ?? 'A model wants to run this terminal command:',
    detail:
      `${command}\n\nIn: ${cwd ?? '(your home directory)'}\n\n` +
      '"Always allow" lets this exact command run here without asking, until you revoke it under Settings → Tools.'
  })
  if (approval === 'declined') {
    return { ok: false, error: declinedCall('the user declined to run this command') }
  }
  return await new Promise<ToolResult>((resolvePromise) => {
    exec(command, { cwd, timeout: TERMINAL_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const combined = [stdout, stderr].filter(Boolean).join('\n').trim()
      if (error && !combined) {
        resolvePromise({ ok: false, error: `Command failed: ${error.message}` })
      } else {
        const output = truncate(combined || '(command completed with no output)')
        resolvePromise({ ok: true, output: approval === 'granted' ? `${output}\n${GRANT_NOTE}` : output })
      }
    })
  })
}

export const fileHandlers = {
  read_file: readFile,
  write_file: writeFile,
  list_directory: listDirectory,
  run_terminal_command: runTerminalCommand
} satisfies Record<string, ToolHandler>
