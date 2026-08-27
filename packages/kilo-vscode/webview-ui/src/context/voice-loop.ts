// raya_change - Milestone H executable push-to-talk, hands-free, and barge-in controller
import type { VoiceMode } from "../../../src/shared/speech"

export type VoicePhase = "idle" | "listening" | "thinking" | "speaking"

type Sink = {
  listen: () => void
  stop: () => void
}

export class VoiceLoop {
  private mode: VoiceMode = "off"
  private phase: VoicePhase = "idle"

  constructor(private readonly sink: Sink) {}

  state() {
    return { mode: this.mode, phase: this.phase }
  }

  set(mode: VoiceMode) {
    this.mode = mode
    if (mode === "off") {
      this.stop()
      return
    }
    if (mode === "hands-free" && this.phase === "idle") this.sink.listen()
  }

  listen() {
    if (this.mode === "off") return
    this.phase = "listening"
  }

  wait() {
    if (this.mode === "off") return
    this.phase = "thinking"
  }

  speak() {
    if (this.mode === "off") return
    this.phase = "speaking"
  }

  hear() {
    if (this.phase === "speaking") this.sink.stop()
    if (this.mode !== "off") this.phase = "listening"
  }

  done() {
    this.phase = "idle"
    if (this.mode === "hands-free") this.sink.listen()
  }

  stop() {
    this.sink.stop()
    this.phase = "idle"
  }
}
