import { dialog } from 'electron'
import { exec } from 'child_process'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, resolve, sep } from 'path'
import { getSettings } from '../store'
import { hostWindow } from '../hostWindow'
import { createGrant, GRANT_NOTE, useGrant } from '../grants'
import { requestPatchReview } from '../patchReview'
import { applyEdits, describeStats, unifiedDiff } from '../../../shared/patch'
import type { PatchEdit } from '../../../shared/patch'
import { declinedCall } from '../../../shared/tools/outcomes'
import { commandNotices } from '../../../shared/commandDanger'
import { recordUnauditedCommand } from '../net'
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

export type Approval = 'once' | 'granted' | 'declined'

/**
 * Ask, or find the grant. `binding` is what a grant would be bound to; `summary`
 * is the line the panel will show for it. The dialog options are the caller's.
 */
export async function approve(
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

/**
 * v4.1 (F2): the dialog for a shell command — the agent's run_command (and the
 * hooks that run through it) or the chat's terminal tool — with its destructive
 * warning and its network notice; and, once allowed, a `command` row in the
 * network log when it reaches the network. That row is the only trace of its
 * traffic the app can keep: the command's sockets are its own.
 */
export async function approveCommand(
  sender: Electron.WebContents,
  req: {
    tool: 'agent_command' | 'run_terminal_command'
    command: string
    cwd?: string
    /** What the dialog says after "In:". */
    where: string
    notices: { warning: string | null; network?: string | null }
  }
): Promise<Approval> {
  const { command, notices } = req
  const agent = req.tool === 'agent_command'
  const title = notices.warning ? 'DANGEROUS command — confirm' : agent ? 'Confirm agent command' : 'Confirm terminal command'
  const ask = agent ? 'The agent wants to run this command:' : 'A model wants to run this terminal command:'
  const approval = await approve(sender, { tool: req.tool, args: { command }, cwd: req.cwd }, command, {
    type: notices.warning ? 'error' : 'warning',
    title: notices.network && !notices.warning ? `${title} — reaches the network` : title,
    message: [notices.warning, notices.network].filter(Boolean).join('\n') || ask,
    detail:
      `${command}\n\nIn: ${req.where}\n\n` +
      (notices.network ? 'Its traffic does not pass through the egress allowlist or the proxy; the network log records only that it ran.\n\n' : '') +
      `"Always allow" lets this exact command run ${agent ? 'in this folder' : 'here'} without asking, until you revoke it under Settings → Tools.`
  })
  if (approval !== 'declined' && notices.network) recordUnauditedCommand(command, agent ? 'agent' : 'terminal')
  return approval
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

/**
 * v2.8: a reviewed write. The model proposes edits (or the whole file); the
 * app computes the diff against the file as it is and shows it in the chat;
 * the reader applies or discards; the file is written only on Apply. Unlike
 * write_file this asks every time, working directory or not — the review is
 * the point — and there is no grant for it. The model is told which happened,
 * and the diff rides the record so the reader can see it again later.
 */
const proposePatch: ToolHandler = async (args, context) => {
  const target = resolvePath(String(args.path ?? ''))
  let original = ''
  let isNew = false
  try {
    original = await fs.readFile(target, 'utf-8')
  } catch {
    isNew = true
  }
  let next: string
  if (typeof args.content === 'string') next = args.content
  else if (Array.isArray(args.edits)) {
    const applied = applyEdits(original, args.edits as PatchEdit[])
    if (!applied.ok) return { ok: false, error: applied.error }
    next = applied.text
  } else return { ok: false, error: 'Give `edits` (search/replace pairs) or `content` (the whole new file).' }
  if (next === original) return { ok: true, output: `No change: ${target} already reads that way.` }
  const { diff, stats } = unifiedDiff(original, next, target)
  const summary = describeStats(stats, isNew)
  const approved = context.reviewPatch
    ? await context.reviewPatch({ path: target, isNew, diff })
    : await requestPatchReview(context.sender, { callId: context.parentCallId, path: target, isNew, diff, stats })
  if (!approved) {
    return { ok: false, error: `${declinedCall('the user discarded this patch')}\n\n${diff}` }
  }
  await fs.mkdir(dirname(target), { recursive: true })
  await fs.writeFile(target, next, 'utf-8')
  return { ok: true, output: `Applied to ${target}: ${summary}.\n\n${diff}` }
}

const listDirectory: ToolHandler = async (args) => {
  const entries = await fs.readdir(resolvePath(String(args.path ?? '')), { withFileTypes: true })
  const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
  return { ok: true, output: truncate(lines.join('\n') || '(empty directory)') }
}

const runTerminalCommand: ToolHandler = async (args, { sender }) => {
  const command = String(args.command ?? '')
  // The directory is part of what is approved, so it is read before the
  // dialog and the run uses the same value — a settings change in between
  // cannot move an approved command somewhere else.
  const cwd = getSettings().workingDirectory || undefined
  const approval = await approveCommand(sender, {
    tool: 'run_terminal_command',
    command,
    cwd,
    where: cwd ?? '(your home directory)',
    notices: commandNotices(command)
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
  propose_patch: proposePatch,
  list_directory: listDirectory,
  run_terminal_command: runTerminalCommand
} satisfies Record<string, ToolHandler>
