// raya_change - Thin LiveKit client: capture, playout accounting, discontinuity flush, and transcript display only.
import {
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  TrackEvent,
  type LocalTrackPublication,
  type RoomOptions,
  type TrackPublication,
} from "livekit-client"
import { capture, MicrophoneError } from "./voice-errors"

export type RealtimeConnection = {
  id: string
  livekitURL: string
  clientToken: string
  engine: "qwen-realtime" | "openai-live"
  acceptsTruncation: boolean
}

export type RealtimeTranscript = {
  type: string
  turn?: string
  item?: string
  text: string
  stable: boolean
  truncated?: boolean
  direction?: "input" | "output"
  content?: number
  sequence?: number
  interruption?: "pending" | "confirmed"
  audioEndMs?: number
  generation?: "completed" | "cancelled" | "incomplete" | "failed"
  limited?: boolean
}

type Sink = {
  status: (status: "off" | "connecting" | "listening" | "speaking" | "degraded") => void
  transcript: (event: RealtimeTranscript) => void
  error: (error: string) => void
  fallback: (error: string) => void
  aec: (active: boolean) => void
}

export class RealtimeVoice {
  private room: Room | undefined
  private playout: Playout | undefined
  private connection: RealtimeConnection | undefined
  private generation = 0
  private available: (() => boolean) | undefined
  private detach: (() => void) | undefined

  constructor(
    private readonly sink: Sink,
    private readonly create: (options: RoomOptions) => Room = (options) => new Room(options),
  ) {}

