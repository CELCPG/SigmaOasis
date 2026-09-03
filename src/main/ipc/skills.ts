import { app, dialog, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join, resolve } from 'path'
import { hostWindow } from './hostWindow'
import { installPackFromDirectory, validateManifest } from './library'
import { mcpManager } from './mcp'
import { getSettings, normalizeMcpServers, saveMcpServers } from './store'
import { writeFileAtomic } from './fsAtomic'
import { describeSkillForConfirmation, validateSkillManifest } from '../../shared/skills'
import type { InstalledSkill, SkillManifest } from '../../shared/skills'

/**
 * v2.7: skills, installed from a folder (shared/skills.ts has the format).
 *
 * The folder is copied whole into userData/skills/<id>/ — never referenced,
 * so editing or deleting the source later cannot change what a skill says.
 * Its pack is installed like any pack; its MCP server is saved switched off
 * under the id `skill-<id>` and confirmed in the same dialog, with the same
 * words the MCP tab uses; its helper files are staged into the Workbench by
 * name when the skill rides a turn. One confirmation lists all of it before
 * anything is written. There is no registry and no URL install.
 */

const MAX_SKILLS = 50
const MAX_FOLDER_BYTES = 32 * 1024 * 1024

interface InstallRecord {
  installedAt: string
  packId?: string
  mcpServerId?: string
}

function skillsDir(): string {
  return join(app.getPath('userData'), 'skills')
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T
  } catch {
    return null
  }
}

async function folderBytes(dir: string): Promise<number> {
  let total = 0
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) total += await folderBytes(p)
    else if (e.isFile()) total += (await fs.stat(p)).size
    if (total > MAX_FOLDER_BYTES) break
  }
  return total
}

/** Read and check a folder without installing anything. */
export async function inspectSkillFolder(sourceDir: string): Promise<{ manifest: SkillManifest; packId?: string }> {
  const raw = await readJson<unknown>(join(sourceDir, 'skill.json'))
  if (!raw) throw new Error(`No skill.json in ${sourceDir}.`)
  const manifest = validateSkillManifest(raw)
  if (manifest.playbook) await fs.access(join(sourceDir, manifest.playbook)).catch(() => { throw new Error(`The method file "${manifest.playbook}" is missing.`) })
  for (const h of manifest.helpers ?? []) await fs.access(join(sourceDir, h)).catch(() => { throw new Error(`The helper "${h}" is missing.`) })
  let packId: string | undefined
  if (manifest.pack) {
    const packRaw = await readJson<unknown>(join(sourceDir, manifest.pack, 'manifest.json'))
    if (!packRaw) throw new Error(`The pack folder "${manifest.pack}" has no manifest.json.`)
    packId = validateManifest(packRaw).id
  }
  if ((await folderBytes(sourceDir)) > MAX_FOLDER_BYTES) throw new Error(`The skill folder is over ${MAX_FOLDER_BYTES / 1024 / 1024} MB.`)
  return { manifest, packId }
}

export async function listSkills(): Promise<InstalledSkill[]> {
  const dir = skillsDir()
  let entries: string[]
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
  } catch {
    return []
  }
  const out: InstalledSkill[] = []
  for (const id of entries.sort()) {
    const raw = await readJson<unknown>(join(dir, id, 'skill.json'))
    if (!raw) continue
    let manifest: SkillManifest
    try {
      manifest = validateSkillManifest(raw)
    } catch {
      continue
    }
    if (manifest.id !== id) continue
    const record = (await readJson<InstallRecord>(join(dir, id, '.installed.json'))) ?? { installedAt: '' }
    let playbookText: string | undefined
    if (manifest.playbook) playbookText = (await fs.readFile(join(dir, id, manifest.playbook), 'utf-8').catch(() => '')) || undefined
    out.push({ ...manifest, ...(playbookText ? { playbookText } : {}), ...(record.packId ? { packId: record.packId } : {}), ...(record.mcpServerId ? { mcpServerId: record.mcpServerId } : {}), installedAt: record.installedAt })
  }
  // Install order: the first installed is matched first.
  return out.sort((a, b) => a.installedAt.localeCompare(b.installedAt))
}

