/**
 * v2.7: skills — a folder the user installs, carrying a method and the
 * things it needs.
 *
 * A skill is `skill.json` beside an optional `playbook.md` (the method the
 * model is handed when the skill fires), an optional library pack (a folder
 * with `manifest.json` and `docs/`, installed as any pack is), an optional
 * MCP server spec (added switched off, through the same confirmation), and
 * optional Python helper files staged into the Workbench at `/work` when the
 * skill rides a turn. Installed from a folder only — there is no registry,
 * no URL install, no auto-update — through a confirmation that lists what
 * the folder carries. OpenClaw's SKILL.md is the model; its ClawHub is the
 * thing this deliberately has no equivalent of.
 *
 * Selection is by trigger phrases in the user's message, code stripped, and
 * a skill that fires takes the method slot for the turn: the built-in
 * playbook stands down (one method per turn, as always). User skills are
 * matched in install order.
 *
 * Pure data and pure functions, shared by main (install, list), the renderer
 * (selection, the method block) and the tests.
 */

export const SKILL_FORMAT_VERSION = 1
export const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
export const MAX_SKILL_TRIGGERS = 20
export const MAX_SKILL_DESCRIPTION = 400
export const MAX_SKILL_PLAYBOOK_CHARS = 6_000
export const MAX_SKILL_HELPERS = 8

export interface SkillMcpSpec {
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
}

export interface SkillManifest {
  formatVersion: number
  id: string
  name: string
  /** A decision rule in the house style: use when, do not use when, one example. */
  description: string
  /** Phrases that select the skill; matched case-insensitively at word boundaries, code stripped. */
  triggers: string[]
  /** File name under the folder, `.md`; its text is the method block. */
  playbook?: string
  /** Sub-folder holding a library pack (manifest.json + docs/). */
  pack?: string
  mcp?: SkillMcpSpec
  /** File names under the folder, `.py`, staged into /work when the skill rides a turn. */
  helpers?: string[]
}

/** An installed skill as the renderer sees it: the manifest plus what the installer resolved. */
export interface InstalledSkill extends SkillManifest {
  /** The playbook text, read at install. */
  playbookText?: string
  packId?: string
  mcpServerId?: string
  installedAt: string
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

const SAFE_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/

/** Validate a raw skill.json. Throws with a sentence naming the problem. */
export function validateSkillManifest(raw: unknown): SkillManifest {
  const m = (raw ?? {}) as Record<string, unknown>
  if (m.formatVersion !== SKILL_FORMAT_VERSION) {
    throw new Error(`Unsupported skill format version ${String(m.formatVersion)} (this app reads ${SKILL_FORMAT_VERSION}).`)
  }
  const id = str(m.id)
  if (!SKILL_ID_RE.test(id)) throw new Error(`Invalid skill id "${id}" — use lowercase letters, digits and dashes.`)
  const name = str(m.name).trim()
  if (!name) throw new Error('A skill needs a name.')
  const description = str(m.description).trim()
  if (!description) throw new Error('A skill needs a description — say when to use it and when not to.')
  if (description.length > MAX_SKILL_DESCRIPTION) throw new Error(`The description is over ${MAX_SKILL_DESCRIPTION} characters.`)
  if (!Array.isArray(m.triggers) || m.triggers.length === 0) throw new Error('A skill needs at least one trigger phrase.')
  const triggers = m.triggers
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 3 && t.length <= 80)
  if (triggers.length === 0) throw new Error('Trigger phrases must be 3 to 80 characters.')
  if (triggers.length > MAX_SKILL_TRIGGERS) throw new Error(`At most ${MAX_SKILL_TRIGGERS} trigger phrases.`)
  const out: SkillManifest = { formatVersion: SKILL_FORMAT_VERSION, id, name, description, triggers }
  if (m.playbook !== undefined) {
    const p = str(m.playbook)
    if (!SAFE_FILE.test(p) || !p.endsWith('.md')) throw new Error(`The playbook must be a .md file name in the skill folder, not "${p}".`)
    out.playbook = p
  }
  if (m.pack !== undefined) {
    const p = str(m.pack)
    if (!SAFE_FILE.test(p) || p.includes('.')) throw new Error(`The pack must be a sub-folder name, not "${p}".`)
    out.pack = p
  }
  if (m.mcp !== undefined) {
    const s = (m.mcp ?? {}) as Record<string, unknown>
    const command = str(s.command).trim()
    if (!command) throw new Error('The MCP server spec needs a command.')
    const env: Record<string, string> = {}
    if (s.env && typeof s.env === 'object') {
      for (const [k, v] of Object.entries(s.env as Record<string, unknown>)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string') env[k] = v
    }
    out.mcp = {
      command,
      args: Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === 'string') : [],
      env,
      ...(str(s.cwd).trim() ? { cwd: str(s.cwd).trim() } : {})
    }
  }
  if (m.helpers !== undefined) {
    if (!Array.isArray(m.helpers)) throw new Error('helpers must be a list of .py file names.')
    const helpers = m.helpers.filter((h): h is string => typeof h === 'string')
    for (const h of helpers) if (!SAFE_FILE.test(h) || !h.endsWith('.py')) throw new Error(`A helper must be a .py file name in the skill folder, not "${h}".`)
    if (helpers.length > MAX_SKILL_HELPERS) throw new Error(`At most ${MAX_SKILL_HELPERS} helper files.`)
    out.helpers = helpers
  }
  return out
}

