import { LiveContext } from "../../../src/shared/live-context"

type Sink = {
  status: (value: "off" | "connecting" | "listening" | "degraded") => void
  captions: (value: ReturnType<LiveContext["snapshot"]>) => void
  error: (message: string) => void
  aec: (active: boolean) => void
}
type Operation = {
  id: string
  closed: boolean
  started: boolean
  answer: boolean
  muted: boolean
  failed: boolean
  peer: RTCPeerConnection
  channel: RTCDataChannel
  audio: HTMLAudioElement
  context: LiveContext
  media?: MediaStream
  remote?: MediaStream
  timer?: ReturnType<typeof setTimeout>
  ready?: () => void
  reject?: (error: Error) => void
  closing?: Promise<void>
  finish?: () => void
}

/** Media and display only. No commands or work context are sent over the data channel. */
const acoustic = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
} as const

/** Turn host PCM (s16le) into a WebRTC-capable MediaStream when the webview microphone is blocked. */
export function pump(rate = 24_000) {
  const ctx = new AudioContext()
  const dest = ctx.createMediaStreamDestination()
  const queue: Float32Array[] = []
  const node = ctx.createScriptProcessor(2048, 1, 1)
  if (ctx.state === "suspended") void ctx.resume()
  node.onaudioprocess = (event) => {
    const out = event.outputBuffer.getChannelData(0)
    out.fill(0)
    let filled = 0
    while (filled < out.length && queue.length > 0) {
      const next = queue[0]
      const take = Math.min(out.length - filled, next.length)
      out.set(next.subarray(0, take), filled)
      filled += take
      if (take === next.length) queue.shift()
      else queue[0] = next.subarray(take)
    }
  }
  node.connect(dest)
  return {
    stream: dest.stream,
    write(bytes: ArrayBuffer) {
      const src = new Int16Array(bytes)
      if (src.length === 0) return
      const ratio = ctx.sampleRate / rate
      const pcm = new Float32Array(Math.max(1, Math.round(src.length * ratio)))
      for (const i of pcm.keys()) pcm[i] = src[Math.min(src.length - 1, Math.floor(i / ratio))] / 32768
      queue.push(pcm)
    },
    async close() {
      node.disconnect()
      for (const track of dest.stream.getTracks()) track.stop()
      await ctx.close()
    },
  }
}

export class LiveVoice {
  private operation?: Operation

  constructor(
    private readonly sink: Sink,
    private readonly linger = 12_000,
    private readonly acquire?: () => Promise<MediaStream>,
  ) {}

  async start(input: { requestID: string; sessionID: string }, exchange: (sdp: string) => Promise<string>) {
    if (this.operation) throw new Error("End the previous voice call before starting another.")
    if (!input.requestID || !input.sessionID) throw new Error("Voice requires an owned task.")
    const peer = new RTCPeerConnection()
    const audio = new Audio()
    const operation: Operation = {
      id: input.requestID,
      closed: false,
      started: false,
      answer: false,
      muted: false,
      failed: false,
      peer,
      audio,
      channel: peer.createDataChannel("oai-events"),
      context: new LiveContext(),
    }
    this.operation = operation
    this.sink.status("connecting")
    const ready = new Promise<void>((resolve, reject) => {
      operation.ready = resolve
      operation.reject = reject
    })
    void ready.catch(() => {})
    const connect = this.connect(operation, exchange)
    operation.timer = setTimeout(() => this.fail(operation, "Live voice connection timed out. Reconnect to try again."), 30_000)
    await Promise.all([ready, connect]).catch((error: unknown) => {
      this.fail(operation, "Live voice could not connect. Check microphone access and reconnect.")
      if (this.operation === operation && !operation.closed && !operation.closing) {
        operation.closed = true
        clearTimeout(operation.timer)
        this.release(operation)
        this.operation = undefined
        this.sink.aec(false)
        this.sink.status("degraded")
      }
      throw error
    })
  }

  started(id: string) {
    const operation = this.operation
    if (!operation || operation.id !== id || operation.closed) return
    operation.started = true
    this.connected(operation)
  }

  mute(value: boolean) {
    const operation = this.operation
    if (!operation || operation.closed) return false
    operation.muted = value
    for (const track of operation.media?.getAudioTracks() ?? []) track.enabled = this.prepared(operation) && !value
    return true
  }

  silence(value: boolean) {
    const operation = this.operation
    if (!operation || operation.closed) return false
    operation.audio.muted = value
    return true
  }

  /** Silence immediately, then retain transport until the host has collected final usage. */
  stop() {
    const operation = this.operation
    if (!operation) return Promise.resolve()
    if (operation.closing) return operation.closing
    operation.closed = true
    clearTimeout(operation.timer)
    operation.reject?.(new Error("Voice connection cancelled."))
    operation.audio.muted = true
    for (const track of operation.media?.getAudioTracks() ?? []) track.enabled = false
    operation.closing = new Promise<void>((resolve, reject) => {
      operation.finish = () => {
        clearTimeout(operation.timer)
        const failed = this.release(operation)
        if (!failed && this.operation === operation) this.operation = undefined
        this.sink.aec(false)
        this.sink.status(failed ? "degraded" : "off")
        if (failed) reject(new Error("Live voice media cleanup failed. Restart Raya before reconnecting."))
        else resolve()
      }
      operation.timer = setTimeout(operation.finish, this.linger)
    })
    return operation.closing
  }

