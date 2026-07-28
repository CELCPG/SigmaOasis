import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { useLMStudio } from '../hooks/useLMStudio'
import { WavRecorder } from '../lib/voice'
import type { Attachment } from '../types'

type MicState = 'idle' | 'recording' | 'transcribing'

/**
 * Message composer with attachments. Enter sends, Shift+Enter inserts a
 * newline. Files can be attached via the 📎 button or by dragging them onto
 * the composer; images and text files are supported. While a reply streams,
 * Send becomes Stop. The hint row lists the available @mention handles.
 */
export function InputBar(): JSX.Element {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [micState, setMicState] = useState<MicState>('idle')
  const [recSeconds, setRecSeconds] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const recorderRef = useRef<WavRecorder | null>(null)
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const streaming = useAppStore((s) => s.streaming)
  const settings = useAppStore((s) => s.settings)
  const { sendMessage, stopStreaming } = useLMStudio()

  const stopRecTimer = (): void => {
    if (recTimerRef.current) {
      clearInterval(recTimerRef.current)
      recTimerRef.current = null
    }
  }

  const cancelRecording = (): void => {
    recorderRef.current?.cancel()
    recorderRef.current = null
    stopRecTimer()
    setRecSeconds(0)
    setMicState('idle')
  }

  // Escape cancels an in-progress recording; the mic is always released on unmount.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && recorderRef.current) {
        cancelRecording()
        setNotice('Recording cancelled.')
        setTimeout(() => setNotice(null), 4000)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      recorderRef.current?.cancel()
      recorderRef.current = null
      stopRecTimer()
    }
  }, [])

  const handles = (settings?.models ?? [])
    .filter((m) => m.enabled && m.roleName.trim())
    .map((m) => `@${m.roleName.replace(/\s+/g, '')}`)

  // Models can be steered by anything they read (search results, documents,
  // files), so make it visible when they can also change the machine.
  const armed = [
    settings?.tools.write_file ? 'write files' : null,
    settings?.tools.run_terminal_command ? 'run commands' : null
  ].filter((t): t is string => t !== null)

  const showRejected = (rejected: { name: string; reason: string }[]): void => {
    if (rejected.length === 0) return
    setNotice(rejected.map((r) => `${r.name}: ${r.reason}`).join(' · '))
    setTimeout(() => setNotice(null), 6000)
  }

  const addResult = (result: {
    attachments: Attachment[]
    rejected: { name: string; reason: string }[]
  }): void => {
    if (result.attachments.length > 0) {
      setAttachments((prev) => [...prev, ...result.attachments])
    }
    showRejected(result.rejected)
  }

  const pick = async (): Promise<void> => {
    addResult(await window.api.pickAttachments())
  }

  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setDragOver(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => {
        try {
          return window.api.getPathForFile(f)
        } catch {
          return ''
        }
      })
      .filter(Boolean)
    if (paths.length > 0) addResult(await window.api.loadAttachments(paths))
  }

  const removeAttachment = (id: string): void =>
    setAttachments((prev) => prev.filter((a) => a.id !== id))

  const showNotice = (message: string): void => {
    setNotice(message)
    setTimeout(() => setNotice(null), 8000)
  }

  const toggleMic = async (): Promise<void> => {
    if (micState === 'recording') {
      // Stop → transcribe locally via whisper.cpp.
      const recorder = recorderRef.current
      recorderRef.current = null
      stopRecTimer()
      setRecSeconds(0)
      if (!recorder) return
      const wav = recorder.stop()
      setMicState('transcribing')
      try {
        const result = await window.api.transcribeAudio(wav)
        if (result.ok && result.text) {
          setText((prev) => (prev.trim() ? `${prev.trim()} ${result.text}` : result.text!))
          textareaRef.current?.focus()
        } else {
          showNotice(result.error ?? 'Transcription failed.')
        }
      } finally {
        setMicState('idle')
      }
      return
    }

    if (micState !== 'idle') return

    // Preflight: is whisper.cpp available?
    const status = await window.api.getSttStatus().catch(() => null)
    if (!status?.available) {
      showNotice(status?.reason ?? 'Voice input is not set up — see Settings → Voice.')
      return
    }

    try {
      const recorder = new WavRecorder()
      await recorder.start()
      recorderRef.current = recorder
      setMicState('recording')
      setRecSeconds(0)
      recTimerRef.current = setInterval(
        () => setRecSeconds(Math.floor(recorderRef.current?.elapsedSeconds ?? 0)),
        500
      )
    } catch {
      showNotice('Microphone access was denied — allow it in your system privacy settings.')
    }
  }

  const submit = (): void => {
    const value = text.trim()
    if ((!value && attachments.length === 0) || streaming) return
    setText('')
    setAttachments([])
    setNotice(null)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    void sendMessage(value, attachments)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const autoResize = (): void => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  return (
    <div className="border-t border-black/10 dark:border-white/10 p-4">
      <div className="mx-auto max-w-3xl">
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => void onDrop(e)}
          className={`rounded-2xl border bg-panel-light dark:bg-panel-dark p-2 shadow-sm transition-colors ${
            dragOver
              ? 'border-accent border-dashed'
              : 'border-black/10 dark:border-white/15'
          }`}
        >
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-1 pb-2">
              {attachments.map((a) =>
                a.kind === 'image' ? (
                  <div key={a.id} className="group relative">
                    <img
                      src={a.dataUrl}
                      alt={a.name}
                      title={a.name}
                      className="h-14 w-14 rounded-lg border border-black/10 dark:border-white/15 object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removeAttachment(a.id)}
                      className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-black/70 text-[10px] text-white group-hover:flex"
                      title="Remove"
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <span
                    key={a.id}
                    className="flex items-center gap-1.5 rounded-lg border border-black/10 dark:border-white/15 px-2.5 py-1.5 text-xs"
                    title={a.truncated ? `${a.name} (truncated)` : a.name}
                  >
                    📄 {a.name}
                    {a.truncated && <span className="text-neutral-400">(truncated)</span>}
                    <button
                      type="button"
                      onClick={() => removeAttachment(a.id)}
                      className="text-neutral-400 hover:text-red-500"
                      title="Remove"
                    >
                      ✕
                    </button>
                  </span>
                )
              )}
            </div>
          )}

          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={() => void pick()}
              disabled={streaming}
              className="shrink-0 rounded-xl px-2.5 py-1.5 text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
              title="Attach images or text files (or drop them here)"
            >
              📎
            </button>
            <button
              type="button"
              onClick={() => void toggleMic()}
              disabled={streaming || micState === 'transcribing'}
              className={`shrink-0 rounded-xl px-2.5 py-1.5 disabled:opacity-40 ${
                micState === 'recording'
                  ? 'animate-pulse bg-red-500/15 text-red-500'
                  : 'text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10'
              }`}
              title={
                micState === 'recording'
                  ? `Recording ${recSeconds}s — click to stop and transcribe, Esc to cancel`
                  : micState === 'transcribing'
                    ? 'Transcribing locally…'
                    : 'Push-to-talk (local whisper.cpp transcription)'
              }
            >
              {micState === 'recording'
                ? `🔴 ${recSeconds}s`
                : micState === 'transcribing'
                  ? '⏳'
                  : '🎙️'}
            </button>
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                autoResize()
              }}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Message FunkinAI… (@RoleName to route, drop files to attach)"
              className="max-h-[200px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-neutral-400"
            />
            {streaming ? (
              <button
                type="button"
                onClick={stopStreaming}
                className="shrink-0 rounded-xl bg-red-500/90 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-500"
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!text.trim() && attachments.length === 0}
                className="shrink-0 rounded-xl bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-40"
              >
                Send
              </button>
            )}
          </div>
        </div>

        <div className="mt-1.5 flex justify-between px-1 text-xs">
          {notice ? (
            <span className="text-red-500">{notice}</span>
          ) : (
            <span className="text-neutral-400">
              Enter to send · Shift+Enter for a new line · 📎 or drop images/text files
            </span>
          )}
          <span className="flex items-center gap-3">
            {armed.length > 0 && (
              <span
                className="text-amber-600 dark:text-amber-500"
                title={`Models can ${armed.join(' and ')} on this machine. Change this under Settings → Tools.`}
              >
                ⚠ can {armed.join(' + ')}
              </span>
            )}
            {handles.length > 0 && (
              <span className="text-neutral-400">Route: {handles.join('  ')}</span>
            )}
          </span>
        </div>
      </div>
    </div>
  )
}
