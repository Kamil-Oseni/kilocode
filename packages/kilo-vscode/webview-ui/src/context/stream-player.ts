// raya_change - Testable webview sink for streamed MiniMax PCM and encoded speech.
type Diagnostic = {
  event: string
  request?: string
  state?: string
  bytes?: number
  count?: number
  peak?: number
  rate?: number
  output?: "direct" | "bridge"
  elapsed?: number
  at?: number
  start?: number
  remaining?: number
  duration?: number
}

export class StreamPlayer {
  private budget = 0
  private request: string | undefined
  private audio: HTMLAudioElement | undefined
  private source: MediaSource | undefined
  private buffer: SourceBuffer | undefined
  private queue: Uint8Array[] = []
  private context: AudioContext | undefined
  private nodes = new Set<AudioBufferSourceNode>()
  private output: AudioNode | undefined
  private bridge:
    | {
        sink: MediaStreamAudioDestinationNode
        audio: HTMLAudioElement
        send: RTCPeerConnection
        receive: RTCPeerConnection
      }
    | undefined
  private bridging = false
  private next = 0
  private began: number | undefined
  private ending = false
  private pending: AudioBuffer[] = []
  private duration = 0
  private bytes = 0
  private timer: number | undefined
  private clock: number | undefined

  constructor(
    private readonly done: () => void,
    private readonly fail: (error: string) => void,
    private readonly diagnostic?: (row: Diagnostic) => void,
  ) {}

