import { cancelled, owned } from "../../../src/shared/voice-interruption"
import type { RealtimeTranscript } from "./realtime-voice"

type Status = "off" | "connecting" | "listening" | "speaking" | "degraded"
type Sink = {
  status: (status: Status) => void
  transcript: (event: RealtimeTranscript) => void
  error: (message: string) => void
  notice?: (message: string) => void
  aec: (active: boolean) => void
}
type Operation = {
  sessionID: string
  requestID: string
  closed: boolean
  answer: boolean
  peer?: RTCPeerConnection
  channel?: RTCDataChannel
  audio?: HTMLAudioElement
  media?: MediaStream
  remote?: MediaStream
  timer?: ReturnType<typeof setTimeout>
  cancel?: (error: Error) => void
  ready?: () => void
  output?: string
  interrupted?: string
  clearing?: string
  interruption?: ReturnType<typeof setTimeout>
  images: Set<string>
  cancellations: Set<string>
  projection: Projection
}

/** Native media only. The trusted host owns authentication, tools and work dispatch. */
export class OpenAIVoice {
  private operation: Operation | undefined

  constructor(private readonly sink: Sink) {}

  async start(input: { sessionID: string; requestID: string }, exchange: (sdp: string) => Promise<string>) {
    if (this.operation) throw new Error("Voice is already starting or active. Stop it before starting again.")
    if (!input.sessionID || !input.requestID) throw new Error("Voice requires an owned session and request.")
    const operation: Operation = {
      ...input,
      closed: false,
      answer: false,
      cancellations: new Set(),
      images: new Set(),
      projection: new Projection(),
    }
    this.operation = operation
    this.sink.status("connecting")
    const cancelled = new Promise<never>((_resolve, reject) => {
      operation.cancel = reject
    })
    operation.timer = setTimeout(
      () => this.fail(operation, "OpenAI voice connection timed out. Stop and reconnect."),
      30_000,
    )
    try {
      await Promise.race([this.connect(operation, exchange), cancelled])
    } catch (error) {
      if (this.current(operation))
        this.fail(
          operation,
          "OpenAI voice could not connect. Check microphone permission and your connection, then reconnect.",
        )
      throw error
    }
  }

  image(id: string) {
    const operation = this.operation
    if (
      !operation ||
      !this.current(operation) ||
      operation.channel?.readyState !== "open" ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(id)
    )
      return false
    operation.images.add(`image_${id}`)
    bound(operation.images, 32)
    return true
  }

  mute(value: boolean) {
    const operation = this.operation
    if (!operation || !this.current(operation) || !operation.answer) return false
    const tracks = operation.media?.getAudioTracks() ?? []
    if (!tracks.length || tracks.some((track) => track.readyState !== "live")) return false
    for (const track of tracks) track.enabled = !value
    return true
  }

  interrupt() {
    const operation = this.operation
    if (!operation || !this.current(operation) || operation.channel?.readyState !== "open") return
    const responseID = operation.output
    if (!responseID || operation.interrupted === responseID) return
    const eventID = crypto.randomUUID()
    operation.cancellations.add(eventID)
    bound(operation.cancellations, 32)
    operation.interrupted = responseID
    operation.clearing = responseID
    clearTimeout(operation.interruption)
    operation.interruption = setTimeout(() => {
      if (this.current(operation) && operation.clearing)
        this.sink.notice?.("Speech stop was not confirmed. End voice and reconnect if audio does not resume.")
    }, 5000)
    if (operation.audio) operation.audio.muted = true
    this.sink.status("listening")
    return { responseID, eventID }
  }

  async stop() {
    const operation = this.operation
    if (operation) {
      operation.closed = true
      operation.cancel?.(new Error("Voice start cancelled."))
      if (!this.release(operation)) {
        this.sink.status("degraded")
        throw new Error("Voice cleanup failed. Stop voice again before reconnecting.")
      }
      if (this.operation === operation) this.operation = undefined
    }
    this.sink.aec(false)
    this.sink.status("off")
  }

  private current(operation: Operation) {
    return this.operation === operation && !operation.closed
  }

