import type { Conversation, Project, ProjectColor } from '../types'

/**
 * Tailwind classes per project colour: the dot in the rail and the chip in the panel.
 *
 * A chip carries the project's *name*, so its ink is read, not just seen. Every
 * one of these sits on a 15% wash of its own hue over the glass panel, and at
 * -600 that surface ate them: 4.25:1 (blue), 4.37 (purple), 3.77 (rose) and
 * 2.78 (amber) — a project's own name at 2.78:1. Measured on the pill they
 * render on rather than on the bare panel, which is a full rank kinder and is
 * not where they are. One step darker clears blue, purple and rose; amber needs
 * two, the same two green needed in ACCENT, because a pale warm wash is the
 * brightest surface in the app.
 *
 * These stay raw Tailwind steps on purpose: they are a fixed label palette, not
 * status. `text-ink-danger|warn|ok` mean "this went wrong / may be wrong / is
 * fine" and are theme-aware for that reason; an amber *project* is not a
 * warning, and painting it in warning ink would be a lie no measurement could
 * catch. Pinned by the raw-palette check in test/chromeContrastCheck.ts.
 */
export const PROJECT_ACCENT: Record<ProjectColor, { dot: string; chip: string }> = {
  teal: { dot: 'bg-[#00d4aa]', chip: 'bg-[rgba(0,212,170,0.15)] text-accent-ink' },
  blue: { dot: 'bg-blue-500', chip: 'bg-blue-500/15 text-blue-700 dark:text-blue-400' },
  purple: { dot: 'bg-purple-500', chip: 'bg-purple-500/15 text-purple-700 dark:text-purple-400' },
  amber: { dot: 'bg-amber-500', chip: 'bg-amber-500/15 text-amber-800 dark:text-amber-400' },
  rose: { dot: 'bg-rose-500', chip: 'bg-rose-500/15 text-rose-700 dark:text-rose-400' },
  slate: { dot: 'bg-slate-400', chip: 'bg-slate-400/20 text-ink-secondary' }
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
