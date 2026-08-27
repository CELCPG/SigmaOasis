import { useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { useAppStore } from '../stores/appStore'
import { useProjects } from '../hooks/useProjects'
import { modalClasses, useModalPresence } from '../hooks/useModalPresence'
import type { ModalSurface } from '../hooks/useModalSurface'
import type { ChatMode, Project } from '../types'
import { PROJECT_ACCENT, PROJECT_COLORS } from '../lib/projects'
import { useProjectFileStatus } from '../hooks/useProjectFileStatus'

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const MODE_LABELS: Record<ChatMode, string> = {
  independent: 'Independent',
  collaborative: 'Pipeline',
  orchestrated: 'Orchestrated'
}

const field =
  'w-full rounded-xl border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 px-3 py-2 text-sm outline-none focus:border-accent'
const label = 'mb-1 block text-[11px] font-medium uppercase tracking-[0.08em] text-ink-tertiary'

/**
 * v1.10 project editor: what every chat in the project inherits. Name and
 * instructions are drafted locally and committed on blur (a settings write per
 * keystroke is a disk write per keystroke); everything else commits at once.
 */
export function ProjectModal(): JSX.Element | null {
  const projectId = useAppStore((s) => s.projectEditorId)
  const setProjectEditorId = useAppStore((s) => s.setProjectEditorId)
  const project = useAppStore((s) => s.settings?.projects.find((p) => p.id === s.projectEditorId) ?? null)
  const models = useAppStore((s) => s.settings?.models ?? [])
  const chatCount = useAppStore(
    (s) => s.conversations.filter((c) => c.projectId === s.projectEditorId).length
  )
  const { updateProject, deleteProject } = useProjects()
  // The drafts Escape has to commit live in the editor below, so it fills this
  // in; the fallback covers the frame before it has.
  const dismiss = useRef<() => void>(() => setProjectEditorId(null))
  const { mounted, leaving, surfaceRef, dialogProps } = useModalPresence(
    Boolean(projectId && project),
    { onDismiss: () => dismiss.current() }
  )

  // Unlike the other modals, this one's content is derived from the very state
  // that closing it clears — `projectEditorId` goes null and the project (and
  // its chat count) resolve to nothing in the same tick. Hold the last pair so
  // the editor has something to render while it animates out.
  const last = useRef<{ project: Project; chatCount: number } | null>(null)
  if (project) last.current = { project, chatCount }
  const shown = project ? { project, chatCount } : last.current

  if (!mounted || !shown) return null
  return (
    <ProjectEditor
      key={shown.project.id}
      leaving={leaving}
      surfaceRef={surfaceRef}
      dialogProps={dialogProps}
      dismissRef={dismiss}
      project={shown.project}
      chatCount={shown.chatCount}
      enabledModels={models.filter((m) => m.enabled).map((m) => ({ id: m.id, roleName: m.roleName }))}
      onPatch={(patch) => updateProject(shown.project.id, patch)}
      onDelete={() => {
        const detail =
          shown.chatCount > 0
            ? `Its ${shown.chatCount} chat${shown.chatCount === 1 ? '' : 's'} will be kept and moved out of the project.`
            : 'It has no chats.'
        if (window.confirm(`Delete project “${shown.project.name}”?\n\n${detail}`)) {
          deleteProject(shown.project.id)
          setProjectEditorId(null)
        }
      }}
      onClose={() => setProjectEditorId(null)}
    />
  )
}

function ProjectEditor({
  project,
  chatCount,
  enabledModels,
  leaving,
  surfaceRef,
  dialogProps,
  dismissRef,
  onPatch,
  onDelete,
  onClose
}: {
  project: Project
  chatCount: number
  enabledModels: { id: string; roleName: string }[]
  /** True while the editor is animating out; see useModalPresence. */
  leaving: boolean
  surfaceRef: ModalSurface['surfaceRef']
  dialogProps: ModalSurface['dialogProps']
  /** Filled in with commit-then-close, so Escape does not lose a draft. */
  dismissRef: MutableRefObject<() => void>
  onPatch: (patch: Partial<Omit<Project, 'id' | 'createdAt'>>) => void
  onDelete: () => void
  onClose: () => void
}): JSX.Element {
  const [name, setName] = useState(project.name)
  const [instructions, setInstructions] = useState(project.instructions)
  // A just-created project arrives named "New project"; select it so the
  // first keystroke replaces the placeholder instead of appending to it.
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (project.name === 'New project') {
      nameRef.current?.focus()
      nameRef.current?.select()
    }
    // Once, when the editor opens for this project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const { status: fileStatus, refresh: refreshFileStatus } = useProjectFileStatus(project)
  const [busyFileId, setBusyFileId] = useState<string | null>(null)
  const [fileNote, setFileNote] = useState<Record<string, string>>({})

  const reindex = async (f: { id: string; name: string; sourcePath: string }): Promise<void> => {
    setBusyFileId(f.id)
    const r: { ok: boolean; chunks?: number; truncated?: boolean; error?: string } = await window.api
      .projectReindexFile(f)
      .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    setBusyFileId(null)
    setFileNote((n) => ({
      ...n,
      [f.id]: r.ok
        ? `indexed · ${r.chunks ?? 0} passage${r.chunks === 1 ? '' : 's'}${r.truncated ? ' · long file, opening only' : ''}`
        : `could not index: ${r.error ?? 'unknown error'}`
    }))
    refreshFileStatus()
  }

  const commitName = (): void => {
    const clean = name.trim()
    if (clean && clean !== project.name) onPatch({ name: clean })
    else setName(project.name)
  }
  const commitInstructions = (): void => {
    if (instructions !== project.instructions) onPatch({ instructions })
  }

  // Escape closes; commit drafts first so nothing typed is lost.
  //
  // Routed through the modal-surface stack rather than a `window` listener of
  // this editor's own: a per-modal listener fires whichever surface is on top,
  // so Escape with the command palette open over this editor used to close the
  // editor underneath it.
  dismissRef.current = (): void => {
    commitInstructions()
    commitName()
    onClose()
  }

  const addFiles = async (): Promise<void> => {
    const picked = await window.api.projectPickFiles().catch(() => [])
    if (picked.length === 0) return
    const known = new Set(project.files.map((f) => f.sourcePath))
    const fresh = picked.filter((p) => !known.has(p.sourcePath)).map((p) => ({ id: uid(), ...p }))
    if (fresh.length > 0) onPatch({ files: [...project.files, ...fresh] })
  }

  const memoryValue =
    project.defaults.memorySources === undefined
      ? 'default'
      : project.defaults.memorySources === null
        ? 'all'
        : project.defaults.memorySources.length === 0
          ? 'none'
          : 'some'

  return (
    <div
      ref={surfaceRef}
      className={`${modalClasses(leaving).backdrop} fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4`}
      onClick={() => {
        commitInstructions()
        commitName()
        onClose()
      }}
    >
      <div
        {...dialogProps}
        aria-label={`Project: ${project.name}`}
        className={`${modalClasses(leaving).panel} flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl bg-panel-light dark:bg-panel-dark shadow-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-black/10 dark:border-white/10 px-5 py-4">
          <span className={`h-3 w-3 rounded-full ${PROJECT_ACCENT[project.color].dot}`} />
          <input
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            className="min-w-0 flex-1 bg-transparent text-base font-semibold outline-none"
            aria-label="Project name"
          />
          <div className="flex items-center gap-1" title="Colour">
            {PROJECT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => onPatch({ color: c })}
                className={`h-4 w-4 rounded-full ${PROJECT_ACCENT[c].dot} ${
                  c === project.color ? 'ring-2 ring-offset-1 ring-accent ring-offset-transparent' : 'opacity-60 hover:opacity-100'
                }`}
                aria-label={`Colour ${c}`}
                aria-pressed={c === project.color}
              />
            ))}
          </div>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <section>
            <label className={label} htmlFor="project-instructions">
              Instructions for every chat in this project
            </label>
            <textarea
              id="project-instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              onBlur={commitInstructions}
              rows={5}
              maxLength={8000}
              placeholder={
                'e.g. We are analysing Q3 tariff exposure for a mid-size importer. Figures must come from the pinned files or a tool result; say so when they don’t. Keep answers in plain English; no markdown tables.'
              }
              className={`${field} resize-y leading-relaxed`}
            />
            <p className="mt-1 text-[11px] text-ink-tertiary">
              Appended to the role’s system prompt in each chat of this project. Stable across turns, so it
              costs nothing to re-read.
            </p>
          </section>

          <section>
            <div className="mb-1 flex items-center justify-between">
              <span className={label} style={{ marginBottom: 0 }}>
                Pinned files
              </span>
              <button
                type="button"
                onClick={() => void addFiles()}
                className="rounded-lg px-2 py-1 text-[11px] text-accent-ink hover:bg-black/5 dark:hover:bg-white/10"
              >
                ＋ Add files…
              </button>
            </div>
            {project.files.length === 0 ? (
              <p className="text-[11px] text-ink-tertiary">
                None yet. A pinned file is read from its path and indexed in RAM; every chat in the project
                retrieves the passages relevant to each message — like an attached document, without
                re-attaching it.
              </p>
            ) : (
              <ul className="space-y-1">
                {project.files.map((f) => (
                  <li
                    key={f.id}
                    className="group flex items-center gap-2 rounded-xl bg-black/5 dark:bg-white/5 px-3 py-1.5 text-xs"
                  >
                    <span className="shrink-0">{fileStatus[f.id] && !fileStatus[f.id]!.exists ? '⚠' : '📄'}</span>
                    <span className="min-w-0 flex-1 truncate" title={f.sourcePath}>
                      {f.name}
                      <span className="ml-2 text-[10px] text-ink-tertiary">{f.sourcePath}</span>
                      <span className="block text-[10px] text-ink-tertiary">
                        {fileNote[f.id] ??
                          (!fileStatus[f.id]
                            ? '…'
                            : !fileStatus[f.id]!.exists
                              ? 'not found at this path — move it back or unpin it'
                              : `${fileStatus[f.id]!.indexed ? 'indexed this session' : 'indexed on first use'}${
                                  fileStatus[f.id]!.sizeBytes !== null ? ` · ${formatBytes(fileStatus[f.id]!.sizeBytes!)}` : ''
                                }`)}
                      </span>
                    </span>
                    {fileStatus[f.id]?.exists && (
                      <button
                        type="button"
                        onClick={() => void reindex(f)}
                        disabled={busyFileId === f.id}
                        className="rounded px-1 text-ink-tertiary hover:text-ink-primary disabled:opacity-40"
                        title="Read and index this file now (otherwise it happens on the first message that needs it)"
                      >
                        {busyFileId === f.id ? '…' : '⟳'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onPatch({ files: project.files.filter((x) => x.id !== f.id) })}
                      className="rounded px-1 text-ink-tertiary hover:text-red-500"
                      title="Unpin"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={project.recall}
                onChange={(e) => onPatch({ recall: e.target.checked })}
                className="mt-1"
              />
              <span>
                <span className="font-medium">Chats in this project recall from each other</span>
                <span className="mt-0.5 block text-[11px] text-ink-tertiary">
                  Before each reply, the passages of the project’s other chats most relevant to your message are
                  given to the model, and shown under the reply as “🗂 From this project’s other chats”. Only
                  chats saved to disk are read — ephemeral chats never surface.
                </span>
              </span>
            </label>
          </section>

          <section>
            <span className={label}>Defaults for new chats in this project</span>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <span className="mb-1 block text-[10px] text-ink-tertiary">Strategy</span>
                <select
                  value={project.defaults.mode ?? ''}
                  onChange={(e) =>
                    onPatch({
                      defaults: { ...project.defaults, mode: (e.target.value || null) as ChatMode | null }
                    })
                  }
                  className={`${field} px-2 py-1.5 text-xs`}
                >
                  <option value="">App default</option>
                  {(Object.keys(MODE_LABELS) as ChatMode[]).map((m) => (
                    <option key={m} value={m}>
                      {MODE_LABELS[m]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <span className="mb-1 block text-[10px] text-ink-tertiary">Role</span>
                <select
                  value={project.defaults.activeModelSlotId ?? ''}
                  onChange={(e) =>
                    onPatch({ defaults: { ...project.defaults, activeModelSlotId: e.target.value || null } })
                  }
                  className={`${field} px-2 py-1.5 text-xs`}
                >
                  <option value="">First enabled</option>
                  {enabledModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.roleName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <span className="mb-1 block text-[10px] text-ink-tertiary">Long-term memory</span>
                <select
                  value={memoryValue}
                  onChange={(e) => {
                    const v = e.target.value
                    const { memorySources: _drop, ...rest } = project.defaults
                    onPatch({
                      defaults:
                        v === 'all' ? { ...rest, memorySources: null } : v === 'none' ? { ...rest, memorySources: [] } : rest
                    })
                  }}
                  className={`${field} px-2 py-1.5 text-xs`}
                >
                  <option value="default">App default</option>
                  <option value="all">All sources</option>
                  <option value="none">No memory</option>
                  {memoryValue === 'some' && <option value="some">Selected sources</option>}
                </select>
              </div>
            </div>
            <p className="mt-1 text-[11px] text-ink-tertiary">
              Applied when a chat is started inside the project. Existing chats are never changed.
            </p>
          </section>
        </div>

        <div className="flex items-center gap-3 border-t border-black/10 dark:border-white/10 px-5 py-3 text-xs">
          <span className="text-ink-tertiary">
            {chatCount} chat{chatCount === 1 ? '' : 's'} in this project
          </span>
          <button
            type="button"
            onClick={onDelete}
            className="ml-auto rounded-lg px-2 py-1 text-red-500 hover:bg-red-500/10"
          >
            Delete project
          </button>
          <button
            type="button"
            onClick={() => {
              commitInstructions()
              commitName()
              onClose()
            }}
            className="rounded-xl bg-accent/15 px-3 py-1.5 font-medium text-accent-ink hover:bg-accent/25"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