/** The helper files a skill stages into /work, named `<id>_<file>` so two skills cannot collide. */
export async function skillHelperRefs(id: string): Promise<{ name: string; sourcePath: string }[]> {
  const skill = (await listSkills()).find((s) => s.id === id)
  if (!skill?.helpers) return []
  return skill.helpers.map((h) => ({ name: `${id}_${h}`, sourcePath: join(skillsDir(), id, h) }))
}

/** Copy the folder in, install its pack, save its server switched off. The caller has confirmed. */
export async function installSkill(sourceDir: string): Promise<InstalledSkill> {
  const { manifest, packId } = await inspectSkillFolder(sourceDir)
  const existing = await listSkills()
  if (existing.length >= MAX_SKILLS && !existing.some((s) => s.id === manifest.id)) throw new Error(`Too many skills (${MAX_SKILLS}).`)
  const target = join(skillsDir(), manifest.id)
  const staging = join(skillsDir(), `.${manifest.id}.installing`)
  await fs.rm(staging, { recursive: true, force: true })
  await fs.mkdir(skillsDir(), { recursive: true })
  await fs.cp(resolve(sourceDir), staging, { recursive: true, dereference: false, filter: (src) => !src.includes(`${join(sourceDir, '.git')}`) })
  const record: InstallRecord = { installedAt: new Date().toISOString() }
  if (manifest.pack && packId) {
    await installPackFromDirectory(join(staging, manifest.pack), { replace: true })
    record.packId = packId
  }
  if (manifest.mcp) {
    const serverId = `skill-${manifest.id}`.slice(0, 32)
    const [config] = normalizeMcpServers([
      { id: serverId, name: `${manifest.name} (skill)`, command: manifest.mcp.command, args: manifest.mcp.args, env: manifest.mcp.env, cwd: manifest.mcp.cwd, enabled: false, disabledTools: [], approval: 'ask' }
    ])
    if (config) {
      saveMcpServers([...(getSettings().mcp?.servers ?? []).filter((s) => s.id !== serverId), config])
      await mcpManager().apply(getSettings().mcp?.servers ?? [])
      record.mcpServerId = serverId
    }
  }
  await writeFileAtomic(join(staging, '.installed.json'), JSON.stringify(record, null, 2))
  await fs.rm(target, { recursive: true, force: true })
  await fs.rename(staging, target)
  return (await listSkills()).find((s) => s.id === manifest.id)!
}

/** Remove the skill and its server; its pack stays in the library, which says so. */
export async function removeSkill(id: string): Promise<{ removed: boolean; packLeft?: string }> {
  const skill = (await listSkills()).find((s) => s.id === id)
  if (!skill) return { removed: false }
  await fs.rm(join(skillsDir(), id), { recursive: true, force: true })
  if (skill.mcpServerId) {
    saveMcpServers((getSettings().mcp?.servers ?? []).filter((s) => s.id !== skill.mcpServerId))
    await mcpManager().apply(getSettings().mcp?.servers ?? [])
  }
  return { removed: true, ...(skill.packId ? { packLeft: skill.packId } : {}) }
}

export function registerSkillHandlers(): void {
  ipcMain.handle('skills:list', () => listSkills())

  ipcMain.handle('skills:install', async (event, path?: unknown) => {
    const win = hostWindow(event.sender)
    if (!win) return { ok: false, error: 'No window to confirm in.' }
    let dir = typeof path === 'string' && path.trim() ? path.trim() : ''
    if (!dir) {
      const picked = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Choose a skill folder' })
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true }
      dir = picked.filePaths[0]
    }
    try {
      const { manifest } = await inspectSkillFolder(dir)
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Install a skill',
        message: `Install the skill "${manifest.name}"?`,
        detail:
          `${describeSkillForConfirmation(manifest)}\n\n` +
          'The folder is copied into this app’s data; the source is not referenced again. ' +
          'A method is text the model is asked to follow when the skill fires; helper files run only inside the sandbox; a server runs with your privileges and is saved switched off.',
        buttons: ['Install', 'Cancel'],
        defaultId: 1,
        cancelId: 1
      })
      if (response !== 0) return { ok: false, canceled: true }
      return { ok: true, skill: await installSkill(dir) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('skills:remove', async (_e, id: unknown) => {
    try {
      return { ok: true, ...(await removeSkill(String(id ?? ''))) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('skills:helpers', (_e, id: unknown) => skillHelperRefs(String(id ?? '')))
}