  private async connect(operation: Operation, exchange: (sdp: string) => Promise<string>) {
    const peer = new RTCPeerConnection()
    operation.peer = peer
    const audio = new Audio()
    operation.audio = audio
    audio.autoplay = true
    const channel = peer.createDataChannel("oai-events")
    operation.channel = channel
    channel.onmessage = (event) => {
      if (this.current(operation)) this.receive(operation, event.data)
    }
    channel.onopen = () => this.connected(operation)
    channel.onerror = () => this.fail(operation, "OpenAI voice event channel failed. Reconnect or continue typing.")
    channel.onclose = () => this.fail(operation, "OpenAI voice event channel closed. Reconnect or continue typing.")
    peer.onconnectionstatechange = () => {
      if (!this.current(operation)) return
      if (peer.connectionState === "connected") this.connected(operation)
      if (["failed", "closed", "disconnected"].includes(peer.connectionState))
        this.fail(operation, "OpenAI voice disconnected. Reconnect or continue typing.")
    }
    peer.ontrack = (event) => {
      if (!this.current(operation)) {
        event.track.stop()
        return
      }
      if (event.track.kind !== "audio") {
        event.track.stop()
        return
      }
      operation.remote = event.streams[0] ?? new MediaStream([event.track])
      audio.srcObject = operation.remote
      void audio
        .play()
        .catch(() =>
          this.fail(
            operation,
            "Voice playback was blocked. Check your audio device and reconnect from the voice button.",
          ),
        )
    }
    // Called directly from the user's Start action, before awaiting the host exchange.
    const media = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    })
    if (!this.current(operation)) {
      for (const track of media.getTracks()) track.stop()
      return
    }
    operation.media = media
    const track = media.getAudioTracks()[0]
    if (!track) throw new Error("No microphone track was supplied.")
    track.onended = () => this.fail(operation, "The microphone stopped. Reconnect voice or continue typing.")
    this.sink.aec(track.getSettings().echoCancellation === true)
    peer.addTrack(track, media)
    const offer = await peer.createOffer()
    if (!this.current(operation)) return
    await peer.setLocalDescription(offer)
    if (!this.current(operation)) return
    if (!offer.sdp) throw new Error("No voice connection offer was generated.")
    const sdp = await exchange(offer.sdp)
    if (!this.current(operation)) return
    if (!sdp || sdp.length > 1_000_000) throw new Error("Invalid voice connection answer.")
    await peer.setRemoteDescription({ type: "answer", sdp })
    if (!this.current(operation)) return
    operation.answer = true
    await new Promise<void>((resolve) => {
      operation.ready = resolve
      this.connected(operation)
    })
  }

  private connected(operation: Operation) {
    if (
      !this.current(operation) ||
      !operation.answer ||
      operation.peer?.connectionState !== "connected" ||
      operation.channel?.readyState !== "open"
    )
      return
    clearTimeout(operation.timer)
    operation.timer = undefined
    operation.ready?.()
    operation.ready = undefined
    this.sink.status("listening")
  }

  private receive(operation: Operation, data: unknown) {
    if (typeof data !== "string" || data.length > 524_288) return
    const packet = parse(data)
    if (!packet) return
    if (packet.type === "error") {
      if (cancelled(packet, operation.cancellations) || owned(packet, operation.images)) return
      this.fail(operation, "OpenAI reported a voice error. Reconnect or continue typing.")
      return
    }
    this.output(operation, packet)
    if (packet.type === "conversation.item.input_audio_transcription.failed") {
      const message =
        "Voice input transcription failed. Audio may still be connected; do not treat the transcript as complete."
      if (this.sink.notice) this.sink.notice(message)
      else console.warn("[Raya]", message)
      return
    }
    const transcript = operation.projection.receive(packet)
    if (transcript) this.sink.transcript(transcript)
  }

  private output(operation: Operation, packet: Packet) {
    if (packet.type === "input_audio_buffer.speech_started") {
      this.sink.status("listening")
      return
    }
    const id = packet.response_id
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return
    if (packet.type === "output_audio_buffer.started") {
      if (id === operation.interrupted) return
      operation.output = id
      if (operation.clearing) return
      if (operation.audio) operation.audio.muted = false
      this.sink.status("speaking")
      return
    }
    if (!["output_audio_buffer.stopped", "output_audio_buffer.cleared"].includes(packet.type)) return
    const cleared = id === operation.clearing
    if (cleared) {
      operation.clearing = undefined
      clearTimeout(operation.interruption)
    }
    if (id === operation.output) {
      operation.output = undefined
      this.sink.status("listening")
      return
    }
    if (!cleared || !operation.output) return
    if (operation.audio) operation.audio.muted = false
    this.sink.status("speaking")
  }

  private fail(operation: Operation, message: string) {
    if (!this.current(operation)) return
    operation.closed = true
    operation.cancel?.(new Error(message))
    const released = this.release(operation)
    if (released && this.operation === operation) this.operation = undefined
    this.sink.aec(false)
    this.sink.error(released ? message : `${message} Media cleanup also failed; stop voice before reconnecting.`)
    this.sink.status("degraded")
  }

  private release(operation: Operation) {
    clearTimeout(operation.interruption)
    clearTimeout(operation.timer)
    operation.timer = undefined
    operation.ready?.()
    operation.ready = undefined
    const failures: unknown[] = []
    const attempt = (action: () => void) => {
      try {
        action()
      } catch (error) {
        failures.push(error)
      }
    }
    attempt(() => {
      const channel = operation.channel
      if (!channel) return
      channel.onopen = channel.onclose = channel.onerror = channel.onmessage = null
      channel.close()
      operation.channel = undefined
    })
    for (const stream of [operation.media, operation.remote])
      for (const track of stream?.getTracks() ?? [])
        attempt(() => {
          track.onended = null
          track.stop()
        })
    attempt(() => {
      if (!operation.audio) return
      operation.audio.pause()
      operation.audio.srcObject = null
      operation.audio.remove()
      operation.audio = undefined
    })
    attempt(() => {
      if (!operation.peer) return
      operation.peer.ontrack = operation.peer.onconnectionstatechange = null
      operation.peer.close()
      operation.peer = undefined
    })
    return failures.length === 0
  }
}

