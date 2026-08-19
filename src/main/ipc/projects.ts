/**
 * v1.10: a project groups conversations in the rail — and, with project context
 * (1.10), carries what every chat in it should know: standing instructions,
 * pinned files, defaults for new chats, and whether chats may recall from each
 * other. Projects live in settings (small, app-scoped); a conversation points
 * at one through `projectId`. Pure module — no Electron imports — so the
 * normalizer is unit-testable.
 */
export interface Project {
  id: string
  name: string
  color: ProjectColor
  createdAt: number
  /**
   * Standing instructions appended to the system prompt of every chat in the
   * project. '' = none. Stable from turn to turn, so it lives in the system
   * prompt rather than the per-turn context (KV-cache friendly).
   */
  instructions: string
  /**
   * Files pinned to the project: paths only, never content. Each chat in the
   * project retrieves relevant passages from them per turn, exactly like an
   * attached document — indexed in RAM, re-read from the path as needed.
   */
  files: ProjectFile[]
  /** Chats in this project may recall passages from the project's other chats. */
  recall: boolean
  /** Applied to a chat created inside the project; never changes existing chats. */
  defaults: ProjectDefaults
}

export interface ProjectFile {
  id: string
  name: string
  sourcePath: string
}

export interface ProjectDefaults {
  /** null = the app default (independent). */
  mode: 'independent' | 'collaborative' | 'orchestrated' | null
  /** Model slot id for independent mode; null = first enabled slot. */
  activeModelSlotId: string | null
  /**
   * Memory scope for new chats: undefined = leave the app default (all
   * sources); null = all sources explicitly; [] = no long-term memory; a list =
   * those sources.
   */
  memorySources?: string[] | null
}

export type ProjectColor = 'teal' | 'blue' | 'purple' | 'amber' | 'rose' | 'slate'
export const PROJECT_COLORS: ProjectColor[] = ['teal', 'blue', 'purple', 'amber', 'rose', 'slate']

const MODES = ['independent', 'collaborative', 'orchestrated'] as const
const MAX_INSTRUCTIONS_CHARS = 8000
const MAX_FILES = 20

function normalizeFiles(value: unknown): ProjectFile[] {
  if (!Array.isArray(value)) return []
  const out: ProjectFile[] = []
  const seen = new Set<string>()
  for (const raw of value as Array<Partial<ProjectFile> | null>) {
    const id = typeof raw?.id === 'string' && /^[A-Za-z0-9_-]+$/.test(raw.id) ? raw.id : ''
    const sourcePath = typeof raw?.sourcePath === 'string' ? raw.sourcePath : ''
    if (!id || !sourcePath || seen.has(id)) continue
    seen.add(id)
    const name =
      typeof raw?.name === 'string' && raw.name.trim()
        ? raw.name.trim()
        : sourcePath.split(/[\\/]/).pop() || 'file'
    out.push({ id, name, sourcePath })
    if (out.length >= MAX_FILES) break
  }
  return out
}

function normalizeDefaults(value: unknown): ProjectDefaults {
  const raw = (value ?? {}) as Partial<ProjectDefaults>
  const defaults: ProjectDefaults = {
    mode: MODES.includes(raw.mode as (typeof MODES)[number]) ? (raw.mode as ProjectDefaults['mode']) : null,
    activeModelSlotId: typeof raw.activeModelSlotId === 'string' && raw.activeModelSlotId ? raw.activeModelSlotId : null
  }
  if (raw.memorySources === null) defaults.memorySources = null
  else if (Array.isArray(raw.memorySources)) {
    defaults.memorySources = raw.memorySources.filter((s): s is string => typeof s === 'string')
  }
  return defaults
}

/**
 * Projects: drop entries without a usable id or name, dedupe ids, clamp the
 * colour to the palette, fill in the context fields added in 1.10. Order is
 * preserved — it is the order in the rail.
 */
export function normalizeProjects(value: unknown): Project[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: Project[] = []
  for (const raw of value as Array<Partial<Project> | null>) {
    const id = typeof raw?.id === 'string' && /^[A-Za-z0-9_-]+$/.test(raw.id) ? raw.id : ''
    const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, 80) : ''
    if (!id || !name || seen.has(id)) continue
    seen.add(id)
    const createdAt = Number(raw?.createdAt)
    out.push({
      id,
      name,
      color: PROJECT_COLORS.includes(raw?.color as ProjectColor) ? (raw!.color as ProjectColor) : 'teal',
      createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now(),
      instructions:
        typeof raw?.instructions === 'string' ? raw.instructions.slice(0, MAX_INSTRUCTIONS_CHARS) : '',
      files: normalizeFiles(raw?.files),
      recall: raw?.recall !== false,
      defaults: normalizeDefaults(raw?.defaults)
    })
  }
  return out
}
