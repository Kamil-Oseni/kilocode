// raya_change - Thin LiveKit client: capture, playout accounting, discontinuity flush, and transcript display only.
import { RemoteAudioTrack, Room, RoomEvent, Track, type RoomOptions } from "livekit-client"

export type RealtimeConnection = {
  id: string
  livekitURL: string
  clientToken: string
  engine: "qwen-realtime"
  acceptsTruncation: boolean
}

export type RealtimeTranscript = {
  type: string
  turn?: string
  item?: string
  text: string
  stable: boolean
  truncated?: boolean
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
      this.sink.status("speaking")
    })
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      if (generation !== this.generation || this.room !== room) return
      if (track.kind !== Track.Kind.Audio) return
      void this.playout?.stop().catch(() => {
        if (generation === this.generation && this.room === room)
          this.failed("Voice playback could not stop. End voice and reconnect.")
      })
      this.playout = undefined
      this.sink.status("listening")
    })
    room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
      if (generation === this.generation && this.room === room) this.data(payload, topic)
    })
    room.on(RoomEvent.Reconnecting, () => {
      if (generation === this.generation && this.room === room) this.sink.status("degraded")
    })
    room.on(RoomEvent.Reconnected, () => {
      if (generation === this.generation && this.room === room) this.sink.status("listening")
    })
    room.on(RoomEvent.Disconnected, () => {
      if (generation !== this.generation || this.room !== room) return
      this.failed("Realtime media disconnected. Reconnect with the selected provider, or continue typing.")
    })
    try {
      await room.connect(connection.livekitURL, connection.clientToken, { autoSubscribe: true })
      if (generation !== this.generation) {
        await room.disconnect()
        return
      }
      await room.startAudio()
      if (generation !== this.generation) {
        await room.disconnect()
        return
      }
      const publication = await room.localParticipant.setMicrophoneEnabled(true, {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      })
      if (generation !== this.generation) {
        await room.disconnect()
        return
      }
      const capture = publication?.track?.mediaStreamTrack.getSettings()
      this.sink.aec(capture?.echoCancellation === true)
      this.sink.status("listening")
    } catch (err) {
      if (generation === this.generation) throw err
      await room.disconnect().catch(() => console.warn("[Kilo New] Superseded voice transport cleanup failed."))
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
    this.sink.status("listening")
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
