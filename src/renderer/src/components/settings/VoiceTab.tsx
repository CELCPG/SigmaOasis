// Extracted from SettingsModal.tsx (v2.4): the "voice" tab, as it was. Pure prop-drilling —
// every piece of state and every handler still lives in the modal and arrives here as a prop,
// so nothing about ordering, effects or behaviour changed; the modal just stopped being 2,500 lines.

import React from 'react'
import { speak } from '../../lib/voice'
import type { AppSettings, SttStatus } from '../../types'

export interface VoiceTabProps {
  draft: AppSettings
  setSttStatus: React.Dispatch<React.SetStateAction<SttStatus | null>>
  sttStatus: SttStatus | null
  update: (partial: Partial<AppSettings>) => void
  voices: SpeechSynthesisVoice[]
}

export function VoiceTab(props: VoiceTabProps): JSX.Element {
  const { draft, setSttStatus, sttStatus, update, voices } = props
  return (
    <div className="space-y-6">
                    {/* ---- Text-to-speech ---- */}
                    <div className="space-y-4">
                      <div className="text-sm font-medium">Text-to-speech</div>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={draft.voice.autoRead}
                          onChange={(e) =>
                            update({ voice: { ...draft.voice, autoRead: e.target.checked } })
                          }
                          className="accent-accent"
                        />
                        Voice mode — automatically read replies aloud
                      </label>
                      <div>
                        <label className="mb-1 block text-xs font-medium text-ink-secondary">Voice</label>
                        <select
                          value={draft.voice.voiceURI}
                          onChange={(e) => update({ voice: { ...draft.voice, voiceURI: e.target.value } })}
                          className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 text-sm outline-none"
                        >
                          <option value="">System default</option>
                          {voices.map((v) => (
                            <option key={v.voiceURI} value={v.voiceURI}>
                              {v.name} ({v.lang})
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium text-ink-secondary">
                          Speed: {draft.voice.rate.toFixed(1)}×
                        </label>
                        <input
                          type="range"
                          min={0.5}
                          max={2}
                          step={0.1}
                          value={draft.voice.rate}
                          onChange={(e) =>
                            update({ voice: { ...draft.voice, rate: Number(e.target.value) } })
                          }
                          className="w-64 accent-accent"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          speak(
                            'Hello! This is how Sigma Oasis will sound when reading replies aloud.',
                            draft.voice.voiceURI,
                            draft.voice.rate
                          )
                        }
                        className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-1.5 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                      >
                        🔊 Test voice
                      </button>
                      <p className="text-xs text-ink-secondary">
                        Uses your operating system&apos;s built-in voices — fully on-device.
                      </p>
                    </div>

                    {/* ---- Speech-to-text ---- */}
                    <div className="space-y-4 border-t border-black/10 dark:border-white/10 pt-4">
                      <div className="text-sm font-medium">Speech-to-text (push-to-talk 🎙️)</div>
                      <div className="flex items-center gap-3">
                        <span
                          className={`h-2.5 w-2.5 rounded-full ${
                            sttStatus?.available ? 'bg-green-500' : 'bg-red-500'
                          }`}
                        />
                        <span className="text-sm">
                          {sttStatus === null
                            ? 'Checking…'
                            : sttStatus.available
                              ? 'Ready — transcription runs locally via whisper.cpp'
                              : 'Not set up'}
                        </span>
                        <button
                          type="button"
                          onClick={() => void window.api.getSttStatus().then(setSttStatus)}
                          className="ml-auto rounded-lg border border-black/10 dark:border-white/10 px-3 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                        >
                          Re-check
                        </button>
                      </div>
                      {sttStatus && !sttStatus.available && (
                        <p className="rounded-lg bg-amber-500/10 p-3 text-xs text-ink-warn">
                          {sttStatus.reason}
                          <br />
                          Then download a model (e.g.{' '}
                          <code>ggml-base.en.bin</code> from the whisper.cpp releases) and point to it
                          below.
                        </p>
                      )}
                      <div>
                        <label className="mb-1 block text-xs font-medium text-ink-secondary">
                          whisper-cli path (empty = auto-detect)
                        </label>
                        <div className="flex gap-2">
                          <input
                            value={draft.stt.whisperCliPath}
                            onChange={(e) =>
                              update({ stt: { ...draft.stt, whisperCliPath: e.target.value } })
                            }
                            placeholder="/opt/homebrew/bin/whisper-cli"
                            className="flex-1 rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-sm outline-none"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              void window.api.pickFile().then((p) => {
                                if (p) update({ stt: { ...draft.stt, whisperCliPath: p } })
                              })
                            }
                            className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10"
                          >
                            Browse…
                          </button>
                        </div>
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium text-ink-secondary">
                          Model file (.bin, empty = auto-detect in ~/.cache/whisper)
                        </label>
                        <div className="flex gap-2">
                          <input
                            value={draft.stt.whisperModelPath}
                            onChange={(e) =>
                              update({ stt: { ...draft.stt, whisperModelPath: e.target.value } })
                            }
                            placeholder="~/.cache/whisper/ggml-base.en.bin"
                            className="flex-1 rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-sm outline-none"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              void window.api
                                .pickFile([{ name: 'Whisper model', extensions: ['bin'] }])
                                .then((p) => {
                                  if (p) update({ stt: { ...draft.stt, whisperModelPath: p } })
                                })
                            }
                            className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10"
                          >
                            Browse…
                          </button>
                        </div>
                      </div>
                      {sttStatus?.available && (
                        <p className="rounded-lg bg-black/5 dark:bg-white/5 p-3 font-mono text-xs text-ink-secondary">
                          cli: {sttStatus.cliPath}
                          <br />
                          model: {sttStatus.modelPath}
                        </p>
                      )}
                    </div>
                  </div>
  )
}