type Packet = Record<string, unknown> & { type: string }
function parse(data: string): Packet | undefined {
  try {
    const value: unknown = JSON.parse(data)
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !("type" in value) ||
      typeof value.type !== "string"
    )
      return
    return value as Packet
  } catch (error) {
    console.warn(
      "[Raya] Ignored malformed voice event.",
      error instanceof SyntaxError ? "Invalid JSON" : "Invalid event",
    )
    return undefined
  }
}

/** Bounded display projection; never executes function calls or submits transcript text. */
class Projection {
  private text = new Map<string, { text: string; truncated: boolean }>()
  private done = new Set<string>()
  private events = new Set<string>()

  receive(packet: Packet): RealtimeTranscript | undefined {
    const kinds = {
      "conversation.item.input_audio_transcription.delta": ["input", false, "delta"],
      "conversation.item.input_audio_transcription.completed": ["input", true, "transcript"],
      "response.output_audio_transcript.delta": ["output", false, "delta"],
      "response.output_audio_transcript.done": ["output", true, "transcript"],
    } as const
    if (!Object.hasOwn(kinds, packet.type)) return
    const kind = kinds[packet.type as keyof typeof kinds]
    if (typeof packet.item_id !== "string" || packet.item_id.length > 256) return
    const value = packet[kind[2]]
    if (typeof value !== "string") return
    const key = `${kind[0]}:${packet.item_id}:${typeof packet.content_index === "number" ? packet.content_index : 0}`
    if (this.done.has(key)) return
    if (typeof packet.event_id === "string" && packet.event_id.length <= 256) {
      if (this.events.has(packet.event_id)) return
      this.events.add(packet.event_id)
      bound(this.events, 256)
    }
    const prior = this.text.get(key)
    const text = kind[1] ? value : (prior?.text ?? "") + value
    const truncated = text.length > 8192 || (!kind[1] && prior?.truncated === true)
    this.text.set(key, { text: text.slice(0, 8192), truncated })
    if (this.text.size > 64) this.text.delete(this.text.keys().next().value!)
    if (kind[1]) {
      this.text.delete(key)
      this.done.add(key)
      bound(this.done, 256)
    }
    return {
      type: packet.type,
      item: packet.item_id,
      turn: typeof packet.response_id === "string" && packet.response_id.length <= 256 ? packet.response_id : undefined,
      text: text.slice(0, 8192),
      stable: kind[1],
      truncated,
    }
  }
}

function bound(set: Set<string>, limit: number) {
  if (set.size > limit) set.delete(set.values().next().value!)
}