const FENCED = /```[\s\S]*?(?:```|$)/g
const INLINE = /`[^`\n]*`/g

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The first installed skill whose trigger phrase appears in the text, code stripped. */
export function selectSkill<T extends { triggers: string[] }>(text: string, skills: readonly T[]): { skill: T; trigger: string } | null {
  const haystack = text.replace(FENCED, ' ').replace(INLINE, ' ').toLowerCase()
  for (const skill of skills) {
    for (const trigger of skill.triggers) {
      const re = new RegExp(`(?<![a-z0-9])${escapeRe(trigger)}(?![a-z0-9])`, 'i')
      if (re.test(haystack)) return { skill, trigger }
    }
  }
  return null
}

/**
 * The method block a fired skill hands the model — the same framing the
 * built-in playbooks use, naming the skill, so the reply's disclosure and the
 * eval suites read one shape.
 */
export function buildSkillContext(skill: { name: string; description: string; playbookText?: string; helpers?: string[]; id: string }): string {
  const lines = [
    `Method for this kind of question (the user's "${skill.name}" skill — follow it, and say so if you depart from it):`,
    skill.description
  ]
  if (skill.playbookText?.trim()) lines.push('', skill.playbookText.trim().slice(0, MAX_SKILL_PLAYBOOK_CHARS))
  if (skill.helpers && skill.helpers.length > 0) {
    lines.push('', `Helper files staged for run_python at /work: ${skill.helpers.map((h) => `${skill.id}_${h}`).join(', ')} — import them by name without the .py.`)
  }
  return lines.join('\n')
}

/** What the confirmation lists before anything is installed. */
export function describeSkillForConfirmation(m: SkillManifest): string {
  const parts = [`${m.name} (${m.id})`, m.description, '', 'This folder carries:']
  parts.push(`- ${m.triggers.length} trigger phrase(s): ${m.triggers.slice(0, 6).join(', ')}${m.triggers.length > 6 ? ', …' : ''}`)
  parts.push(m.playbook ? `- a method (${m.playbook}) the model is handed when the skill fires` : '- no method file')
  parts.push(m.pack ? `- a library pack (${m.pack}/) — installed like any pack, its documents copied` : '- no library pack')
  if (m.mcp) {
    const argv = [m.mcp.command, ...m.mcp.args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')
    parts.push(`- an MCP server: ${argv}${m.mcp.cwd ? ` (in ${m.mcp.cwd})` : ''}${Object.keys(m.mcp.env).length ? `; environment: ${Object.keys(m.mcp.env).join(', ')} (values not shown)` : ''} — a separate program with your privileges, saved switched off`)
  } else parts.push('- no MCP server')
  parts.push(m.helpers?.length ? `- ${m.helpers.length} Python helper file(s) the sandbox will see: ${m.helpers.join(', ')}` : '- no code')
  return parts.join('\n')
}
