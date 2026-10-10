// raya_change - Push-to-talk and half-duplex hands-free turn controller
import type { VoiceMode } from "../../../src/shared/speech"

export type VoicePhase = "idle" | "listening" | "thinking" | "speaking"

type Sink = {
  listen: () => void
  stop: () => void
}

export class VoiceLoop {
  private mode: VoiceMode = "off"
  private phase: VoicePhase = "idle"
  private suspended = false

  constructor(private readonly sink: Sink) {}

  state() {
    return { mode: this.mode, phase: this.phase }
  }

  set(mode: VoiceMode) {
    this.mode = mode
    this.suspended = false
    if (mode === "off") {
      this.stop()
      return
    }
    if (mode === "hands-free" && this.phase === "idle") this.sink.listen()
  }

  sync(mode: VoiceMode) {
    if (!this.suspended) {
      this.set(mode)
      return
    }
    this.mode = mode
  }

  paused() {
    return this.suspended
  }

  pause() {
    this.suspended = true
    this.stop()
  }

  listen() {
    if (this.mode === "hands-free" && (this.phase === "thinking" || this.phase === "speaking")) return
    this.suspended = false
    if (this.mode === "off") return
    this.phase = "listening"
  }

  wait() {
    if (this.mode === "off" || this.suspended) return
    this.phase = "thinking"
  }

  speak() {
    if (this.mode === "off" || this.suspended) return
    this.phase = "speaking"
  }

  hear() {
    if (this.suspended) return
    if (this.mode === "hands-free" && (this.phase === "thinking" || this.phase === "speaking")) return
    if (this.phase === "speaking") this.sink.stop()
    if (this.mode !== "off") this.phase = "listening"
  }

  done() {
    this.phase = "idle"
    if (this.mode === "hands-free" && !this.suspended) this.sink.listen()
  }

  stop() {
    this.suspended = true
    this.sink.stop()
    this.phase = "idle"
  }
}
