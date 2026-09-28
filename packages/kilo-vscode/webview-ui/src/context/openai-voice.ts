import { cancelled, owned } from "../../../src/shared/voice-interruption"
import { valid, type Handoff, type HandoffAck } from "../../../src/shared/voice-handoff"
import { NativeProjection } from "./native-projection"
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
  projection: NativeProjection
  playback?: boolean
  speech?: boolean
}

/** Native media only. The trusted host owns authentication, tools and work dispatch. */
export class OpenAIVoice {
  private operation: Operation | undefined
  private candidate: Operation | undefined
  private retiring: Operation | undefined
  private handoff: Handoff | undefined
  private receipt: HandoffAck | undefined
  private retired: string | undefined
  private muted = false

  constructor(private readonly sink: Sink) {}

  async start(input: { sessionID: string; requestID: string }, exchange: (sdp: string) => Promise<string>) {
    if (this.operation || this.candidate || this.retiring)
      throw new Error("Voice is already starting or active. Stop it before starting again.")
    if (!input.sessionID || !input.requestID) throw new Error("Voice requires an owned session and request.")
    const operation: Operation = {
      ...input,
      closed: false,
      answer: false,
      cancellations: new Set(),
      images: new Set(),
      projection: new NativeProjection(),
    }
    this.operation = operation
    this.handoff = undefined
    this.receipt = undefined
    this.retired = undefined
    this.muted = false
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

  async prepare(handoff: Handoff, exchange: (sdp: string) => Promise<string>): Promise<HandoffAck> {
    const source = this.operation
    if (!valid(handoff) || !source || source.requestID !== handoff.source || source.sessionID !== handoff.sessionID)
      throw new Error("Voice replacement does not match the active call.")
    if (this.candidate || this.retiring || !this.healthy(source))
      throw new Error("Voice replacement cannot prepare while media is unavailable or cleanup is pending.")
    const track = source.media?.getAudioTracks()[0]
    if (!track || track.readyState !== "live") throw new Error("The active microphone is unavailable.")
    const clone = track.clone()
    clone.enabled = false
    const operation: Operation = {
      sessionID: handoff.sessionID,
      requestID: handoff.target,
      closed: false,
      answer: false,
      media: new MediaStream([clone]),
      images: new Set(),
      cancellations: new Set(),
      projection: new NativeProjection(),
    }
    this.handoff = Object.freeze({ ...handoff })
    this.receipt = undefined
    this.candidate = operation
    const cancellation = new Promise<never>((_resolve, reject) => {
      operation.cancel = reject
    })
    operation.timer = setTimeout(() => this.fail(operation, "Voice replacement preparation timed out."), 30_000)
    try {
      await Promise.race([this.connect(operation, exchange), cancellation])
      if (this.candidate !== operation || !this.healthy(operation) || !operation.playback)
        throw new Error("Voice replacement preparation was not confirmed.")
      return Object.freeze({ ...this.handoff!, phase: "prepared" })
    } catch (error) {
      if (this.current(operation))
        this.fail(operation, "Voice replacement could not prepare. Your current call is still active.")
      throw error
    }
  }

  cutover(handoff: Handoff): HandoffAck {
    if (!valid(handoff) || !this.matches(handoff)) throw new Error("Voice replacement identity changed.")
    if (this.receipt && this.operation?.requestID === handoff.target && !this.operation.closed) return this.receipt
    const source = this.operation
    const target = this.candidate
    if (
      !source ||
      !target ||
      source.requestID !== handoff.source ||
      target.requestID !== handoff.target ||
      !this.healthy(source) ||
      !this.healthy(target) ||
      !target.playback ||
      source.output ||
      source.clearing ||
      source.speech
    )
      throw new Error("Voice replacement is not ready at a quiet boundary.")
    try {
      for (const track of source.media!.getAudioTracks()) track.enabled = false
      source.audio!.muted = true
      this.retiring = source
      this.operation = target
      this.candidate = undefined
      for (const track of target.media!.getAudioTracks()) track.enabled = !this.muted
      target.audio!.muted = false
      this.receipt = Object.freeze({ ...this.handoff!, phase: "cutover" })
      this.sink.status("listening")
      return this.receipt
    } catch {
      const message = "Voice replacement cutover was not confirmed. End voice before reconnecting."
      this.fail(this.operation!, message)
      throw new Error(message)
    }
  }

  retire(source: string) {
    if (this.operation?.requestID === source || this.candidate?.requestID === source) return false
    const operation = this.retiring
    if (!operation) return this.retired === source
    if (operation.requestID !== source) return false
    operation.closed = true
    if (!this.release(operation)) return false
    this.retiring = undefined
    this.retired = source
    return true
  }

  private matches(handoff: Handoff) {
    const saved = this.handoff
    return (
      !!saved &&
      saved.id === handoff.id &&
      saved.sessionID === handoff.sessionID &&
      saved.source === handoff.source &&
      saved.target === handoff.target
    )
  }

  private healthy(operation: Operation) {
    return (
      this.current(operation) &&
      operation.answer &&
      operation.peer?.connectionState === "connected" &&
      operation.channel?.readyState === "open" &&
      !!operation.audio &&
      !!operation.media?.getAudioTracks().length &&
      operation.media.getAudioTracks().every((track) => track.readyState === "live") &&
      !!operation.remote?.getAudioTracks().length &&
      operation.remote.getAudioTracks().every((track) => track.readyState === "live")
    )
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
    this.muted = value
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
    const transcript = operation.projection.interrupt(responseID)
    if (transcript) this.sink.transcript(transcript)
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
    let failed = false
    for (const operation of [this.candidate, this.retiring, this.operation]) {
      if (!operation) continue
      operation.closed = true
      operation.cancel?.(new Error("Voice start cancelled."))
      if (!this.release(operation)) {
        failed = true
        continue
      }
      if (this.operation === operation) this.operation = undefined
      if (this.candidate === operation) this.candidate = undefined
      if (this.retiring === operation) this.retiring = undefined
    }
    if (failed) {
      this.sink.status("degraded")
      throw new Error("Voice cleanup failed. Stop voice again before reconnecting.")
    }
    this.handoff = undefined
    this.receipt = undefined
    this.retired = undefined
    this.muted = false
    this.sink.aec(false)
    this.sink.status("off")
  }

  private current(operation: Operation) {
    return (
      (this.operation === operation || this.candidate === operation || this.retiring === operation) && !operation.closed
    )
  }

  private async connect(operation: Operation, exchange: (sdp: string) => Promise<string>) {
    const peer = new RTCPeerConnection()
    operation.peer = peer
    const audio = new Audio()
    operation.audio = audio
    audio.autoplay = true
    audio.muted = operation === this.candidate
    const channel = peer.createDataChannel("oai-events")
    operation.channel = channel
    channel.onmessage = (event) => {
      if (this.current(operation) && operation !== this.retiring) this.receive(operation, event.data)
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
        .then(() => {
          if (!this.current(operation)) return
          operation.playback = true
          this.connected(operation)
        })
        .catch(() =>
          this.fail(
            operation,
            "Voice playback was blocked. Check your audio device and reconnect from the voice button.",
          ),
        )
    }
    // Called directly from the user's Start action, before awaiting the host exchange.
    const media =
      operation.media ??
      (await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      }))
    if (!this.current(operation)) {
      for (const track of media.getTracks()) track.stop()
      return
    }
    operation.media = media
    const track = media.getAudioTracks()[0]
    if (!track) throw new Error("No microphone track was supplied.")
    track.onended = () => this.fail(operation, "The microphone stopped. Reconnect voice or continue typing.")
    if (operation === this.operation) this.sink.aec(track.getSettings().echoCancellation === true)
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
      operation.channel?.readyState !== "open" ||
      (operation === this.candidate && (!operation.playback || !this.healthy(operation)))
    )
      return
    clearTimeout(operation.timer)
    operation.timer = undefined
    operation.ready?.()
    operation.ready = undefined
    if (operation === this.operation) this.sink.status("listening")
  }

  private receive(operation: Operation, data: unknown) {
    if (typeof data !== "string" || data.length > 524_288) return
    const packet = parse(data)
    if (!packet) return
    if (operation === this.candidate) {
      if (
        packet.type === "error" ||
        packet.type === "response.created" ||
        packet.type === "output_audio_buffer.started" ||
        packet.type === "input_audio_buffer.speech_started"
      )
        this.fail(operation, "Voice replacement produced activity before cutover. Your current call is still active.")
      return
    }
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
    if (packet.type === "input_audio_buffer.speech_stopped") operation.speech = false
    if (packet.type === "input_audio_buffer.speech_started") {
      operation.speech = true
      const transcript = operation.projection.interrupt(operation.output)
      if (transcript) this.sink.transcript(transcript)
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
    if (operation === this.candidate || operation === this.retiring) {
      operation.closed = true
      operation.cancel?.(new Error(message))
      if (this.release(operation)) {
        if (this.candidate === operation) this.candidate = undefined
        if (this.retiring === operation) this.retiring = undefined
      }
      this.sink.notice?.(message)
      return
    }
    for (const child of [this.candidate, this.retiring]) {
      if (!child) continue
      child.closed = true
      child.cancel?.(new Error("The active voice call ended."))
      if (this.release(child)) {
        if (this.candidate === child) this.candidate = undefined
        if (this.retiring === child) this.retiring = undefined
      }
    }
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

function bound(set: Set<string>, limit: number) {
  if (set.size > limit) set.delete(set.values().next().value!)
}
