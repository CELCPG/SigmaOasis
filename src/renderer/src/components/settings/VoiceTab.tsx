// Settings → Voice (v4.0, S4): two cards — replies read aloud through the
// system's voices, and push-to-talk through whisper.cpp — each with its own
// status row, the paths as fields with their help beneath rather than inside
// the label.
import { useEffect, useState } from 'react'
import { speak } from '../../lib/voice'
import type { AppSettings, SttStatus } from '../../types'
import type { ApplySettings } from '../../hooks/settingsApply'
import { defineRows, registerRows } from '../../lib/settingsKit'
import { ActionRow, Button, Field, Notice, Row, Section, Select, Slider, Switch, type ActionResult } from './kit'

export const ROWS = defineRows('voice', {
  autoRead: { label: 'Read replies aloud', help: 'Every reply is spoken as it finishes, with the voice and speed below.', keywords: ['voice mode', 'tts', 'speak'] },
  voiceURI: { label: 'Voice', help: 'One of your operating system’s built-in voices — fully on-device.', keywords: ['tts', 'speech'] },
  rate: { label: 'Speed', help: 'From half speed to double.', keywords: ['rate'] },
  test: { label: 'Hear it', help: 'One sentence in the voice and speed above.', keywords: ['test voice'] },
  sttStatus: { label: 'Push-to-talk', help: 'Hold 🎙️ in the composer to dictate. Transcription runs locally through whisper.cpp when it is set up.', keywords: ['dictation', 'stt', 'microphone', 'whisper'] },
  whisperCliPath: { label: 'whisper-cli path', help: 'Leave empty to look on the PATH and in Homebrew. Applies when you press Enter or leave the field.', keywords: ['whisper', 'binary'] },
  whisperModelPath: { label: 'Model file', help: 'A ggml .bin from the whisper.cpp releases, such as ggml-base.en.bin. Leave empty to look in ~/.cache/whisper.', keywords: ['whisper', 'ggml', 'bin'] }
})
registerRows(ROWS)

export interface VoiceTabProps {
  settings: AppSettings
  apply: ApplySettings
  defaults: AppSettings | null
}

export function VoiceTab({ settings, apply, defaults }: VoiceTabProps): JSX.Element {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [stt, setStt] = useState<SttStatus | null>(null)
  useEffect(() => {
    const loadVoices = (): void => setVoices(window.speechSynthesis?.getVoices() ?? [])
    loadVoices()
    window.speechSynthesis?.addEventListener('voiceschanged', loadVoices)
    void window.api.getSttStatus().then(setStt)
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', loadVoices)
  }, [])
  const voice = settings.voice
  const setVoice = (meta: (typeof ROWS)[keyof typeof ROWS], patch: Partial<AppSettings['voice']>, shown?: string): void => apply(meta, { voice: { ...voice, ...patch } }, shown)
  const setStt2 = (meta: (typeof ROWS)[keyof typeof ROWS], patch: Partial<AppSettings['stt']>): void => apply(meta, { stt: { ...settings.stt, ...patch } })
  const sttResult: ActionResult | null = stt === null ? { tone: 'info', text: 'Checking…' } : stt.available ? { tone: 'ok', text: 'Ready — transcription runs locally via whisper.cpp' } : { tone: 'warn', text: 'Not set up' }

  return (
    <div className="space-y-8">
      <Section title="Text-to-speech" description="Replies read aloud, on this machine." onReset={defaults ? () => apply({ id: 'voice.reset', label: 'Text-to-speech' }, { voice: defaults.voice }, 'defaults') : undefined}>
        <Row meta={ROWS.autoRead}>
          <Switch checked={voice.autoRead} onChange={(autoRead) => setVoice(ROWS.autoRead, { autoRead })} />
        </Row>
        <Row meta={ROWS.voiceURI}>
          <Select
            value={voice.voiceURI}
            onChange={(voiceURI) => setVoice(ROWS.voiceURI, { voiceURI }, voices.find((v) => v.voiceURI === voiceURI)?.name ?? 'System default')}
            options={[{ value: '', label: 'System default' }, ...voices.map((v) => ({ value: v.voiceURI, label: `${v.name} (${v.lang})` }))]}
          />
        </Row>
        <Row meta={ROWS.rate}>
          <Slider value={voice.rate} min={0.5} max={2} step={0.1} format={(v) => `${v.toFixed(1)}×`} onCommit={(rate) => setVoice(ROWS.rate, { rate }, `${rate.toFixed(1)}×`)} />
        </Row>
        <Row meta={ROWS.test}>
          <Button onClick={() => speak('Hello! This is how Sigma Oasis will sound when reading replies aloud.', voice.voiceURI, voice.rate)}>🔊 Test voice</Button>
        </Row>
      </Section>

      <Section title="Speech-to-text" description="Dictation through whisper.cpp, which you install; the app finds it or you point to it.">
        <Row meta={ROWS.sttStatus} layout="stack" foot={stt?.available ? <span className="font-mono text-[11px] text-ink-tertiary">cli: {stt.cliPath} · model: {stt.modelPath}</span> : undefined}>
          <ActionRow action="Re-check" onAction={() => void window.api.getSttStatus().then(setStt)} result={sttResult} />
        </Row>
        {stt && !stt.available && (
          <Notice tone="warn">
            {stt.reason} Then download a model (e.g. <code>ggml-base.en.bin</code> from the whisper.cpp releases) and point to it below.
          </Notice>
        )}
        <Row meta={ROWS.whisperCliPath} layout="stack">
          <div className="flex gap-2">
            <Field value={settings.stt.whisperCliPath} mono placeholder="/opt/homebrew/bin/whisper-cli" onCommit={(whisperCliPath) => setStt2(ROWS.whisperCliPath, { whisperCliPath })} />
            <Button
              onClick={() =>
                void window.api.pickFile().then((p) => {
                  if (p) setStt2(ROWS.whisperCliPath, { whisperCliPath: p })
                })
              }
            >
              Browse…
            </Button>
          </div>
        </Row>
        <Row meta={ROWS.whisperModelPath} layout="stack">
          <div className="flex gap-2">
            <Field value={settings.stt.whisperModelPath} mono placeholder="~/.cache/whisper/ggml-base.en.bin" onCommit={(whisperModelPath) => setStt2(ROWS.whisperModelPath, { whisperModelPath })} />
            <Button
              onClick={() =>
                void window.api.pickFile([{ name: 'Whisper model', extensions: ['bin'] }]).then((p) => {
                  if (p) setStt2(ROWS.whisperModelPath, { whisperModelPath: p })
                })
              }
            >
              Browse…
            </Button>
          </div>
        </Row>
      </Section>
    </div>
  )
}
