import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { useModels } from '../hooks/useModels'
import { modalClasses, useModalPresence } from '../hooks/useModalPresence'
import { Logo } from './Logo'
import type { SttStatus } from '../types'

type CheckState = 'ok' | 'warn' | 'fail' | 'checking'

interface Check {
  key: string
  title: string
  state: CheckState
  detail: string
  fix?: { label: string; action: () => void }
}

const ICONS: Record<CheckState, string> = {
  ok: '✅',
  warn: '⚠️',
  fail: '❌',
  checking: '⏳'
}

/**
 * First-run setup checklist: verifies the four things Sigma Oasis needs —
 * LM Studio, a configured model, whisper.cpp for voice input, and mic
 * permission — and points at the exact fix for each. Re-openable any time
 * from the 🧭 button in the sidebar.
 */
export function OnboardingModal(): JSX.Element | null {
  const open = useAppStore((s) => s.onboardingOpen)
  const setOpen = useAppStore((s) => s.setOnboardingOpen)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const connection = useAppStore((s) => s.connection)
  const settings = useAppStore((s) => s.settings)
  const setSettings = useAppStore((s) => s.setSettings)
  const { refresh } = useModels()
  const { mounted, leaving } = useModalPresence(open)

  const [stt, setStt] = useState<SttStatus | null>(null)
  const [mic, setMic] = useState<PermissionState | 'unsupported' | null>(null)

  const recheck = useCallback((): void => {
    void refresh()
    void window.api.getSttStatus().then(setStt).catch(() => setStt(null))
    if (navigator.permissions?.query) {
      navigator.permissions
        .query({ name: 'microphone' })
        .then((r) => setMic(r.state))
        .catch(() => setMic('unsupported'))
    } else {
      setMic('unsupported')
    }
  }, [refresh])

  // Live re-check while the panel is open — installing whisper or starting
  // LM Studio flips the row green without a restart.
  useEffect(() => {
    if (!open) return
    recheck()
    const timer = setInterval(recheck, 5000)
    return () => clearInterval(timer)
  }, [open, recheck])

  if (!mounted || !settings) return null

  const dismiss = (): void => {
    const updated = { ...settings, onboardingCompleted: true }
    setSettings(updated)
    void window.api.setSettings(updated)
    setOpen(false)
  }

  const modelReady = settings.models.some((m) => m.enabled && m.modelId.trim())

  const checks: Check[] = [
    {
      key: 'lmstudio',
      title: 'LM Studio is running',
      state: connection === 'online' ? 'ok' : connection === 'connecting' ? 'checking' : 'fail',
      detail:
        connection === 'online'
          ? `Connected to ${settings.baseUrl}`
          : 'Open LM Studio, load a model, and start the local server (default port 1234).',
      fix:
        connection === 'online'
          ? undefined
          : { label: 'Connection settings', action: () => setSettingsOpen(true) }
    },
    {
      key: 'model',
      title: 'A model is enabled',
      state: modelReady ? 'ok' : 'fail',
      detail: modelReady
        ? settings.models.find((m) => m.enabled && m.modelId.trim())!.roleName +
          ' will answer your chats'
        : 'Enable a slot and pick a model so chats have something to talk to.',
      fix: modelReady ? undefined : { label: 'Open model settings', action: () => setSettingsOpen(true) }
    },
    {
      key: 'stt',
      title: 'Voice input (whisper.cpp)',
      state: stt === null ? 'checking' : stt.available ? 'ok' : 'warn',
      detail:
        stt === null
          ? 'Checking…'
          : stt.available
            ? 'Push-to-talk and audio-file transcription are ready.'
            : (stt.reason ?? 'Not set up.') + ' Voice input is optional — everything else works.',
      fix:
        stt?.available
          ? undefined
          : { label: 'Voice settings', action: () => setSettingsOpen(true) }
    },
    {
      key: 'mic',
      title: 'Microphone permission',
      state: mic === 'granted' ? 'ok' : mic === 'denied' ? 'warn' : 'checking',
      detail:
        mic === 'granted'
          ? 'Sigma Oasis can use your microphone.'
          : mic === 'denied'
            ? 'Blocked — enable it in System Settings → Privacy & Security → Microphone.'
            : 'macOS will ask the first time you use push-to-talk.'
    }
  ]

  const blockers = checks.filter((c) => c.state === 'fail').length

  return (
    <div
      className={`${modalClasses(leaving).backdrop} fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4`}
      onClick={dismiss}
    >
      <div
        className={`${modalClasses(leaving).panel} w-full max-w-md rounded-2xl bg-panel-light dark:bg-panel-dark p-6 shadow-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-1"><Logo size={44} /></p>
        <h2 className="text-lg font-semibold">Welcome to Sigma Oasis</h2>
        <p className="mt-1 text-sm text-ink-secondary">
          Private, local-first AI chat. Let&apos;s make sure everything is ready:
        </p>

        <div className="mt-4 space-y-3">
          {checks.map((c) => (
            <div key={c.key} className="flex items-start gap-3">
              <span className="mt-0.5 text-base leading-none">{ICONS[c.state]}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{c.title}</p>
                <p className="mt-0.5 text-xs text-ink-secondary">{c.detail}</p>
                {c.fix && (
                  <button
                    type="button"
                    onClick={c.fix.action}
                    className="mt-1 text-xs font-medium text-accent hover:underline"
                  >
                    {c.fix.label} →
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 flex items-center justify-between">
          <button
            type="button"
            onClick={recheck}
            className="text-xs text-ink-tertiary hover:text-ink-primary"
          >
            ↻ Re-check now
          </button>
          <button
            type="button"
            onClick={dismiss}
            className="rounded-xl bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
          >
            {blockers === 0 ? 'Get started' : 'Continue anyway'}
          </button>
        </div>
      </div>
    </div>
  )
}