  finalized(id: string) {
    const operation = this.operation
    if (operation?.id === id) operation.finish?.()
  }

  private async capture() {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: acoustic })
    } catch (err) {
      if (!this.acquire) throw err
      return this.acquire()
    }
  }

  private current(operation: Operation) {
    return this.operation === operation && !operation.closed
  }

  private prepared(operation: Operation) {
    return (
      this.current(operation) &&
      operation.started &&
      operation.answer &&
      operation.peer.connectionState === "connected" &&
      operation.channel.readyState === "open"
    )
  }

  private async connect(operation: Operation, exchange: (sdp: string) => Promise<string>) {
    const peer = operation.peer
    const channel = operation.channel
    channel.onopen = () => this.connected(operation)
    channel.onclose = () => this.fail(operation, "Live voice disconnected. End the call and reconnect.")
    channel.onerror = () => this.fail(operation, "Live voice event channel failed. End the call and reconnect.")
    channel.onmessage = (event) => {
      if (!this.current(operation) || typeof event.data !== "string") return
      if (event.data.length > 524_288) {
        this.fail(operation, "Live voice received an oversized event. Reconnect to continue.")
        return
      }
      try {
        const packet: unknown = JSON.parse(event.data)
        const changed = operation.context.receive(packet)
        if (changed !== "ignored") this.sink.captions(operation.context.snapshot())
      } catch {
        this.fail(operation, "Live voice received an unreadable event. Reconnect to continue.")
      }
    }
    peer.onconnectionstatechange = () => {
      this.connected(operation)
      if (["failed", "closed", "disconnected"].includes(peer.connectionState))
        this.fail(operation, "Live voice connection was lost. Reconnect or continue typing.")
    }
    peer.ontrack = (event) => {
      if (!this.current(operation) || event.track.kind !== "audio") {
        event.track.stop()
        return
      }
      operation.remote = event.streams[0] ?? new MediaStream([event.track])
      operation.audio.srcObject = operation.remote
      operation.audio.autoplay = true
      void operation.audio.play().catch(() => this.fail(operation, "Live voice playback was blocked. Reconnect from the voice button."))
    }
    const media = await this.capture()
    if (!this.current(operation)) {
      for (const track of media.getTracks()) track.stop()
      return
    }
    operation.media = media
    const track = media.getAudioTracks()[0]
    if (!track) throw new Error("No microphone track was supplied.")
    track.enabled = false
    track.onended = () => this.fail(operation, "The microphone stopped. End voice and reconnect.")
    this.sink.aec(track.getSettings().echoCancellation === true)
    peer.addTrack(track, media)
    const offer = await peer.createOffer()
    if (!this.current(operation)) return
    await peer.setLocalDescription(offer)
    if (!this.current(operation)) return
    if (!offer.sdp) throw new Error("No Live voice connection offer was generated.")
    const sdp = await exchange(offer.sdp)
    if (!this.current(operation)) return
    if (!sdp || sdp.length > 1_000_000) throw new Error("Invalid Live voice connection answer.")
    await peer.setRemoteDescription({ type: "answer", sdp })
    if (!this.current(operation)) return
    operation.answer = true
    this.connected(operation)
  }

  private connected(operation: Operation) {
    if (!this.prepared(operation)) return
    clearTimeout(operation.timer)
    for (const track of operation.media?.getAudioTracks() ?? []) track.enabled = !operation.muted
    operation.ready?.()
    operation.ready = undefined
    operation.reject = undefined
    this.sink.status("listening")
  }

  private fail(operation: Operation, message: string) {
    if (!this.current(operation) || operation.failed) return
    operation.failed = true
    for (const track of operation.media?.getAudioTracks() ?? []) track.enabled = false
    operation.audio.muted = true
    const reject = operation.reject
    operation.reject = undefined
    operation.ready = undefined
    reject?.(new Error(message))
    this.sink.error(message)
    this.sink.status("degraded")
  }

  private release(operation: Operation) {
    const failures: unknown[] = []
    const attempt = (action: () => void) => {
      try { action() } catch (error) { failures.push(error) }
    }
    attempt(() => {
      operation.channel.onopen = operation.channel.onclose = operation.channel.onerror = operation.channel.onmessage = null
      operation.channel.close()
    })
    for (const stream of [operation.media, operation.remote])
      for (const track of stream?.getTracks() ?? []) attempt(() => { track.onended = null; track.stop() })
    attempt(() => { operation.audio.pause(); operation.audio.srcObject = null; operation.audio.remove() })
    attempt(() => { operation.peer.ontrack = operation.peer.onconnectionstatechange = null; operation.peer.close() })
    return failures.length > 0
  }
}