  async start(connection: RealtimeConnection) {
    const generation = ++this.generation
    await this.release()
    if (generation !== this.generation) return
    this.connection = connection
    this.sink.status("connecting")
    const room = this.create({
      adaptiveStream: false,
      dynacast: false,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    })
    this.room = room
    const bind = this.microphone(room, generation)
    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (generation !== this.generation || this.room !== room) return
      if (track.kind !== Track.Kind.Audio) return
      const audio = track as RemoteAudioTrack
      this.playout = new Playout(room, audio, () => {
        if (generation === this.generation && this.room === room)
          this.failed("Voice playback accounting failed. Reconnect with the selected provider, or continue typing.")
      })
      void this.playout.start().catch(() => {
        if (generation === this.generation && this.room === room)
          this.failed("Voice playback could not start. Check your audio device and reconnect, or continue typing.")
      })
      this.status("speaking")
    })
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      if (generation !== this.generation || this.room !== room) return
      if (track.kind !== Track.Kind.Audio) return
      void this.playout?.stop().catch(() => {
        if (generation === this.generation && this.room === room)
          this.failed("Voice playback could not stop. End voice and reconnect.")
      })
      this.playout = undefined
      this.status("listening")
    })
    room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
      if (generation === this.generation && this.room === room) this.data(payload, topic)
    })
    room.on(RoomEvent.Reconnecting, () => {
      if (generation === this.generation && this.room === room) this.sink.status("degraded")
    })
    room.on(RoomEvent.Reconnected, () => {
      if (generation === this.generation && this.room === room) bind()
    })
    room.on(RoomEvent.Disconnected, () => {
      if (generation !== this.generation || this.room !== room) return
      this.failed("Realtime media disconnected. Reconnect with the selected provider, or continue typing.")
    })
    try {
      await room.connect(connection.livekitURL, connection.clientToken, { autoSubscribe: true })
      if (generation !== this.generation || this.room !== room) {
        await room.disconnect()
        return
      }
      await room.startAudio()
      if (generation !== this.generation || this.room !== room) {
        await room.disconnect()
        return
      }
      const publication = await room.localParticipant
        .setMicrophoneEnabled(true, {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        })
        .catch((err: unknown) => {
          if (capture(err)) throw new MicrophoneError(err)
          throw err
        })
      if (generation !== this.generation || this.room !== room) {
        await room.disconnect()
        return
      }
      if (publication) bind(publication)
      if (!publication || !this.available?.()) {
        throw new MicrophoneError()
      }
      this.sink.aec(publication.track?.mediaStreamTrack.getSettings().echoCancellation === true)
      this.status("listening")
    } catch (err) {
      if (generation === this.generation) throw err
      await room.disconnect().catch(() => console.warn("[Raya] Superseded voice transport cleanup failed."))
    }
  }

  async stop() {
    const generation = ++this.generation
    await this.release()
    if (generation === this.generation) this.sink.status("off")
  }

  private async release() {
    const room = this.room
    const playout = this.playout
    this.detach?.()
    this.detach = undefined
    this.available = undefined
    this.sink.aec(false)
    const results = await Promise.allSettled([playout?.stop(), room?.localParticipant.setMicrophoneEnabled(false)])
    // Always attempt transport teardown even when microphone or playout cleanup fails.
    const disconnected = await Promise.allSettled([room?.disconnect()])
    if (results[0]?.status === "fulfilled" && this.playout === playout) this.playout = undefined
    if (disconnected[0]?.status === "fulfilled" && this.room === room) {
      this.room = undefined
      this.connection = undefined
    }
    if ([...results, ...disconnected].some((result) => result.status === "rejected")) {
      throw new Error("Voice cleanup failed. End voice and restart the media frontend before reconnecting.")
    }
  }

  private failed(message: string) {
    this.sink.error(message)
    const stopping = this.stop()
    const generation = this.generation
    void stopping.then(
      () => {
        if (generation === this.generation) this.sink.status("degraded")
      },
      () => {
        if (generation !== this.generation) return
        this.sink.error("Voice cleanup failed. End voice and restart the media frontend before reconnecting.")
        this.sink.status("degraded")
      },
    )
  }

  private data(payload: Uint8Array, topic?: string) {
    if (topic !== "raya.transcript" && topic !== "raya.control" && topic !== "raya.playout.item") return
    const message = packet(payload)
    if (!message) return
    if (topic === "raya.control") {
      this.control(message)
      return
    }
    if (topic === "raya.playout.item") {
      if (typeof message.item === "string") this.playout?.setItem(message.item)
      return
    }
    if (typeof message.text !== "string" || typeof message.type !== "string") return
    if (message.type.includes("output") && typeof message.item === "string") this.playout?.setItem(message.item)
    this.sink.transcript({
      type: message.type,
      turn: typeof message.turn === "string" ? message.turn : undefined,
      item: typeof message.item === "string" ? message.item : undefined,
      text: message.text,
      stable: message.stable === true,
      truncated: message.truncated === true,
    })
  }

  private control(message: Record<string, unknown>) {
    if (message.type === "failure") {
      const error = failure(message, this.connection?.id)
      if (error) this.failed(error)
      return
    }
    if (message.type !== "discontinuity") return
    const generation = this.generation
    void this.playout?.flush().catch(() => {
      if (generation === this.generation)
        this.failed("Voice playback could not be interrupted. End voice and reconnect.")
    })
    this.status("listening")
  }

  private status(status: "listening" | "speaking") {
    this.sink.status(this.available?.() ? status : "degraded")
  }

  private microphone(room: Room, generation: number) {
    let publication: LocalTrackPublication | undefined
    let clear: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const owned = () => generation === this.generation && this.room === room
    const usable = () => {
      const track = publication?.audioTrack
      const native = track?.mediaStreamTrack
      return !!(
        owned() &&
        room.state === "connected" &&
        publication &&
        room.localParticipant.getTrackPublication(Track.Source.Microphone) === publication &&
        track &&
        !publication.isMuted &&
        !track.isMuted &&
        !track.isUpstreamPaused &&
        native?.readyState === "live" &&
        native.enabled &&
        !native.muted
      )
    }
    this.available = usable
    const cancel = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    }
    const unavailable = () => {
      return new MicrophoneError().message
    }
    const refresh = () => {
      if (!owned()) return
      if (usable()) {
        cancel()
        this.sink.aec(publication?.audioTrack?.mediaStreamTrack.getSettings().echoCancellation === true)
        this.status(this.playout ? "speaking" : "listening")
        return
      }
      this.sink.aec(false)
      this.sink.status("degraded")
      // Give the SDK's existing device restart a bounded opportunity to finish.
      // We never capture a replacement ourselves or infer failure from silence.
      if (timer === undefined)
        timer = setTimeout(() => {
          timer = undefined
          if (owned() && !usable()) this.failed(unavailable())
        }, 10_000)
    }
    const bind = (value = room.localParticipant.getTrackPublication(Track.Source.Microphone)) => {
      if (!owned()) return
      if (!value) {
        clear?.()
        clear = undefined
        publication = undefined
        refresh()
        return
      }
      if (
        !owned() ||
        value.source !== Track.Source.Microphone ||
        room.localParticipant.getTrackPublication(Track.Source.Microphone) !== value
      )
        return
      clear?.()
      publication = value
      const track = value.audioTrack
      if (!track) {
        refresh()
        return
      }
      let native: MediaStreamTrack | undefined
      const current = () =>
        owned() &&
        publication === value &&
        value.audioTrack === track &&
        room.localParticipant.getTrackPublication(Track.Source.Microphone) === value
      const state = () => {
        if (current()) refresh()
      }
      const ended = () => {
        if (current() && track.mediaStreamTrack.readyState === "ended") refresh()
      }
      const change = (event: Event) => {
        if (current() && event.target === native && track.mediaStreamTrack === native) refresh()
      }
      const remove = () => {
        native?.removeEventListener("mute", change)
        native?.removeEventListener("unmute", change)
        native?.removeEventListener("ended", change)
      }
      const restart = () => {
        if (!current()) return
        remove()
        native = track.mediaStreamTrack
        native.addEventListener("mute", change)
        native.addEventListener("unmute", change)
        native.addEventListener("ended", change)
        refresh()
      }
      track.on(TrackEvent.Restarted, restart)
      track.on(TrackEvent.Ended, ended)
      track.on(TrackEvent.UpstreamPaused, state)
      track.on(TrackEvent.UpstreamResumed, state)
      clear = () => {
        remove()
        track.off(TrackEvent.Restarted, restart)
        track.off(TrackEvent.Ended, ended)
        track.off(TrackEvent.UpstreamPaused, state)
        track.off(TrackEvent.UpstreamResumed, state)
      }
      restart()
    }
    const unpublished = (value: LocalTrackPublication) => {
      if (!owned() || publication !== value) return
      clear?.()
      clear = undefined
      publication = undefined
      refresh()
    }
    const changed = (value: TrackPublication, participant: unknown) => {
      if (
        !owned() ||
        participant !== room.localParticipant ||
        publication !== value ||
        room.localParticipant.getTrackPublication(Track.Source.Microphone) !== value
      )
        return
      if (value.isMuted && publication.audioTrack?.mediaStreamTrack.readyState === "ended") {
        this.failed(unavailable())
        return
      }
      refresh()
    }
    const error = (err: Error, kind?: MediaDeviceKind) => {
      if (!owned() || (kind !== undefined && kind !== "audioinput")) return
      this.failed(capture(err) ?? unavailable())
    }
    room.on(RoomEvent.LocalTrackPublished, bind)
    room.on(RoomEvent.LocalTrackUnpublished, unpublished)
    room.on(RoomEvent.TrackMuted, changed)
    room.on(RoomEvent.TrackUnmuted, changed)
    room.on(RoomEvent.MediaDevicesError, error)
    this.detach = () => {
      cancel()
      clear?.()
      room.off(RoomEvent.LocalTrackPublished, bind)
      room.off(RoomEvent.LocalTrackUnpublished, unpublished)
      room.off(RoomEvent.TrackMuted, changed)
      room.off(RoomEvent.TrackUnmuted, changed)
      room.off(RoomEvent.MediaDevicesError, error)
    }
    return bind
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function packet(payload: Uint8Array) {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(payload))
    return record(value) ? value : undefined
  } catch {
    return undefined
  }
}

