import { app, ipcMain } from 'electron'
import { existsSync, promises as fs } from 'fs'
import { homedir } from 'os'
import { delimiter, dirname, join } from 'path'

/**
 * The `sigma` command (v3.0): putting the CLI on the user's PATH.
 *
 * The CLI is one bundled file shipped in the app's resources (built by
 * scripts/build-cli.mjs). It runs on the app's own runtime — the launcher sets
 * ELECTRON_RUN_AS_NODE and hands the script to the app's binary, as VS Code's
 * `code` command does — so installing it needs no Node and no admin rights:
 *
 * - Windows: `sigma.cmd` in %LOCALAPPDATA%\Microsoft\WindowsApps, a folder
 *   Windows puts on every user's PATH (it is where app execution aliases
 *   live). Falls back to a folder of our own when that one is not there.
 * - macOS and Linux: `~/.local/bin/sigma`, the conventional per-user bin; the
 *   panel says so when that folder is not on the PATH this app was started with.
 *
 * Nothing here runs the CLI or touches the network; it writes one small text
 * file, or removes it.
 */

export interface CliStatus {
  /** Where the launcher is (or would go). */
  launcher: string
  installed: boolean
  /** The launcher points at this install — false after the app has moved. */
  current: boolean
  /** The launcher's folder is on the PATH this app was started with. */
  onPath: boolean
  /** The bundled script exists (false in a dev tree that has not run build:cli). */
  bundled: boolean
  script: string
}

function scriptPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'cli', 'sigma.js') : join(app.getAppPath(), 'out', 'cli', 'sigma.js')
}

function launcherPath(): string {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    const aliases = join(local, 'Microsoft', 'WindowsApps')
    return existsSync(aliases) ? join(aliases, 'sigma.cmd') : join(local, 'Programs', 'Sigma Oasis CLI', 'sigma.cmd')
  }
  return join(homedir(), '.local', 'bin', 'sigma')
}

/** The launcher's text. Exported for the check suite. */
export function launcherText(platform: NodeJS.Platform, runtime: string, script: string): string {
  if (platform === 'win32') {
    return [
      '@echo off',
      'rem Sigma Oasis CLI launcher — installed from Settings → Agent. Runs the CLI on the app\'s own runtime.',
      'setlocal',
      'set "ELECTRON_RUN_AS_NODE=1"',
      `"${runtime}" "${script}" %*`,
      ''
    ].join('\r\n')
  }
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  return [
    '#!/bin/sh',
    "# Sigma Oasis CLI launcher — installed from Settings → Agent. Runs the CLI on the app's own runtime.",
    `ELECTRON_RUN_AS_NODE=1 exec ${q(runtime)} ${q(script)} "$@"`,
    ''
  ].join('\n')
}

export async function cliStatus(): Promise<CliStatus> {
  const launcher = launcherPath()
  const script = scriptPath()
  const expected = launcherText(process.platform, process.execPath, script)
  const existing = await fs.readFile(launcher, 'utf8').catch(() => null)
  const norm = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase()
  const paths = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).map(norm)
  return {
    launcher,
    installed: existing !== null,
    current: existing === expected,
    onPath: paths.includes(norm(dirname(launcher))),
    bundled: existsSync(script),
    script
  }
}

export async function installCli(): Promise<{ ok: boolean; status?: CliStatus; error?: string }> {
  const script = scriptPath()
  if (!existsSync(script)) {
    return { ok: false, error: `The CLI is not built into this copy of the app (${script}). Run npm run build:cli.` }
  }
  const launcher = launcherPath()
  try {
    // A `sigma` somebody else put there is theirs; it is not overwritten.
    const existing = await fs.readFile(launcher, 'utf8').catch(() => null)
    if (existing !== null && !existing.includes('Sigma Oasis CLI launcher')) {
      return { ok: false, error: `${launcher} already exists and was not written by Sigma Oasis; it was left alone.` }
    }
    await fs.mkdir(dirname(launcher), { recursive: true })
    await fs.writeFile(launcher, launcherText(process.platform, process.execPath, script), { encoding: 'utf8', mode: 0o755 })
    if (process.platform !== 'win32') await fs.chmod(launcher, 0o755)
    return { ok: true, status: await cliStatus() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function uninstallCli(): Promise<{ ok: boolean; status?: CliStatus; error?: string }> {
  const launcher = launcherPath()
  try {
    // Only a launcher this app wrote: a `sigma` somebody else put there stays.
    const text = await fs.readFile(launcher, 'utf8').catch(() => null)
    if (text !== null && !text.includes('Sigma Oasis CLI launcher')) {
      return { ok: false, error: `${launcher} was not written by Sigma Oasis; it was left alone.` }
    }
    await fs.rm(launcher, { force: true })
    return { ok: true, status: await cliStatus() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerCliHandlers(): void {
  ipcMain.handle('cli:status', () => cliStatus())
  ipcMain.handle('cli:install', () => installCli())
  ipcMain.handle('cli:uninstall', () => uninstallCli())
}
