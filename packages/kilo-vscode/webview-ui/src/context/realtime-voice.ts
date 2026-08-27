// raya_change - Thin LiveKit client: capture, playout accounting, discontinuity flush, and transcript display only.
import { RemoteAudioTrack, Room, RoomEvent, Track } from "livekit-client"

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
  private manual = false

  constructor(private readonly sink: Sink) {}

  async start(connection: RealtimeConnection) {
    await this.stop()
    this.manual = false
    this.connection = connection
    this.sink.status("connecting")
    const room = new Room({
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
      if (track.kind !== Track.Kind.Audio) return
      const audio = track as RemoteAudioTrack
      this.playout = new Playout(room, audio, this.sink.error)
      void this.playout.start()
      this.sink.status("speaking")
    })
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      if (track.kind !== Track.Kind.Audio) return
      void this.playout?.stop()
      this.playout = undefined
      this.sink.status("listening")
    })
    room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
      this.data(payload, topic)
    })
    room.on(RoomEvent.Reconnecting, () => this.sink.status("degraded"))
    room.on(RoomEvent.Reconnected, () => this.sink.status("listening"))
    room.on(RoomEvent.Disconnected, () => {
      if (this.manual || this.room !== room) return
      void this.stop().finally(() =>
        this.sink.fallback("Realtime media disconnected. Continuing with configured speech fallback."),
      )
    })
    await room.connect(connection.livekitURL, connection.clientToken, { autoSubscribe: true })
    await room.startAudio()
    const publication = await room.localParticipant.setMicrophoneEnabled(true, {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    })
    const capture = publication?.track?.mediaStreamTrack.getSettings()
    this.sink.aec(capture?.echoCancellation === true)
    this.sink.status("listening")
  }

  async stop() {
    this.manual = true
    await this.playout?.stop()
    this.playout = undefined
    const room = this.room
    this.room = undefined
    this.connection = undefined
    if (room) {
      await room.localParticipant.setMicrophoneEnabled(false)
      await room.disconnect()
    }
    this.sink.status("off")
  }

  private data(payload: Uint8Array, topic?: string) {
    if (topic !== "raya.transcript" && topic !== "raya.control" && topic !== "raya.playout.item") return
    const message = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>
    if (topic === "raya.playout.item" && typeof message.item === "string") {
      this.playout?.setItem(message.item)
      return
    }
    if (topic === "raya.control" && message.type === "discontinuity") {
      void this.playout?.flush()
      this.sink.status("listening")
      return
    }
    if (topic !== "raya.transcript" || typeof message.text !== "string" || typeof message.type !== "string") return
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
    const module = URL.createObjectURL(new Blob([worklet], { type: "text/javascript" }))
    await context.audioWorklet.addModule(module)
    URL.revokeObjectURL(module)
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
    await this.context?.close()
    this.context = undefined
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
