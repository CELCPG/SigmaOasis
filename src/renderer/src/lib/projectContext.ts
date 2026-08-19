import type {
  AttachmentRef,
  Conversation,
  MemoryContextItem,
  Project,
  ProjectRecallItem
} from '../types'

/**
 * v1.10 project context: what a chat inherits from the project it files under.
 * Pure helpers so the turn assembly in useLMStudio stays readable and the
 * rules are testable without a store or a window.
 */

/** Passages recalled from sibling chats per turn. */
export const PROJECT_RECALL_PER_TURN = 4

/**
 * The system-prompt addendum. Appended to the role's own prompt, before the
 * grounding rules, because it is stable from turn to turn for the life of the
 * project — the KV-cache-friendly place for it.
 */
export function projectInstructionsBlock(project: Project | null | undefined): string {
  const text = project?.instructions.trim()
  if (!project || !text) return ''
  return `\n\nThis chat belongs to the project "${project.name}". Standing instructions for every chat in this project:\n${text}`
}

/** Pinned project files as attachment refs: indexed lazily from the path, retrieved per turn like an attached document. */
export function projectFileRefs(project: Project | null | undefined): AttachmentRef[] {
  if (!project) return []
  return project.files.map((f) => ({
    id: `project-file-${f.id}`,
    name: f.name,
    sourcePath: f.sourcePath
  }))
}

/**
 * Which chats a turn may recall from: the same project, not this chat, not
 * ephemeral (never on disk anyway, but say so here too), and not a branch of
 * this chat or its parent — those share the same opening, so "recalling" them
 * would surface the conversation's own history as if it were new.
 */
export function siblingConversationIds(
  conversations: Pick<Conversation, 'id' | 'projectId' | 'ephemeral' | 'branches'>[],
  current: Pick<Conversation, 'id' | 'projectId' | 'branches'>
): string[] {
  if (!current.projectId) return []
  const related = new Set<string>([current.id])
  for (const b of current.branches ?? []) related.add(b.branchId)
  for (const c of conversations) {
    if (c.branches?.some((b) => b.branchId === current.id)) {
      related.add(c.id)
      for (const b of c.branches ?? []) related.add(b.branchId)
    }
  }
  return conversations
    .filter((c) => c.projectId === current.projectId && !c.ephemeral && !related.has(c.id))
    .map((c) => c.id)
}

/** The per-turn context block for recalled project passages, or '' when there are none. */
export function buildProjectRecallContext(projectName: string, items: ProjectRecallItem[]): string {
  if (items.length === 0) return ''
  const body = items
    .map((i) => `--- from the chat "${i.title}" · relevance ${i.score.toFixed(2)} ---\n${i.text}`)
    .join('\n\n')
  return (
    `Earlier chats in the project "${projectName}" that may bear on this message. They are background: ` +
    `use them only when they directly help, say which chat a point comes from if you lean on it, and never let them change the subject:\n${body}`
  )
}

/** What the reply records, so the user can expand exactly what was surfaced. */
export function toProjectContextItems(items: ProjectRecallItem[]): MemoryContextItem[] {
  return items.map((i) => ({ source: i.title, score: i.score, text: i.text }))
}

/**
 * Fields a new conversation takes from its project. Only the defaults the
 * project actually set are returned, so the caller's own defaults stand for
 * the rest.
 */
export function conversationDefaultsFromProject(
  project: Project | null | undefined,
  enabledSlotIds: string[]
): Partial<Pick<Conversation, 'mode' | 'activeModelSlotId' | 'orchestratorSlotId' | 'memorySources'>> {
  if (!project) return {}
  const out: Partial<Pick<Conversation, 'mode' | 'activeModelSlotId' | 'orchestratorSlotId' | 'memorySources'>> = {}
  const d = project.defaults
  if (d.mode) out.mode = d.mode
  if (d.activeModelSlotId && enabledSlotIds.includes(d.activeModelSlotId)) {
    out.activeModelSlotId = d.activeModelSlotId
    if (d.mode === 'orchestrated') out.orchestratorSlotId = d.activeModelSlotId
  } else if (d.mode === 'orchestrated' && enabledSlotIds[0]) {
    out.orchestratorSlotId = enabledSlotIds[0]
  }
  if (d.memorySources !== undefined) out.memorySources = d.memorySources
  return out
}

/** One-line summary for the chat panel: what this chat inherits. */
export function projectInheritanceSummary(project: Project): string[] {
  const parts: string[] = []
  if (project.instructions.trim()) parts.push('instructions')
  if (project.files.length > 0) parts.push(`${project.files.length} pinned file${project.files.length === 1 ? '' : 's'}`)
  parts.push(project.recall ? 'recall across chats' : 'no cross-chat recall')
  return parts
}
