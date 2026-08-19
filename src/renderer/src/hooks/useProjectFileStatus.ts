import { useEffect, useState } from 'react'
import type { Project, ProjectFile, ProjectFileStatus } from '../types'

/**
 * v1.10: where each pinned file stands — on disk, indexed this session. Polled
 * once per project/file-list change (stat only, cheap); `refresh` after a
 * re-index so the row updates without waiting for the next change.
 */
export function useProjectFileStatus(project: Project | null | undefined): {
  status: Record<string, ProjectFileStatus>
  missing: ProjectFile[]
  refresh: () => void
} {
  const [status, setStatus] = useState<Record<string, ProjectFileStatus>>({})
  const [tick, setTick] = useState(0)
  // Key on the file list's identity, not the project object — a rename must
  // not re-stat every file.
  const filesKey = project ? project.files.map((f) => `${f.id}:${f.sourcePath}`).join('|') : ''

  useEffect(() => {
    if (!project || project.files.length === 0) {
      setStatus({})
      return
    }
    let cancelled = false
    void window.api
      .projectFileStatus(project.files.map((f) => ({ id: f.id, sourcePath: f.sourcePath })))
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesKey, tick])

  const missing = (project?.files ?? []).filter((f) => status[f.id] && !status[f.id]!.exists)
  return { status, missing, refresh: () => setTick((t) => t + 1) }
}
