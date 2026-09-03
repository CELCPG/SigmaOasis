import { contextBridge, ipcRenderer } from 'electron'

/**
 * Preload for the Workbench sandbox window (main/ipc/workbench.ts). The page
 * gets exactly five capabilities: receive a job, post a result, say it is
 * ready or failed, and — v2.7 Code Mode — ask the app to run one of its tools
 * and receive the answer. No filesystem, no network, no other IPC: the
 * sandbox's whole contract with the app is these calls, and a tool call from
 * inside it is the app's ordinary tool path with the app's own allowlists,
 * budgets and audit deciding, not the sandbox.
 */
export interface WorkbenchJob {
  id: string
  code: string
  /** v1.8: session key — runs sharing it keep globals and /work between calls. */
  session?: string | null
  files: { name: string; base64: string }[]
  /** v2.7: the generated `tools` module, written to /work before the code runs. Absent = no bridge. */
  sdk?: string
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

/** v2.7: a program asking for a tool; the app answers with the tool's own result shape, as JSON. */
export interface WorkbenchToolCall {
  jobId: string
  callId: string
  name: string
  argsJson: string
}

export interface WorkbenchToolResult {
  jobId: string
  callId: string
  /** `{ok, output?, error?}` serialized — the program parses it. */
  resultJson: string
}

contextBridge.exposeInMainWorld('workbench', {
  onJob: (cb: (job: WorkbenchJob) => void): void => {
    ipcRenderer.on('workbench:job', (_e, job: WorkbenchJob) => cb(job))
  },
  result: (r: WorkbenchResult): void => ipcRenderer.send('workbench:result', r),
  ready: (info: { version: string }): void => ipcRenderer.send('workbench:ready', info),
  failed: (message: string): void => ipcRenderer.send('workbench:failed', message),
  callTool: (call: WorkbenchToolCall): void => ipcRenderer.send('workbench:call', call),
  onToolResult: (cb: (r: WorkbenchToolResult) => void): void => {
    ipcRenderer.on('workbench:callResult', (_e, r: WorkbenchToolResult) => cb(r))
  }
})