function failure(message: Record<string, unknown>, id?: string) {
  if (!id || message.session !== id || !record(message.failure)) return
  const value = message.failure
  if (typeof value.code !== "string" || typeof value.message !== "string" || typeof value.recovery !== "string") return
  if (!value.message.trim() || !value.recovery.trim() || value.message.length > 500 || value.recovery.length > 500)
    return
  return `${value.message} ${value.recovery}`
}

class Playout {
  private context: AudioContext | undefined
  private source: MediaStreamAudioSourceNode | undefined
  private node: AudioWorkletNode | undefined
  private readonly cursor = new PlayoutCursor()

  constructor(
    private readonly room: Room,
    private readonly track: RemoteAudioTrack,
    private readonly fail: (error: string) => void,
  ) {}

  async start() {
    const context = new AudioContext()
    this.context = context
    const module = URL.createObjectURL(new Blob([worklet], { type: "text/javascript" }))
    try {
      await context.audioWorklet.addModule(module)
    } finally {
      URL.revokeObjectURL(module)
    }
    if (this.context !== context) return
    const source = context.createMediaStreamSource(new MediaStream([this.track.mediaStreamTrack]))
    const node = new AudioWorkletNode(context, "raya-playout")
    node.port.onmessage = (event: MessageEvent<{ samples: number }>) => {
      this.cursor.advance(event.data.samples)
      void this.report(context.sampleRate)
    }
    source.connect(node).connect(context.destination)
    this.context = context
    this.source = source
    this.node = node
    await context.resume()
  }

