import { contextBridge, ipcRenderer } from 'electron'

/**
 * Preload for the Workbench sandbox window (main/ipc/workbench.ts). The page
 * gets exactly three capabilities: receive a job, post a result, say it is
 * ready. No filesystem, no network, no other IPC — the sandbox's whole
 * contract with the app is these three calls.
 */
export interface WorkbenchJob {
  id: string
  code: string
  /** v1.8: session key — runs sharing it keep globals and /work between calls. */
  session?: string | null
  files: { name: string; base64: string }[]
}

export interface WorkbenchResult {
  id: string
  ok: boolean
  stdout: string
  stderr: string
  /** repr() of the last expression, when the code ended in one. */
  result: string | null
  files: { name: string; base64: string; bytes: number }[]
  durationMs: number
  error?: string
  /** v1.8: this run continued an existing session's globals. */
  resumed?: boolean
  /** v1.8: names defined in the session after this run. */
  sessionVars?: string[]
}

contextBridge.exposeInMainWorld('workbench', {
  onJob: (cb: (job: WorkbenchJob) => void): void => {
    ipcRenderer.on('workbench:job', (_e, job: WorkbenchJob) => cb(job))
  },
  result: (r: WorkbenchResult): void => ipcRenderer.send('workbench:result', r),
  ready: (info: { version: string }): void => ipcRenderer.send('workbench:ready', info),
  failed: (message: string): void => ipcRenderer.send('workbench:failed', message)
})
