/**
 * Voice helpers, all local:
 *  - TTS via window.speechSynthesis (uses the OS's native voices on-device).
 *  - STT recording: getUserMedia + ScriptProcessorNode → 16 kHz mono WAV
 *    (the exact format whisper.cpp expects); bytes go to the main process
 *    for transcription. Chromium's cloud SpeechRecognition is intentionally
 *    NOT used — it would send audio to Google.
 */

// ---- TTS ---------------------------------------------------------------------

/** Reduce markdown to something pleasant to hear. */
export function stripForSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' (code block) ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' (image) ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>]+/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .trim()
}

export function speak(text: string, voiceURI: string, rate: number, onEnd?: () => void): void {
  if (!('speechSynthesis' in window)) {
    onEnd?.()
    return
  }
  window.speechSynthesis.cancel()
  const stripped = stripForSpeech(text)
  if (!stripped) {
    onEnd?.()
    return
  }
  const utterance = new SpeechSynthesisUtterance(stripped)
  if (voiceURI) {
    const voice = window.speechSynthesis.getVoices().find((v) => v.voiceURI === voiceURI)
    if (voice) utterance.voice = voice
  }
  utterance.rate = Math.min(2, Math.max(0.5, rate))
  if (onEnd) {
    utterance.onend = onEnd
    utterance.onerror = onEnd
  }
  window.speechSynthesis.speak(utterance)
}

export function stopSpeaking(): void {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
}

// ---- WAV recording -------------------------------------------------------------

const TARGET_SAMPLE_RATE = 16_000

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeString = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeString(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buffer
}

function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input
  const ratio = fromRate / toRate
  const length = Math.floor(input.length / ratio)
  const output = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    // Box-filter average around each target point — cheap anti-aliasing.
    const start = Math.floor(i * ratio)
    const end = Math.min(Math.floor((i + 1) * ratio), input.length)
    let sum = 0
    let count = 0
    for (let j = start; j < end; j++) {
      sum += input[j]
      count++
    }
    output[i] = count > 0 ? sum / count : 0
  }
  return output
}

/**
 * Records microphone audio and returns it as a 16 kHz mono WAV ArrayBuffer.
 * Usage: `const rec = new WavRecorder(); await rec.start(); … rec.stop()`
 *
 * Capture is capped at MAX_SECONDS so a forgotten recording can't grow
 * memory unboundedly; samples past the cap are dropped (stop() still works).
 */
export class WavRecorder {
  static readonly MAX_SECONDS = 150

  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private chunks: Float32Array[] = []
  private capturedSeconds = 0

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    })
    this.ctx = new AudioContext()
    this.source = this.ctx.createMediaStreamSource(this.stream)
    // ScriptProcessorNode is deprecated but universally available in
    // Chromium and fine for short push-to-talk clips.
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1)
    this.chunks = []
    this.capturedSeconds = 0
    this.processor.onaudioprocess = (e) => {
      if (this.capturedSeconds >= WavRecorder.MAX_SECONDS) return
      const data = e.inputBuffer.getChannelData(0)
      this.chunks.push(new Float32Array(data))
      this.capturedSeconds += data.length / (this.ctx?.sampleRate ?? 48_000)
    }
    this.source.connect(this.processor)
    this.processor.connect(this.ctx.destination)
  }

  /** Seconds of audio captured so far. */
  get elapsedSeconds(): number {
    return this.capturedSeconds
  }

  /** Stops recording and returns the WAV bytes (16 kHz mono PCM16). */
  stop(): ArrayBuffer {
    this.processor?.disconnect()
    this.source?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())

    const sampleRate = this.ctx?.sampleRate ?? 48_000
    void this.ctx?.close().catch(() => undefined)

    const total = this.chunks.reduce((n, c) => n + c.length, 0)
    const merged = new Float32Array(total)
    let offset = 0
    for (const chunk of this.chunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    this.chunks = []
    this.ctx = null
    this.stream = null
    this.source = null
    this.processor = null

    return encodeWav(downsample(merged, sampleRate, TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE)
  }

  /** Aborts recording without producing output. */
  cancel(): void {
    this.processor?.disconnect()
    this.source?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    void this.ctx?.close().catch(() => undefined)
    this.chunks = []
    this.ctx = null
    this.stream = null
    this.source = null
    this.processor = null
  }
}
