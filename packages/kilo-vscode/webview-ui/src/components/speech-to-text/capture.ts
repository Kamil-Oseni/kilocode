// raya_change - Milestone H webview microphone capture with hands-free VAD
import { EchoGate } from "./echo-gate"

export type CapturedAudio = {
  data: string
  format: string
}

type Options = {
  threshold: number
  silenceMs: number
  echoSuppression?: boolean
  handsFree: boolean
  onSpeech: () => void
  onSilence: () => void
}

export class SpeechCapture {
  private stream: MediaStream | undefined
  private recorder: MediaRecorder | undefined
  private context: AudioContext | undefined
  private timer: number | undefined
  private chunks: Blob[] = []
  private reject: ((error: Error) => void) | undefined
  private keep = false
  private readonly gate = new EchoGate()

  async start(opts: Options): Promise<void> {
    if (this.recorder?.state !== "inactive") this.cancel()
    this.stopMonitor()
    const strong = {
      echoCancellation: { ideal: "all" },
      noiseSuppression: { ideal: true },
      autoGainControl: { ideal: false },
      voiceIsolation: { ideal: true },
      channelCount: { ideal: 1 },
    } as unknown as MediaTrackConstraints
    const basic: MediaTrackConstraints = {
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      autoGainControl: { ideal: false },
      channelCount: { ideal: 1 },
    }
    const stream =
      this.stream?.active === true
        ? this.stream
        : await navigator.mediaDevices
            .getUserMedia({ audio: strong })
            .catch(() => navigator.mediaDevices.getUserMedia({ audio: basic })) // raya_change - older Electron falls back from system-wide AEC
    const mime = format()
    const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
    this.keep = opts.handsFree
    this.stream = stream
    this.recorder = recorder
    this.chunks = []
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) this.chunks.push(event.data)
    })
    recorder.addEventListener("error", () => this.reject?.(new Error("Microphone recording failed.")))
    recorder.start(200)
    if (opts.handsFree) this.monitor(stream, opts)
  }

  stop(): Promise<CapturedAudio> {
    const recorder = this.recorder
    if (!recorder) return Promise.reject(new Error("No active microphone recording."))
    this.stopMonitor()
    return new Promise<CapturedAudio>((resolve, reject) => {
      this.reject = reject
      recorder.addEventListener(
        "stop",
        () => {
          const blob = new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" })
          void encode(blob).then(
            (data) => {
              this.cleanup(this.keep)
              resolve({ data, format: blob.type || "audio/webm" })
            },
            (err: unknown) => {
              this.cleanup(this.keep)
              reject(err instanceof Error ? err : new Error(String(err)))
            },
          )
        },
        { once: true },
      )
      recorder.stop()
    })
  }

  cancel(): void {
    this.keep = false
    this.gate.reset()
    this.stopMonitor()
    if (this.recorder?.state !== "inactive") this.recorder?.stop()
    this.cleanup()
  }

  rejectEcho(): void {
    this.gate.reject()
  }

  private monitor(stream: MediaStream, opts: Options) {
    const context = new AudioContext()
    const source = context.createMediaStreamSource(stream)
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    source.connect(analyser)
    this.context = context
    const samples = new Uint8Array(analyser.fftSize)
    const state = { heard: false, last: performance.now(), stopped: false }
    this.timer = window.setInterval(() => {
      analyser.getByteTimeDomainData(samples)
      const rms = Math.sqrt(samples.reduce((sum, sample) => sum + ((sample - 128) / 128) ** 2, 0) / samples.length)
      if (this.gate.hears(rms, opts.threshold, opts.echoSuppression === true)) {
        state.last = performance.now()
        if (!state.heard) {
          state.heard = true
          this.chunks = [] // raya_change - never send pre-barge speaker audio to transcription
          opts.onSpeech()
        }
        return
      }
      if (!state.heard || state.stopped || performance.now() - state.last < opts.silenceMs) return
      state.stopped = true
      opts.onSilence()
    }, 50)
  }

  private stopMonitor() {
    if (this.timer !== undefined) window.clearInterval(this.timer)
    this.timer = undefined
    void this.context?.close()
    this.context = undefined
  }

  private cleanup(preserve = false) {
    this.stopMonitor()
    if (!preserve) {
      for (const track of this.stream?.getTracks() ?? []) track.stop()
      this.stream = undefined
    }
    this.recorder = undefined
    this.chunks = []
    this.reject = undefined
  }
}

function format() {
  const formats = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
  return formats.find((item) => MediaRecorder.isTypeSupported(item)) ?? ""
}

async function encode(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const size = 0x8000
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += size) parts.push(String.fromCharCode(...bytes.subarray(i, i + size)))
  return btoa(parts.join(""))
}
