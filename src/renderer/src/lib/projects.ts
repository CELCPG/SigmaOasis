import type { Conversation, Project, ProjectColor } from '../types'

/** Tailwind classes per project colour: the dot in the rail and the chip in the panel. */
export const PROJECT_ACCENT: Record<ProjectColor, { dot: string; chip: string }> = {
  teal: { dot: 'bg-[#00d4aa]', chip: 'bg-[rgba(0,212,170,0.15)] text-accent-ink' },
  blue: { dot: 'bg-blue-500', chip: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
  purple: { dot: 'bg-purple-500', chip: 'bg-purple-500/15 text-purple-600 dark:text-purple-400' },
  amber: { dot: 'bg-amber-500', chip: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  rose: { dot: 'bg-rose-500', chip: 'bg-rose-500/15 text-rose-600 dark:text-rose-400' },
  slate: { dot: 'bg-slate-400', chip: 'bg-slate-400/20 text-slate-600 dark:text-slate-300' }
}

export const PROJECT_COLORS: ProjectColor[] = ['teal', 'blue', 'purple', 'amber', 'rose', 'slate']

/** Next colour in the palette, so new projects differ from each other by default. */
export function nextProjectColor(existing: Project[]): ProjectColor {
  return PROJECT_COLORS[existing.length % PROJECT_COLORS.length]
}

export interface ProjectGroup {
  project: Project
  conversations: Conversation[]
}

export interface GroupedConversations {
  groups: ProjectGroup[]
  /** Conversations with no project, or pointing at a project that no longer exists. */
  unfiled: Conversation[]
}

/**
 * Bucket conversations under their project, preserving the caller's ordering
 * inside each bucket. A `projectId` that matches no project is treated as
 * unfiled rather than dropped — deleting a project must never hide chats.
 */
export function groupConversations(
  conversations: Conversation[],
  projects: Project[]
): GroupedConversations {
  const byId = new Map<string, ProjectGroup>()
  for (const p of projects) byId.set(p.id, { project: p, conversations: [] })
  const unfiled: Conversation[] = []
  for (const c of conversations) {
    const group = c.projectId ? byId.get(c.projectId) : undefined
    if (group) group.conversations.push(c)
    else unfiled.push(c)
  }
  return { groups: projects.map((p) => byId.get(p.id)!), unfiled }
}

/** Trim, cap and reject empty project names. Returns null when unusable. */
export function cleanProjectName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, ' ').slice(0, 80)
  return name ? name : null
}