  async flush() {
    const track = this.track
    await this.stop()
    this.cursor.reset()
    if (track.mediaStreamTrack.readyState === "live") await this.start()
  }

  async stop() {
    this.source?.disconnect()
    this.node?.disconnect()
    this.node = undefined
    this.source = undefined
    const context = this.context
    this.context = undefined
    await context?.close()
  }

  setItem(item: string) {
    this.cursor.advance(0, item)
  }

  private async report(rate: number) {
    const connection = this.room.state === "connected"
    if (!connection) return
    const data = new TextEncoder().encode(
      JSON.stringify({
        item: this.cursor.item,
        samples: this.cursor.samples,
        rate,
        jitterMs: 0,
      }),
    )
    await this.room.localParticipant
      .publishData(data, { reliable: true, topic: "raya.playout" })
      .catch((err: unknown) => this.fail(err instanceof Error ? err.message : String(err)))
  }
}

// raya_change - deterministic sample-domain cursor used by interruption and replay tests.
export class PlayoutCursor {
  item = ""
  samples = 0

  advance(samples: number, item = this.item) {
    if (item && item !== this.item) {
      this.item = item
      this.samples = 0
    }
    this.samples += Math.max(0, Math.floor(samples))
    return this.samples
  }

  reset() {
    this.item = ""
    this.samples = 0
  }

  milliseconds(rate: number) {
    return rate > 0 ? (this.samples * 1000) / rate : 0
  }
}

const worklet = `
// raya_change - count samples at the actual Web Audio destination while passing audio through.
class RayaPlayout extends AudioWorkletProcessor {
  constructor() {
    super()
    this.pending = 0
  }
  process(inputs, outputs) {
    const input = inputs[0]
    const output = outputs[0]
    if (!input || !output) return true
    for (let channel = 0; channel < output.length; channel++) {
      output[channel].set(input[Math.min(channel, input.length - 1)] || new Float32Array(output[channel].length))
    }
    this.pending += output[0]?.length || 0
    if (this.pending >= sampleRate / 20) {
      this.port.postMessage({ samples: this.pending })
      this.pending = 0
    }
    return true
  }
}
registerProcessor("raya-playout", RayaPlayout)
`
