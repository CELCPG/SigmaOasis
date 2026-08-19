import { useCallback } from 'react'
import { useAppStore } from '../stores/appStore'
import type { AppSettings, Project, ProjectColor } from '../types'
import { cleanProjectName, nextProjectColor } from '../lib/projects'

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

/** Persist a settings change immediately — projects are direct manipulation, not a draft. */
function commitSettings(next: AppSettings): void {
  useAppStore.getState().setSettings(next)
  void window.api.setSettings(next)
}

/**
 * Projects group conversations in the rail. The list lives in settings
 * (small, app-scoped); each conversation carries a `projectId`. Deleting a
 * project unfiles its chats — it never deletes them.
 */
export function useProjects(): {
  createProject: (name: string, color?: ProjectColor) => Project | null
  renameProject: (id: string, name: string) => void
  recolorProject: (id: string, color: ProjectColor) => void
  /** Merge a partial into one project and persist — instructions, files, defaults, recall. */
  updateProject: (id: string, patch: Partial<Omit<Project, 'id' | 'createdAt'>>) => void
  deleteProject: (id: string) => void
  moveConversation: (conversationId: string, projectId: string | null) => void
} {
  const createProject = useCallback((name: string, color?: ProjectColor): Project | null => {
    const settings = useAppStore.getState().settings
    const clean = cleanProjectName(name)
    if (!settings || !clean) return null
    const project: Project = {
      id: uid(),
      name: clean,
      color: color ?? nextProjectColor(settings.projects),
      createdAt: Date.now(),
      instructions: '',
      files: [],
      recall: true,
      defaults: { mode: null, activeModelSlotId: null }
    }
    commitSettings({ ...settings, projects: [...settings.projects, project] })
    return project
  }, [])

  const renameProject = useCallback((id: string, name: string): void => {
    const settings = useAppStore.getState().settings
    const clean = cleanProjectName(name)
    if (!settings || !clean) return
    commitSettings({
      ...settings,
      projects: settings.projects.map((p) => (p.id === id ? { ...p, name: clean } : p))
    })
  }, [])

  const recolorProject = useCallback((id: string, color: ProjectColor): void => {
    const settings = useAppStore.getState().settings
    if (!settings) return
    commitSettings({
      ...settings,
      projects: settings.projects.map((p) => (p.id === id ? { ...p, color } : p))
    })
  }, [])

  const updateProject = useCallback(
    (id: string, patch: Partial<Omit<Project, 'id' | 'createdAt'>>): void => {
      const settings = useAppStore.getState().settings
      if (!settings) return
      commitSettings({
        ...settings,
        projects: settings.projects.map((p) => (p.id === id ? { ...p, ...patch, id: p.id, createdAt: p.createdAt } : p))
      })
    },
    []
  )

  const moveConversation = useCallback((conversationId: string, projectId: string | null): void => {
    const store = useAppStore.getState()
    const convo = store.conversations.find((c) => c.id === conversationId)
    if (!convo || (convo.projectId ?? null) === projectId) return
    const next = { ...convo, projectId }
    store.upsertConversation(next)
    if (!next.ephemeral) void window.api.saveConversation(next)
  }, [])

  const deleteProject = useCallback(
    (id: string): void => {
      const store = useAppStore.getState()
      const settings = store.settings
      if (!settings) return
      // Unfile first, so no conversation is left pointing at a missing project.
      for (const c of store.conversations) {
        if (c.projectId === id) moveConversation(c.id, null)
      }
      commitSettings({ ...settings, projects: settings.projects.filter((p) => p.id !== id) })
    },
    [moveConversation]
  )

  return { createProject, renameProject, recolorProject, updateProject, deleteProject, moveConversation }
}