  private trace(row: Diagnostic) {
    if (this.budget++ >= 24) return
    const request = row.request ?? this.request
    try {
      this.diagnostic?.({
        ...row,
        elapsed: this.clock === undefined ? 0 : Math.max(0, Math.round(performance.now() - this.clock)),
        request:
          request && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request)
            ? request
            : undefined,
      })
    } catch {
      console.warn("[Raya Voice playback] Diagnostic observer failed.")
    }
  }

  unlock() {
    const context = this.context ?? new AudioContext()
    this.context = context
    this.output ??= context.destination
    this.trace({
      event: "context",
      state: context.state,
      output: this.bridge && this.output === this.bridge.sink ? "bridge" : "direct",
    })
    if (!this.bridging && !this.bridge)
      void this.connect(context).catch((err: unknown) => {
        if (this.context !== context) return
        this.closeBridge()
        this.output = context.destination
        this.trace({ event: "bridge-fallback", state: context.state, output: "direct" })
        console.warn("[Raya Voice] WebRTC echo reference unavailable; using direct audio output.", err)
      })
    void context
      .resume()
      .then(() => {
        if (this.context === context) this.trace({ event: "resumed", state: context.state })
      })
      .catch((err: unknown) => {
        if (this.context === context) this.fail(err instanceof Error ? err.message : String(err))
      })
  }

  push(data: string, mime: string, request?: string) {
    this.request = request
    const bytes = decode(data)
    if (mime.startsWith("audio/pcm")) {
      this.pcm(bytes, Number(mime.match(/rate=(\d+)/)?.[1]) || 16_000, request)
      return
    }
    this.queue.push(bytes)
    if (!this.source) this.open(mime)
    this.flush()
  }

  finish() {
    this.ending = true
    this.drain()
    if (this.context && this.nodes.size === 0) {
      this.settle()
      return
    }
    this.flush()
  }

  elapsed() {
    if (!this.context || this.began === undefined) return 0
    return Math.max(0, this.context.currentTime - this.began)
  }

  stop(notify = true) {
    this.reset()
    this.closeBridge()
    this.output = undefined
    const context = this.context
    this.context = undefined
    if (context) {
      try {
        void context.close().catch((err: unknown) => this.fail(err instanceof Error ? err.message : String(err)))
      } catch (err) {
        this.fail(err instanceof Error ? err.message : String(err))
      }
    }
    if (notify) this.done()
  }

  // raya_change - preserve the user-gesture-unlocked AudioContext between streamed voice turns
  reset() {
    if (this.timer !== undefined) window.clearTimeout(this.timer)
    this.timer = undefined
    this.pending = []
    this.duration = 0
    this.bytes = 0
    this.clock = undefined
    this.budget = 0
    this.request = undefined
    this.ending = false
    for (const node of this.nodes) node.stop()
    this.nodes.clear()
    this.next = 0
    this.began = undefined
    this.audio?.pause()
    if (this.audio?.src) URL.revokeObjectURL(this.audio.src)
    this.audio = undefined
    this.source = undefined
    this.buffer = undefined
    this.queue = []
  }

  private pcm(bytes: Uint8Array, rate: number, request?: string) {
    this.unlock()
    const context = this.context
    if (!context) return
    const count = Math.floor(bytes.byteLength / 2)
    if (count === 0) return
    if (this.pending.length >= 64 || this.bytes + bytes.length > 67_108_864 || this.duration + count / rate > 180) {
      this.fail("Voice playback buffer exceeds its bound.")
      this.stop(false)
      return
    }
    this.clock ??= performance.now()
    const audio = context.createBuffer(1, count, rate)
    const channel = audio.getChannelData(0)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let peak = 0
    for (let index = 0; index < count; index++) {
      channel[index] = view.getInt16(index * 2, true) / 32_768
      peak = Math.max(peak, Math.abs(channel[index]))
    }
    this.trace({
      event: "pcm",
      request,
      bytes: bytes.length,
      count,
      rate,
      peak: Math.round(peak * 1000) / 1000,
      state: context.state,
    })
    this.pending.push(audio)
    this.duration += audio.duration
    this.bytes += bytes.length
    this.trace({ event: "buffered", request, count: this.pending.length, duration: Math.round(this.duration * 1000) })
    if (this.nodes.size > 0 || this.duration >= 2 || this.ending) {
      this.drain()
      return
    }
    // A bounded two-second reserve absorbs sentence-generation gaps. Completed
    // short replies bypass this wait; Stop retires both this timer and the PCM.
    this.timer ??= window.setTimeout(() => this.drain(), 2500)
  }

  private drain() {
    if (this.timer !== undefined) window.clearTimeout(this.timer)
    this.timer = undefined
    const pending = this.pending
    this.pending = []
    this.duration = 0
    this.bytes = 0
    for (const audio of pending) this.schedule(audio)
  }

  private schedule(audio: AudioBuffer) {
    const context = this.context
    if (!context) return
    const request = this.request
    const count = audio.length
    const node = context.createBufferSource()
    node.buffer = audio
    node.connect(this.output ?? context.destination)
    const start = Math.max(context.currentTime + 0.01, this.next)
    this.began ??= start
    this.next = start + audio.duration
    this.nodes.add(node)
    node.addEventListener(
      "ended",
      () => {
        if (this.context !== context || this.request !== request || !this.nodes.has(node)) return
        this.nodes.delete(node)
        this.trace({ event: "ended", request, state: context.state, count })
        if (this.nodes.size !== 0) return
        if (this.ending && this.pending.length === 0) {
          this.settle()
          return
        }
        this.trace({ event: "underrun", request, at: Math.round(context.currentTime * 1000) })
      },
      { once: true },
    )
    node.start(start)
    this.trace({
      event: "scheduled",
      request,
      state: context.state,
      count,
      at: Math.round(context.currentTime * 1000),
      start: Math.round(start * 1000),
      remaining: Math.max(0, Math.round((this.next - context.currentTime) * 1000)),
      duration: Math.round(audio.duration * 1000),
      output: this.bridge && this.output === this.bridge.sink ? "bridge" : "direct",
    })
  }

  // raya_change start - present local MiniMax PCM as remote WebRTC playout so Chromium AEC has a reference
  private async connect(context: AudioContext) {
    if (typeof RTCPeerConnection === "undefined" || typeof context.createMediaStreamDestination !== "function") return
    this.bridging = true
    const sink = context.createMediaStreamDestination()
    const send = new RTCPeerConnection()
    const receive = new RTCPeerConnection()
    const audio = new Audio()
    audio.autoplay = true
    const bridge = { sink, audio, send, receive }
    this.bridge = bridge
    receive.ontrack = (event) => {
      if (this.context !== context || this.bridge !== bridge) return
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track])
    }
    const track = sink.stream.getAudioTracks()[0]
    if (!track) {
      this.closeBridge()
      return
    }
    send.addTrack(track, sink.stream)
    const offer = await send.createOffer()
    await send.setLocalDescription(offer)
    await gathered(send)
    if (!send.localDescription) throw new Error("WebRTC echo sender did not produce a local description.")
    await receive.setRemoteDescription(send.localDescription)
    const answer = await receive.createAnswer()
    await receive.setLocalDescription(answer)
    await gathered(receive)
    if (!receive.localDescription) throw new Error("WebRTC echo receiver did not produce a local description.")
    await send.setRemoteDescription(receive.localDescription)
    await connected(send, receive)
    await audio.play()
    if (this.context !== context || this.bridge !== bridge) return
    this.output = sink
    this.trace({ event: "bridge-ready", state: context.state, output: "bridge" })
    this.bridging = false
  }

  private closeBridge() {
    const bridge = this.bridge
    this.bridge = undefined
    this.bridging = false
    bridge?.audio.pause()
    if (bridge?.audio.srcObject) bridge.audio.srcObject = null
    bridge?.send.close()
    bridge?.receive.close()
    bridge?.sink.disconnect()
  }
  // raya_change end

  private open(mime: string) {
    if (!MediaSource.isTypeSupported(mime)) {
      this.fail(`Streaming speech MIME type is unsupported: ${mime}`)
      return this.stop()
    }
    const source = new MediaSource()
    const audio = new Audio(URL.createObjectURL(source))
    this.source = source
    this.audio = audio
    source.addEventListener(
      "sourceopen",
      () => {
        const buffer = source.addSourceBuffer(mime)
        this.buffer = buffer
        buffer.addEventListener("updateend", () => this.flush())
        void audio.play().catch((err: unknown) => this.fail(err instanceof Error ? err.message : String(err)))
        this.flush()
      },
      { once: true },
    )
  }

  private flush() {
    const source = this.source
    const buffer = this.buffer
    if (!source || !buffer || buffer.updating) return
    const chunk = this.queue.shift()
    if (chunk) {
      const copy = new Uint8Array(chunk.byteLength)
      copy.set(chunk)
      buffer.appendBuffer(copy.buffer)
      return
    }
    if (!this.ending || source.readyState !== "open") return
    source.endOfStream()
    this.audio?.addEventListener("ended", () => this.settle(), { once: true })
  }

  // raya_change - completed turns keep the gesture-authorized sink alive for the next reply
  private settle() {
    this.reset()
    this.done()
  }
}

function decode(value: string) {
  const raw = atob(value)
  const bytes = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index)
  return bytes
}

function gathered(peer: RTCPeerConnection) {
  if (peer.iceGatheringState === "complete") return Promise.resolve()
  return new Promise<void>((resolve) => {
    const change = () => {
      if (peer.iceGatheringState !== "complete") return
      peer.removeEventListener("icegatheringstatechange", change)
      resolve()
    }
    peer.addEventListener("icegatheringstatechange", change)
  })
}

function connected(...peers: RTCPeerConnection[]) {
  if (peers.every((peer) => peer.connectionState === "connected")) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => finish(new Error("WebRTC echo reference connection timed out.")), 2_000)
    const change = () => {
      if (!peers.every((peer) => peer.connectionState === "connected")) return
      finish()
    }
    const finish = (error?: Error) => {
      window.clearTimeout(timer)
      for (const peer of peers) peer.removeEventListener("connectionstatechange", change)
      if (error) {
        reject(error)
        return
      }
      resolve()
    }
    for (const peer of peers) peer.addEventListener("connectionstatechange", change)
  })
}
